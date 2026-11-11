// W8 — the client emails (netlify/lib/send-email.mjs). Supabase and Resend are faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendClientEmail, pollForPage, pollForSystemCheck, buildBody, mapEvent, LINK_MARKER, FROM_CANDIDATES, SendError } from "../netlify/lib/send-email.mjs";
import { runSystemCheck } from "../netlify/lib/system-check.mjs";

const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_PUBLISHABLE_KEY: "pk", RESEND_API_KEY: "rk" };
const SUB = "11111111-1111-4111-8111-111111111111", VER = "22222222-2222-4222-8222-222222222222";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdE";

function world(over = {}) {
  const w = { calls: [], emails: [], statusWrites: [], recordFails: 0, refuseDomain: false, resendDown: false, events: {}, ...over };
  w.fetchFn = async (url, init = {}) => {
    w.calls.push(url);
    if (url.startsWith("https://sb.test/rest/v1/rpc/")) {
      const name = url.split("/").pop(); const args = JSON.parse(init.body || "{}");
      if (init.headers.Authorization !== "Bearer user-token" && init.headers.apikey !== "sk") return new Response('{"message":"Not authorised"}', { status: 401 });
      if (name === "admin_record_email") {
        if (args.p_to === "bad") return new Response('{"message":"Check the email address: bad"}', { status: 400 });
        w.recorded = args; return Response.json({ email_id: "e1", request_no: "R-2026-0099", version_no: 3, token: TOKEN, link_id: "l1", expires_at: "2026-11-25T10:00:00Z" });
      }
      if (name === "admin_email_status" || name === "service_email_status") {
        if (w.recordFails-- > 0) return new Response("boom", { status: 500 });
        w.statusWrites.push(args); return Response.json({ status: args.p_status });
      }
      if (name === "admin_emails_to_poll" || name === "service_emails_to_poll") return Response.json(w.pollRows || []);
      throw new Error("unexpected rpc " + name);
    }
    if (url === "https://api.resend.com/emails") {
      if (w.resendDown) throw new Error("fetch failed");
      const b = JSON.parse(init.body);
      if (w.refuseDomain && b.from.includes("@plan-proof.com")) return new Response('{"name":"validation_error","message":"The plan-proof.com domain is not verified"}', { status: 403 });
      w.emails.push(b); return Response.json({ id: "re_" + w.emails.length });
    }
    if (url.startsWith("https://api.resend.com/emails/")) { const id = url.split("/").pop(); return Response.json({ id, last_event: w.events[id] || "sent" }); }
    throw new Error("unexpected " + url);
  };
  return w;
}
const deps = (w, extra = {}) => ({ fetchFn: w.fetchFn, env: ENV, origin: "https://plan-proof.com", sleep: async () => {}, ...extra });
const body = (over = {}) => ({ action: "send", kind: "review", submission_id: SUB, version_id: VER, to: "dana@example.test", subject: "PlanProof — exercise scenario v3 for your review (R-2026-0099)",
  message: "Dear Dana,\n\nVersion 3 is ready.\n\nOpen the scenario: " + LINK_MARKER + "\n\nKind regards,\nAhmed", ...over });

test("send: logs first, sends from exercises@plan-proof.com with Reply-To, records 'sent' with the Resend id", async () => {
  const w = world();
  const out = await sendClientEmail(deps(w), "user-token", body());
  assert.equal(out.ok, true); assert.equal(out.status, "sent"); assert.equal(out.recorded, true);
  assert.ok(w.calls.indexOf("https://sb.test/rest/v1/rpc/admin_record_email") < w.calls.indexOf("https://api.resend.com/emails"), "logged before sending");
  assert.equal(w.emails[0].from, FROM_CANDIDATES[0]); assert.equal(w.emails[0].reply_to, "exercises@plan-proof.com");
  assert.deepEqual(w.emails[0].to, ["dana@example.test"]);
  assert.ok(w.emails[0].text.includes("https://plan-proof.com/c/" + TOKEN + " (valid until 25 November 2026)"));
  assert.ok(!w.emails[0].text.includes(LINK_MARKER));
  assert.ok(w.emails[0].html.includes('<a href="https://plan-proof.com/c/' + TOKEN + '">'));
  assert.deepEqual([w.statusWrites[0].p_status, w.statusWrites[0].p_resend_id], ["sent", "re_1"]);
  assert.equal(w.recorded.p_version, VER);
});

