// Tests for the website intake (netlify/lib/intake-core.mjs). Run: npm test
// Supabase and Resend are replaced by fakes; storage by an in-memory store
// with the same methods as a Netlify Blobs store.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  buildRecord, handleIntake, retryPending, checkUploadParams, IntakeError, CHUNK_BYTES, ORPHAN_UPLOAD_MS,
} from "../netlify/lib/intake-core.mjs";

class MemStore {
  constructor() { this.m = new Map(); }
  async get(key, opts = {}) {
    if (!this.m.has(key)) return null;
    const { data } = this.m.get(key);
    if (opts.type === "json") return JSON.parse(data);
    if (opts.type === "arrayBuffer") { const b = Buffer.from(data); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); }
    return typeof data === "string" ? data : Buffer.from(data).toString();
  }
  async set(key, data, opts = {}) { this.m.set(key, { data: Buffer.from(data), metadata: opts.metadata || {} }); }
  async setJSON(key, obj) { this.m.set(key, { data: JSON.stringify(obj), metadata: {} }); }
  async delete(key) { this.m.delete(key); }
  async list() { return { blobs: [...this.m.keys()].map((key) => ({ key, etag: "x" })), directories: [] }; }
  async getMetadata(key) { return this.m.has(key) ? { etag: "x", metadata: this.m.get(key).metadata } : null; }
}
class BrokenStore extends MemStore {
  async get() { throw new Error("storage down"); }
  async setJSON() { throw new Error("storage down"); }
  async set() { throw new Error("storage down"); }
}

// Fake Supabase + Resend. `mode` lets a test make either fail.
function fakeNet() {
  const net = { supabaseMode: "ok", resendMode: "ok", inserts: { clients: [], submissions: [] }, emails: [], ids: new Set() };
  net.fetchFn = async (url, init) => {
    if (url.startsWith("https://sb.test/rest/v1/")) {
      const table = url.split("/").pop();
      if (net.supabaseMode === "down") throw new Error("connect ETIMEDOUT");
      if (net.supabaseMode === "500") return new Response("boom", { status: 500 });
      const rows = JSON.parse(init.body);
      for (const r of rows) {
        const k = `${table}:${r.id}`;
        if (net.ids.has(k)) return new Response('{"code":"23505"}', { status: 409 });
        net.ids.add(k);
        net.inserts[table].push(r);
      }
      return new Response(null, { status: 201 });
    }
    if (url === "https://api.resend.com/emails") {
      if (net.resendMode === "down") throw new Error("fetch failed");
      if (net.resendMode === "500") return new Response("server error", { status: 500 });
      const body = JSON.parse(init.body);
      if (net.resendMode === "domain-unverified" && body.from.includes("plan-proof.com")) return new Response("domain not verified", { status: 403 });
      net.emails.push(body);
      return new Response('{"id":"e1"}', { status: 200 });
    }
    throw new Error("unexpected fetch " + url);
  };
  return net;
}
const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_PUBLISHABLE_KEY: "pk", RESEND_API_KEY: "rk", RESEND_FROM_ADDRESS: "" };
const quiet = { error() {}, log() {} };
function deps(net, extra = {}) {
  return { pending: new MemStore(), uploads: new MemStore(), fetchFn: net.fetchFn, env: ENV, log: quiet, ...extra };
}
function genericBody(over = {}) {
  return {
    submission_id: crypto.randomUUID(),
    form_name: "generic-scenario",
    data: {
      organization: "TEST Company", name: "Test Person", email: "test@example.com", mobile: "0501234567",
      industry: "Healthcare", size: "50-300", location: "Abu Dhabi", risk: "Fire (main), Flood",
      operations: "Clinics depend on the EMR system", used_before: "no", audience: ["Operations", "IT & Technology"],
      formatted_summary: "Generic scenario request\n\nOrganization: TEST Company",
    },
    honeypot: "",
    elapsed_ms: 95000,
    file: null,
    file_upload_failed: null,
    ...over,
  };
}
const attachmentNames = (email) => email.attachments.map((a) => a.filename);

