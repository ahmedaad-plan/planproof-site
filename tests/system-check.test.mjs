// Tests for the health check and the hourly alarm (netlify/lib/system-check.mjs).
// Supabase and Resend are faked; storage is an in-memory Blobs stand-in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkHealth, publicHealth, runSystemCheck, REALERT_AFTER_MS } from "../netlify/lib/system-check.mjs";

class MemStore {
  constructor() { this.m = new Map(); }
  async get(key, opts = {}) { if (!this.m.has(key)) return null; const v = this.m.get(key); return opts.type === "json" ? JSON.parse(v) : v; }
  async setJSON(key, obj) { this.m.set(key, JSON.stringify(obj)); }
  async delete(key) { this.m.delete(key); }
  async list() { return { blobs: [...this.m.keys()].map((key) => ({ key })) }; }
}

const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_PUBLISHABLE_KEY: "pk", RESEND_API_KEY: "rk" };
const quiet = { error() {}, log() {} };

// Fake world. db: "ok" | "down"; secretOk: what the database says about the header;
// resend: "ok" | "restricted" | "bad-key" | "down" | "unverified".
function world(over = {}) {
  const w = { db: "ok", resend: "ok", emails: [], dbHeaders: [], ...over };
  w.fetchFn = async (url, init = {}) => {
    if (url === "https://sb.test/rest/v1/rpc/intake_self_check") {
      if (w.db === "down") throw new Error("connect ETIMEDOUT");
      w.dbHeaders.push(init.headers["x-intake-secret"]);
      const ok = init.headers["x-intake-secret"] === "right";
      return Response.json(ok ? { db: true, secret_ok: true, lock: true } : { db: true, secret_ok: false });
    }
    if (url === "https://api.resend.com/domains") {
      if (w.resend === "down") throw new Error("fetch failed");
      if (w.resend === "bad-key") return new Response('{"name":"validation_error","message":"API key is invalid"}', { status: 401 });
      if (w.resend === "restricted") return new Response('{"name":"restricted_api_key","message":"This API key is restricted to only send emails"}', { status: 401 });
      return Response.json({ data: [{ name: "notify.plan-proof.com", status: w.resend === "unverified" ? "failed" : "verified" }] });
    }
    if (url === "https://api.resend.com/emails") { w.emails.push(JSON.parse(init.body)); return Response.json({ id: "e" }); }
    throw new Error("unexpected " + url);
  };
  return w;
}

async function freshStore(nowMs) {
  const s = new MemStore();
  await s.setJSON("meta/last-retry-run", { at: nowMs - 60 * 1000 });
  return s;
}

test("all healthy: ok, and the public answer shows status words only", async () => {
  const now = Date.now(); const w = world();
  const h = await checkHealth({ pending: await freshStore(now), fetchFn: w.fetchFn, env: ENV, nowMs: now });
  assert.equal(h.status, "ok");
  assert.deepEqual(h.checks, { database: "ok", email: "ok", requests: "ok", scheduler: "ok" });
  assert.deepEqual(Object.keys(publicHealth(h)).sort(), ["checked_at", "checks", "problems", "status"]);
});

test("each failure is reported with its own code", async () => {
  const now = Date.now();
  const cases = [
    [{ db: "down" }, ENV, "database_unreachable"],
    [{}, { ...ENV, INTAKE_DB_SECRET: "wrong" }, "db_secret_rejected"],
    [{ resend: "bad-key" }, ENV, "email_key_rejected"],
    [{ resend: "down" }, ENV, "email_unreachable"],
    [{ resend: "unverified" }, ENV, "email_domain_unverified"],
  ];
  for (const [over, env, code] of cases) {
    const h = await checkHealth({ pending: await freshStore(now), fetchFn: world(over).fetchFn, env, nowMs: now });
    assert.equal(h.status, "problem", code);
    assert.deepEqual(h.problems, [code]);
  }
});

test("a sending-only Resend key counts as working; the right database secret is accepted", async () => {
  const now = Date.now(); const w = world({ resend: "restricted" });
  const h = await checkHealth({ pending: await freshStore(now), fetchFn: w.fetchFn, env: { ...ENV, INTAKE_DB_SECRET: "right" }, nowMs: now });
  assert.equal(h.status, "ok");
  assert.equal(h.internal.dbSecret, "accepted");
  assert.equal(h.internal.dbLock, "on");
  assert.deepEqual(w.dbHeaders, ["right"]);
});

test("a request waiting over 30 minutes, or a stalled retry job, raises a problem", async () => {
  const now = Date.now();
  const s = await freshStore(now);
  await s.setJSON("rec/abc", { id: "abc", receivedAt: new Date(now - 31 * 60 * 1000).toISOString() });
  let h = await checkHealth({ pending: s, fetchFn: world().fetchFn, env: ENV, nowMs: now });
  assert.deepEqual(h.problems, ["requests_delayed"]);
  assert.equal(h.internal.waiting, 1);
  const s2 = new MemStore();
  await s2.setJSON("meta/last-retry-run", { at: now - 25 * 60 * 1000 });
  h = await checkHealth({ pending: s2, fetchFn: world().fetchFn, env: ENV, nowMs: now });
  assert.deepEqual(h.problems, ["retry_job_not_running"]);
  h = await checkHealth({ pending: new MemStore(), fetchFn: world().fetchFn, env: ENV, nowMs: now });
  assert.equal(h.checks.scheduler, "unknown", "a brand-new deploy is not an alarm");
  assert.equal(h.status, "ok");
});