test("send: when Resend refuses plan-proof.com, the verified notify domain is used (Reply-To stays)", async () => {
  const w = world({ refuseDomain: true });
  const out = await sendClientEmail(deps(w), "user-token", body());
  assert.equal(out.ok, true); assert.equal(out.from, FROM_CANDIDATES[1]); assert.equal(w.emails[0].reply_to, "exercises@plan-proof.com");
  assert.equal(w.statusWrites[0].p_from, FROM_CANDIDATES[1]);
});

test("send: Resend unreachable → 'failed' is recorded with the reason; nothing is frozen", async () => {
  const w = world({ resendDown: true });
  const out = await sendClientEmail(deps(w), "user-token", body());
  assert.equal(out.ok, false); assert.equal(out.status, "failed"); assert.match(out.error, /did not accept/);
  assert.equal(w.statusWrites[0].p_status, "failed"); assert.match(w.statusWrites[0].p_error, /fetch failed/);
});

test("send: the result write is retried; if it never lands the page is told (the poll repairs it)", async () => {
  const w1 = world({ recordFails: 2 });
  assert.equal((await sendClientEmail(deps(w1), "user-token", body())).recorded, true);
  const w2 = world({ recordFails: 5 });
  const out = await sendClientEmail(deps(w2), "user-token", body());
  assert.equal(out.ok, true); assert.equal(out.recorded, false); assert.ok(out.record_error);
});

test("send: refused without a sign-in, a kind, a request, a subject or a message — and the database's own refusals come back", async () => {
  const w = world();
  await assert.rejects(sendClientEmail(deps(w), "", body()), (e) => e instanceof SendError && e.status === 401);
  await assert.rejects(sendClientEmail(deps(w), "user-token", body({ kind: "other" })), /Unknown kind/);
  await assert.rejects(sendClientEmail(deps(w), "user-token", body({ submission_id: "x" })), /Which request/);
  await assert.rejects(sendClientEmail(deps(w), "user-token", body({ version_id: null })), /Which version/);
  await assert.rejects(sendClientEmail(deps(w), "user-token", body({ subject: " " })), /subject/);
  await assert.rejects(sendClientEmail(deps(w), "user-token", body({ message: "" })), /message/);
  await assert.rejects(sendClientEmail(deps(w), "user-token", body({ to: "bad" })), /Check the email address/);
  await assert.rejects(sendClientEmail(deps(w), "other-token", body()), (e) => e.status === 401);
  assert.equal(w.emails.length, 0, "nothing was sent");
});

test("the link goes where the marker is, or after the first paragraph if the marker was deleted", () => {
  const a = buildBody("Hello\n\nSee: " + LINK_MARKER + "\n\nBye", "https://x/c/T", "2026-11-25T10:00:00Z");
  assert.equal(a.text, "Hello\n\nSee: https://x/c/T (valid until 25 November 2026)\n\nBye");
  const b = buildBody("Hello\n\nBye", "https://x/c/T", null);
  assert.equal(b.text, "Hello\n\nOpen it here: https://x/c/T\n\nBye");
  assert.ok(!buildBody("<b>x</b>", null).html.includes("<b>"), "escaped");
});

test("delivery status: Resend's events map to our words", () => {
  assert.deepEqual(["delivered", "opened", "bounced", "complained", "delivery_delayed", "sent", "queued", "zzz"].map(mapEvent),
    ["delivered", "delivered", "bounced", "complained", "delayed", "sent", "sent", null]);
});