test("a normal request is saved to Supabase, emailed, and then removed from storage", async () => {
  const net = fakeNet(); const d = deps(net);
  const body = genericBody();
  const r = await handleIntake(body, d);
  assert.equal(r.ok, true);
  assert.equal(net.inserts.clients.length, 1);
  assert.equal(net.inserts.submissions.length, 1);
  const sub = net.inserts.submissions[0];
  assert.equal(sub.id, body.submission_id);
  assert.equal(sub.client_id, net.inserts.clients[0].id);
  assert.equal(sub.risk_concern_1, "Fire");
  assert.equal(sub.risk_concern_2, "Flood");
  assert.ok(!sub.notes.includes("POSSIBLE SPAM"));
  assert.equal(net.emails.length, 1);
  assert.match(net.emails[0].subject, /^New generic-scenario submission — TEST Company \(exercised before: No\)$/);
  assert.deepEqual(net.emails[0].to, ["exercises@plan-proof.com"]);
  assert.equal(net.emails[0].from, "PlanProof <alerts@notify.plan-proof.com>");
  assert.equal(await d.pending.get(`rec/${body.submission_id}`), null, "finished requests are not kept");
  assert.ok(await d.pending.get(`done/${body.submission_id}`), "a done marker stops duplicates");
});

test("checkbox groups (several values) are joined, not lost", async () => {
  const net = fakeNet(); const d = deps(net);
  const rec = buildRecord(genericBody());
  assert.deepEqual(rec.data.audience, ["Operations", "IT & Technology"]);
});

test("the old spam case: an obviously fake TEST request is still delivered", async () => {
  const net = fakeNet(); const d = deps(net);
  const r = await handleIntake(genericBody(), d);
  assert.equal(r.ok, true);
  assert.equal(net.emails.length, 1);
});