test("the alarm: sent once, repeated after 6 hours, 'resolved' when it clears; extra address included", async () => {
  const t = Date.UTC(2026, 9, 9, 10, 7); // a Friday, 10:07 UTC (no digest, no heartbeat)
  const s = await freshStore(t);
  const w = world({ db: "down" });
  const env = { ...ENV, ALERT_EMAIL: "someone@gmail.example, not-an-email" };
  await s.setJSON("meta/alert-state", { recipients: "exercises@plan-proof.com,someone@gmail.example" }); // already confirmed
  let r = await runSystemCheck({ pending: s, fetchFn: w.fetchFn, env, nowMs: t, log: quiet });
  assert.deepEqual(r.sent, ["alert"]);
  assert.deepEqual(w.emails[0].to, ["exercises@plan-proof.com", "someone@gmail.example"]);
  assert.match(w.emails[0].text, /database \(Supabase\) is not answering/);
  await s.setJSON("meta/last-retry-run", { at: t + 3600e3 });
  r = await runSystemCheck({ pending: s, fetchFn: w.fetchFn, env, nowMs: t + 3600e3, log: quiet });
  assert.deepEqual(r.sent, [], "no repeat within 6 hours");
  await s.setJSON("meta/last-retry-run", { at: t + REALERT_AFTER_MS + 3600e3 });
  r = await runSystemCheck({ pending: s, fetchFn: w.fetchFn, env, nowMs: t + REALERT_AFTER_MS + 3600e3, log: quiet });
  assert.deepEqual(r.sent, ["alert"], "repeated after 6 hours");
  w.db = "ok";
  const t2 = t + REALERT_AFTER_MS + 2 * 3600e3;
  await s.setJSON("meta/last-retry-run", { at: t2 });
  r = await runSystemCheck({ pending: s, fetchFn: w.fetchFn, env, nowMs: t2, log: quiet });
  assert.deepEqual(r.sent, ["resolved"]);
  await s.setJSON("meta/last-retry-run", { at: t2 + 3600e3 });
  r = await runSystemCheck({ pending: s, fetchFn: w.fetchFn, env, nowMs: t2 + 3600e3, log: quiet });
  assert.deepEqual(r.sent, [], "quiet when healthy");
});

test("a different problem alerts at once, even within 6 hours", async () => {
  const t = Date.UTC(2026, 9, 9, 10, 7);
  const s = await freshStore(t); const w = world({ db: "down" });
  await runSystemCheck({ pending: s, fetchFn: w.fetchFn, env: ENV, nowMs: t, log: quiet });
  w.db = "ok"; w.resend = "bad-key";
  const r = await runSystemCheck({ pending: s, fetchFn: w.fetchFn, env: ENV, nowMs: t + 60e3, log: quiet });
  assert.deepEqual(r.sent, ["alert"]);
});

test("daily digest of unemailed possible-spam at 08:xx UAE, once; Monday heartbeat", async () => {
  const mon = Date.UTC(2026, 9, 12, 4, 7); // Monday 04:07 UTC = 08:07 UAE
  const s = await freshStore(mon);
  await s.setJSON("meta/alert-state", { recipients: "exercises@plan-proof.com" }); // already confirmed
  await s.setJSON("stats/2026-10-11", { received: 2, receivedSpam: 9, spamEmailed: 5, spamSuppressed: 4 });
  await s.setJSON("stats/2026-10-08", { received: 1 });
  const w = world();
  const r = await runSystemCheck({ pending: s, fetchFn: w.fetchFn, env: ENV, nowMs: mon, log: quiet });
  assert.deepEqual(r.sent, ["digest", "heartbeat"]);
  assert.match(w.emails[0].subject, /4 possible-spam/);
  assert.match(w.emails[1].subject, /all clear/);
  assert.match(w.emails[1].text, /last 7 days: 3 \(plus 9 labelled possible spam\)/);
  await s.setJSON("meta/last-retry-run", { at: mon + 29 * 60e3 });
  const again = await runSystemCheck({ pending: s, fetchFn: w.fetchFn, env: ENV, nowMs: mon + 30 * 60e3, log: quiet });
  assert.deepEqual(again.sent, [], "only once a day");
});

test("a changed recipient list gets one confirmation email, then nothing until it changes again", async () => {
  const t = Date.UTC(2026, 9, 10, 5, 7); // Saturday 05:07 UTC: no digest, no heartbeat
  const s = await freshStore(t); const w = world();
  let r = await runSystemCheck({ pending: s, fetchFn: w.fetchFn, env: { ...ENV, ALERT_EMAIL: "me@hotmail.example" }, nowMs: t, log: quiet });
  assert.deepEqual(r.sent, ["recipients"]);
  assert.deepEqual(w.emails[0].to, ["exercises@plan-proof.com", "me@hotmail.example"]);
  assert.match(w.emails[0].text, /me@hotmail\.example/);
  await s.setJSON("meta/last-retry-run", { at: t + 3600e3 });
  r = await runSystemCheck({ pending: s, fetchFn: w.fetchFn, env: { ...ENV, ALERT_EMAIL: "me@hotmail.example" }, nowMs: t + 3600e3, log: quiet });
  assert.deepEqual(r.sent, []);
  await s.setJSON("meta/last-retry-run", { at: t + 7200e3 });
  r = await runSystemCheck({ pending: s, fetchFn: w.fetchFn, env: { ...ENV, ALERT_EMAIL: "other@hotmail.example" }, nowMs: t + 7200e3, log: quiet });
  assert.deepEqual(r.sent, ["recipients"]);
});