test("poll (page): asks Resend, writes changes only, marks a lost 'sending' as unknown after 10 minutes", async () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const w = world({ events: { re_a: "delivered", re_b: "sent" }, pollRows: [
    { id: "a", resend_id: "re_a", status: "sent", created_at: "2026-11-11T11:00:00Z" },
    { id: "b", resend_id: "re_b", status: "sent", created_at: "2026-11-11T11:55:00Z" },
    { id: "c", resend_id: null, status: "sending", created_at: "2026-11-11T11:40:00Z" },
    { id: "d", resend_id: null, status: "sending", created_at: "2026-11-11T11:58:00Z" }] });
  const out = await pollForPage(deps(w, { nowMs: now }), "user-token", { submission_id: SUB });
  assert.deepEqual(out.rows.map((r) => r.status), ["delivered", "sent", "unknown", "sending"]);
  assert.deepEqual(w.statusWrites.map((s) => [s.p_email, s.p_status]), [["a", "delivered"], ["c", "unknown"]]);
});

test("poll (hourly): problems = bounced, or not delivered an hour after sending; skipped without the secret key", async () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  assert.equal((await pollForSystemCheck(deps(world(), { nowMs: now }))).skipped, true);
  const w = world({ events: { re_a: "bounced", re_b: "sent", re_c: "sent" }, pollRows: [
    { id: "a", resend_id: "re_a", status: "sent", created_at: "2026-11-11T11:50:00Z", request_no: "R-1", to: "x@y.z", kind: "review" },
    { id: "b", resend_id: "re_b", status: "sent", created_at: "2026-11-11T10:30:00Z", request_no: "R-2", to: "x@y.z", kind: "review" },
    { id: "c", resend_id: "re_c", status: "sent", created_at: "2026-11-11T11:30:00Z", request_no: "R-3", to: "x@y.z", kind: "review" }] });
  const out = await pollForSystemCheck(deps(w, { nowMs: now, env: { ...ENV, SUPABASE_SECRET_KEY: "sk" } }));
  assert.deepEqual(out.problems.map((p) => p.id).sort(), ["a", "b"]);
});

test("the hourly system check emails ONE alert per undelivered client email", async () => {
  class Mem { constructor() { this.m = new Map(); } async get(k, o = {}) { const v = this.m.get(k); return v == null ? null : o.type === "json" ? JSON.parse(v) : v; } async setJSON(k, v) { this.m.set(k, JSON.stringify(v)); } async delete(k) { this.m.delete(k); } async list() { return { blobs: [...this.m.keys()].map((key) => ({ key })) }; } }
  const now = Date.parse("2026-11-11T12:07:00Z");
  const pending = new Mem(); await pending.setJSON("meta/last-retry-run", { at: now - 60000 }); await pending.setJSON("meta/alert-state", { recipients: "exercises@plan-proof.com" });
  const w = world({ events: { re_b: "bounced" }, pollRows: [{ id: "b", resend_id: "re_b", status: "sent", created_at: "2026-11-11T11:30:00Z", request_no: "R-2026-0099", to: "dana@example.test", kind: "review" }] });
  const base = w.fetchFn;
  w.fetchFn = async (url, init) => {
    if (url === "https://sb.test/rest/v1/rpc/intake_self_check") return Response.json({ db: true, secret_ok: true, lock: true });
    if (url === "https://api.resend.com/domains") return Response.json({ data: [{ name: "notify.plan-proof.com", status: "verified" }] });
    return base(url, init);
  };
  const d = { pending, fetchFn: w.fetchFn, env: { ...ENV, SUPABASE_SECRET_KEY: "sk" }, nowMs: now, log: { error() {} } };
  const first = await runSystemCheck(d);
  assert.ok(first.sent.includes("client-email"));
  const alert = w.emails.find((e) => /not delivered/.test(e.subject));
  assert.match(alert.text, /R-2026-0099 — review to dana@example.test: bounced/);
  const second = await runSystemCheck({ ...d, nowMs: now + 3600000 });
  assert.ok(!second.sent.includes("client-email"), "not repeated");
});