test("a request that looks automated is delivered with a Possible spam label, never dropped", async () => {
  for (const over of [{ honeypot: "http://spam.example" }, { elapsed_ms: 800 }, { elapsed_ms: undefined }]) {
    const net = fakeNet(); const d = deps(net);
    const r = await handleIntake(genericBody(over), d);
    assert.equal(r.ok, true);
    assert.equal(net.emails.length, 1);
    assert.match(net.emails[0].subject, /^⚠ Possible spam — New generic-scenario/);
    assert.match(net.emails[0].text, /POSSIBLE SPAM/);
    assert.match(net.inserts.submissions[0].notes, /^POSSIBLE SPAM \(/);
  }
});

test("email down: the request is kept, the visitor still sees success, and the retry delivers it later", async () => {
  const net = fakeNet(); net.resendMode = "down";
  const d = deps(net);
  const body = genericBody();
  const r = await handleIntake(body, d);
  assert.equal(r.ok, true);
  assert.equal(net.inserts.submissions.length, 1, "admin page already has it");
  assert.equal(net.emails.length, 0);
  const kept = await d.pending.get(`rec/${body.submission_id}`, { type: "json" });
  assert.equal(kept.steps.supabase, true);
  assert.equal(kept.steps.email, false);

  net.resendMode = "ok";
  const s = await retryPending(d);
  assert.equal(s.finished, 1);
  assert.equal(net.emails.length, 1);
  assert.match(net.emails[0].subject, /\[delayed delivery\]$/);
  assert.equal(net.inserts.submissions.length, 1, "no duplicate row on retry");
  assert.equal(await d.pending.get(`rec/${body.submission_id}`), null);
});

test("Supabase down: still emailed now, saved to Supabase by the retry", async () => {
  const net = fakeNet(); net.supabaseMode = "down";
  const d = deps(net);
  const r = await handleIntake(genericBody(), d);
  assert.equal(r.ok, true);
  assert.equal(net.emails.length, 1);
  assert.equal(net.inserts.submissions.length, 0);
  net.supabaseMode = "ok";
  const s = await retryPending(d);
  assert.equal(s.finished, 1);
  assert.equal(net.inserts.submissions.length, 1);
  assert.equal(net.emails.length, 1, "no second email");
});

test("a half-finished Supabase save (client row in, request row failed) completes without duplicates", async () => {
  const net = fakeNet(); const d = deps(net);
  const body = genericBody();
  const rec = buildRecord(body);
  // Simulate: client row already inserted by an earlier attempt.
  net.ids.add(`clients:${rec.clientId}`);
  await d.pending.setJSON(`rec/${rec.id}`, rec);
  await retryPending(d);
  assert.equal(net.inserts.clients.length, 0, "existing client row treated as done (409)");
  assert.equal(net.inserts.submissions.length, 1);
});

test("unverified sending domain falls back to Resend's shared sender", async () => {
  const net = fakeNet(); net.resendMode = "domain-unverified";
  const d = deps(net);
  await handleIntake(genericBody(), d);
  assert.equal(net.emails.length, 1);
  assert.equal(net.emails[0].from, "onboarding@resend.dev");
});

test("everything down: the visitor is told it failed (and gets the email fallback)", async () => {
  const net = fakeNet(); net.resendMode = "down"; net.supabaseMode = "down";
  const d = deps(net, { pending: new BrokenStore() });
  const r = await handleIntake(genericBody(), d);
  assert.equal(r.ok, false);
});

test("storage down but Supabase and email fine: still a success", async () => {
  const net = fakeNet();
  const d = deps(net, { pending: new BrokenStore() });
  const r = await handleIntake(genericBody(), d);
  assert.equal(r.ok, true);
  assert.equal(net.emails.length, 1);
});

test("a browser retry of the same request does not send a second email", async () => {
  const net = fakeNet(); const d = deps(net);
  const body = genericBody();
  await handleIntake(body, d);
  const again = await handleIntake(body, d);
  assert.equal(again.ok, true);
  assert.equal(net.emails.length, 1);
  assert.equal(net.inserts.submissions.length, 1);
});

async function putFile(uploads, bytes) {
  const uploadId = crypto.randomUUID();
  const parts = Math.ceil(bytes.length / CHUNK_BYTES);
  for (let i = 0; i < parts; i++) {
    await uploads.set(`${uploadId}/${i}`, bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES), { metadata: { uploadedAt: Date.now(), parts } });
  }
  return { upload_id: uploadId, name: "Our BCP v3.pdf", type: "application/pdf", size: bytes.length, parts };
}

test("plan review: a 5 MB plan in 3 parts arrives intact as an attachment, then is deleted", async () => {
  const net = fakeNet(); const d = deps(net);
  const bytes = crypto.randomBytes(5 * 1024 * 1024 + 123);
  const file = await putFile(d.uploads, bytes);
  assert.equal(file.parts, 3);
  const body = genericBody({ form_name: "plan-review", file });
  const r = await handleIntake(body, d);
  assert.equal(r.ok, true);
  const email = net.emails[0];
  assert.deepEqual(attachmentNames(email), ["Our BCP v3.pdf", "plan-review-submission.txt"]);
  assert.ok(Buffer.from(email.attachments[0].content, "base64").equals(bytes), "file is byte-for-byte identical");
  assert.match(net.inserts.submissions[0].notes, /Plan document: Our BCP v3\.pdf — sent to the inbox/);
  assert.equal((await d.uploads.list()).blobs.length, 0, "plan deleted after the email was sent");
});

test("plan review: a part not yet visible is waited for, and after an hour the request is sent without it", async () => {
  const net = fakeNet(); const d = deps(net);
  const bytes = crypto.randomBytes(3 * 1024 * 1024);
  const file = await putFile(d.uploads, bytes);
  await d.uploads.delete(`${file.upload_id}/1`);
  const body = genericBody({ form_name: "plan-review", file });
  const r = await handleIntake(body, d);
  assert.equal(r.ok, true);
  assert.equal(net.emails.length, 0, "first try waits for the file");
  assert.equal(net.inserts.submissions.length, 1, "but the admin page already has the request");
  const later = Date.now() + 61 * 60 * 1000;
  await retryPending({ ...d, nowMs: later });
  assert.equal(net.emails.length, 1);
  assert.match(net.emails[0].text, /could not be found in temporary storage\. Ask the client to email it\./);
});

