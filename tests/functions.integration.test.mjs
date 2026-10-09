// End-to-end test of the three Netlify functions as deployed: real
// @netlify/blobs package against Netlify's local Blobs server, real Request
// objects. Only Supabase and Resend are faked. Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BlobsServer } from "@netlify/blobs/server";

let server;
const sent = { emails: [], rows: [] };
const realFetch = globalThis.fetch;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blobs-"));
  server = new BlobsServer({ directory: dir, token: "tok", port: 0 });
  const { port } = await server.start();
  const url = `http://localhost:${port}`;
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ edgeURL: url, uncachedEdgeURL: url, token: "tok", siteID: "site-1" })).toString("base64");
  const env = { SUPABASE_URL: "https://sb.test", SUPABASE_PUBLISHABLE_KEY: "pk", RESEND_API_KEY: "rk" };
  globalThis.Netlify = { env: { get: (k) => env[k] ?? process.env[k], set: (k, v) => { process.env[k] = v; }, has: (k) => k in env || k in process.env, toObject: () => ({ ...process.env, ...env }) } };
  globalThis.fetch = async (u, init) => {
    const s = String(u);
    if (s.startsWith("https://sb.test/")) { sent.rows.push(JSON.parse(init.body)[0]); return new Response(null, { status: 201 }); }
    if (s === "https://api.resend.com/emails") { sent.emails.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
    return realFetch(u, init);
  };
});
after(async () => { globalThis.fetch = realFetch; await server.stop(); });

const intake = () => import("../netlify/functions/intake.mjs");
const upload = () => import("../netlify/functions/intake-upload.mjs");
const retry = () => import("../netlify/functions/intake-retry.mjs");

test("function routes and methods are as the website expects", async () => {
  const ic = (await intake()).config, uc = (await upload()).config;
  assert.equal(ic.path, "/api/intake"); assert.equal(ic.method, "POST");
  assert.equal(uc.path, "/api/intake-upload"); assert.equal(uc.method, "POST");
  assert.deepEqual(ic.rateLimit, { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 10 });
  assert.equal(uc.rateLimit.windowLimit, 30);
  assert.equal((await retry()).config.schedule, "*/5 * * * *");
  const hc = (await import("../netlify/functions/health.mjs")).config;
  assert.equal(hc.path, "/api/health"); assert.equal(hc.method, "GET"); assert.ok(hc.rateLimit);
  assert.equal((await import("../netlify/functions/system-check.mjs")).config.schedule, "7 * * * *");
});

test("plan review through the real functions: 3 parts uploaded, request sent, file attached intact and deleted", async () => {
  const bytes = crypto.randomBytes(4 * 1024 * 1024 + 777);
  const id = crypto.randomUUID();
  const parts = 3;
  for (let i = 0; i < parts; i++) {
    const chunk = bytes.subarray(i * 2 * 1024 * 1024, (i + 1) * 2 * 1024 * 1024);
    const res = await (await upload()).default(new Request(`https://plan-proof.com/api/intake-upload?id=${id}&part=${i}&parts=${parts}`, { method: "POST", body: chunk }));
    assert.equal(res.status, 200, await res.clone().text());
  }
  const before = sent.emails.length;
  const body = {
    submission_id: crypto.randomUUID(), form_name: "plan-review", honeypot: "", elapsed_ms: 60000,
    data: { organization: "TEST Company", email: "a@b.test", formatted_summary: "Plan review request" },
    file: { upload_id: id, name: "plan.pdf", type: "application/pdf", size: bytes.length, parts },
  };
  const res = await (await intake()).default(new Request("https://plan-proof.com/api/intake", { method: "POST", body: JSON.stringify(body) }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const email = sent.emails[before];
  assert.ok(Buffer.from(email.attachments[0].content, "base64").equals(bytes));
  // Parts deleted after the email went out: a retry run finds nothing to do.
  await (await retry()).default(new Request("https://x", { method: "POST", body: "{}" }));
  const { getStore } = await import("@netlify/blobs");
  assert.equal((await getStore({ name: "intake-uploads", consistency: "strong" }).list()).blobs.length, 0);
  assert.equal((await getStore({ name: "intake-pending", consistency: "strong" }).list()).blobs.filter((b) => b.key.startsWith("rec/")).length, 0);
});

test("oversized part is refused with 413; wrong method with 405; junk body with 400", async () => {
  const big = Buffer.alloc(2 * 1024 * 1024 + 1);
  let res = await (await upload()).default(new Request(`https://p/api/intake-upload?id=${crypto.randomUUID()}&part=0&parts=1`, { method: "POST", body: big }));
  assert.equal(res.status, 413);
  res = await (await intake()).default(new Request("https://p/api/intake", { method: "GET" }));
  assert.equal(res.status, 405);
  res = await (await intake()).default(new Request("https://p/api/intake", { method: "POST", body: "not json" }));
  assert.equal(res.status, 400);
});