test("plan review: if the file failed to upload, the request still arrives with a note", async () => {
  const net = fakeNet(); const d = deps(net);
  const r = await handleIntake(genericBody({ form_name: "plan-review", file_upload_failed: { name: "plan.pdf", size: 7000000 } }), d);
  assert.equal(r.ok, true);
  assert.match(net.emails[0].text, /did not upload from the client's browser/);
  assert.match(net.inserts.submissions[0].notes, /did NOT upload\. Ask the client to email it\./);
});

test("abandoned uploads are deleted after a day; uploads of waiting requests are kept", async () => {
  const net = fakeNet(); net.resendMode = "down";
  const d = deps(net);
  await putFile(d.uploads, crypto.randomBytes(1000)); // orphan
  const keptFile = await putFile(d.uploads, crypto.randomBytes(1000));
  await handleIntake(genericBody({ form_name: "plan-review", file: keptFile }), d);
  const s = await retryPending({ ...d, nowMs: Date.now() + ORPHAN_UPLOAD_MS + 60000 });
  assert.equal(s.uploadsDeleted, 1);
  const left = (await d.uploads.list()).blobs.map((b) => b.key);
  assert.deepEqual(left, [`${keptFile.upload_id}/0`]);
});

test("all four forms are accepted; anything else is refused", async () => {
  for (const form_name of ["contact-request", "demo-walkthrough", "generic-scenario", "plan-review"]) {
    const net = fakeNet(); const d = deps(net);
    assert.equal((await handleIntake(genericBody({ form_name }), d)).ok, true);
    assert.match(net.emails[0].subject, new RegExp(`New ${form_name} submission`));
  }
  await assert.rejects(handleIntake(genericBody({ form_name: "evil" }), deps(fakeNet())), (e) => e instanceof IntakeError && e.status === 400);
});

test("bad file details are refused", async () => {
  const net = fakeNet();
  const bad = [
    { upload_id: "not-a-uuid", name: "a.pdf", size: 10, parts: 1 },
    { upload_id: crypto.randomUUID(), name: "a.pdf", size: 9 * 1024 * 1024, parts: 5 },
    { upload_id: crypto.randomUUID(), name: "a.pdf", size: 3 * 1024 * 1024, parts: 1 },
  ];
  for (const file of bad) await assert.rejects(handleIntake(genericBody({ file }), deps(net)), IntakeError);
});

test("file names are made safe", () => {
  const rec = buildRecord(genericBody({ file: { upload_id: crypto.randomUUID(), name: "../../etc/<x>.pdf", size: 10, parts: 1 } }));
  assert.equal(rec.file.name, "_x_.pdf");
});

test("upload part checks", () => {
  const id = crypto.randomUUID();
  const p = (q) => new URLSearchParams(q);
  assert.deepEqual(checkUploadParams(p(`id=${id}&part=0&parts=4`), 100), { key: `${id}/0`, parts: 4 });
  assert.throws(() => checkUploadParams(p(`id=${id}&part=4&parts=4`), 100), IntakeError);
  assert.throws(() => checkUploadParams(p(`id=${id}&part=0&parts=5`), 100), IntakeError);
  assert.throws(() => checkUploadParams(p(`id=x&part=0&parts=1`), 100), IntakeError);
  assert.throws(() => checkUploadParams(p(`id=${id}&part=0&parts=1`), 0), IntakeError);
  assert.throws(() => checkUploadParams(p(`id=${id}&part=0&parts=1`), CHUNK_BYTES + 1), (e) => e.status === 413);
});

test("requests stuck for 7 days stop retrying (and are logged)", async () => {
  const net = fakeNet(); net.resendMode = "down"; net.supabaseMode = "down";
  const d = deps(net);
  await handleIntake(genericBody(), d);
  const s = await retryPending({ ...d, nowMs: Date.now() + 8 * 24 * 60 * 60 * 1000 });
  assert.equal(s.gaveUp, 1);
  assert.equal(s.retried, 0);
});
