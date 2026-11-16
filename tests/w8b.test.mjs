// W8 build 2 (15 November 2026): the confirmation and invitation emails with their
// calendar file (.ics, Asia/Dubai), the push alerts (lib/alerts.mjs) and the admin
// app's service worker. Supabase, Resend and the push service are faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sendClientEmail, buildIcs, SendError } from "../netlify/lib/send-email.mjs";
import { deliverAlerts, payloadFor, emailFor, raiseAndDeliver } from "../netlify/lib/alerts.mjs";

const SUB = "11111111-1111-4111-8111-111111111111", SES = "33333333-3333-4333-8333-333333333333";
const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_PUBLISHABLE_KEY: "pk", RESEND_API_KEY: "rk", INTAKE_DB_SECRET: "isec", VAPID_PUBLIC_KEY: "BPub", VAPID_PRIVATE_KEY: "priv" };
const FACTS = { session_id: SES, date: "2026-12-09", time: "10:00", venue: "Tower 1, 4th-floor boardroom", minutes: 90, label: "Renewal Season", organisation: "TEST – Sareef", request_no: "R-2026-0099" };

function mailWorld() {
  const w = { emails: [], recorded: null };
  w.fetchFn = async (url, init = {}) => {
    if (url.startsWith("https://sb.test/rest/v1/rpc/")) {
      const name = url.split("/").pop(); const args = JSON.parse(init.body || "{}");
      if (name === "admin_record_email") { w.recorded = args; return Response.json({ email_id: "e1", request_no: "R-2026-0099", version_no: 2, exercise: FACTS }); }
      if (name === "admin_email_status") return Response.json({ status: args.p_status });
      throw new Error("unexpected rpc " + name);
    }
    if (url === "https://api.resend.com/emails") { w.emails.push(JSON.parse(init.body)); return Response.json({ id: "re_" + w.emails.length }); }
    throw new Error("unexpected " + url);
  };
  return w;
}
const mdeps = (w) => ({ fetchFn: w.fetchFn, env: ENV, origin: "https://plan-proof.com", sleep: async () => {} });
const ics = (b) => Buffer.from(b.attachments[0].content, "base64").toString("utf8");

test(".ics: the start is written in UAE time with the Asia/Dubai zone (UTC+4, no daylight saving); the end follows the length", () => {
  const s = buildIcs({ uid: "x", date: "2026-12-09", time: "10:00", minutes: 90, title: "T", location: "Tower 1, 4th floor", description: "a\nb", stampMs: Date.UTC(2026, 10, 15) });
  assert.match(s, /\r\nDTSTART;TZID=Asia\/Dubai:20261209T100000\r\n/);
  assert.match(s, /\r\nDTEND;TZID=Asia\/Dubai:20261209T113000\r\n/);
  assert.match(s, /TZID:Asia\/Dubai\r\n[\s\S]*TZOFFSETFROM:\+0400\r\nTZOFFSETTO:\+0400/);
  assert.match(s, /LOCATION:Tower 1\\, 4th floor/);
  assert.match(s, /DESCRIPTION:a\\nb/);
  assert.ok(s.split("\r\n").every((l) => Buffer.byteLength(l) <= 75), "lines folded at 75 octets");
});

test(".ics: an exercise late in the evening ends on the next day (UAE), never shifted by the computer's own zone", () => {
  const s = buildIcs({ uid: "x", date: "2026-12-31", time: "23:00", minutes: 120, title: "T", location: "R", description: "" });
  assert.match(s, /DTSTART;TZID=Asia\/Dubai:20261231T230000/);
  assert.match(s, /DTEND;TZID=Asia\/Dubai:20270101T010000/);
});

test(".ics: no date or time → refused (the page keeps the buttons grey; the server refuses too)", () => {
  assert.throws(() => buildIcs({ uid: "x", date: null, time: "10:00" }), SendError);
});

test("the invitation: the join link is put in by the server and the .ics is attached; the UID is the exercise's (a resend updates the same event)", async () => {
  const w = mailWorld();
  const out = await sendClientEmail(mdeps(w), "user-token", { action: "send", kind: "invitation", submission_id: SUB, to: "dana@example.com", subject: "Invitation", message: "Join here: [the join link]" });
  assert.equal(out.ok, true);
  const b = w.emails[0];
  assert.match(b.text, new RegExp(`https://plan-proof\\.com/play/join\\.html\\?session=${SES}`));
  assert.equal(b.attachments[0].filename, "exercise-invitation.ics");
  assert.match(ics(b), new RegExp(`UID:exercise-${SES}@plan-proof\\.com`));
  assert.match(ics(b), /DTSTART;TZID=Asia\/Dubai:20261209T100000/);
  assert.equal(w.recorded.p_kind, "invitation");
});

test("the confirmation: connection-check link put in, .ics attached; a join link in it is refused", async () => {
  const w = mailWorld();
  await sendClientEmail(mdeps(w), "user-token", { action: "send", kind: "confirmation", submission_id: SUB, to: "dana@example.com", subject: "Confirmed", message: "Please run [the connection check link]" });
  assert.match(w.emails[0].text, /https:\/\/plan-proof\.com\/play\/check\.html/);
  assert.equal(w.emails[0].attachments[0].filename, "exercise.ics");
  const w2 = mailWorld();
  await assert.rejects(sendClientEmail(mdeps(w2), "user-token", { action: "send", kind: "confirmation", submission_id: SUB, to: "dana@example.com", subject: "x", message: "Join [the join link]" }), /must not carry the join link/);
  assert.equal(w2.emails.length, 0);
});

test("the facilitator link (with its token) is never emailed — any kind", async () => {
  for (const kind of ["invitation", "confirmation"]) {
    const w = mailWorld();
    await assert.rejects(sendClientEmail(mdeps(w), "user-token", { action: "send", kind, submission_id: SUB, to: "dana@example.com", subject: "x",
      message: `Use https://plan-proof.com/play/facilitator-test.html?session=${SES}&token=abc` }), /never be emailed/);
    assert.equal(w.emails.length, 0);
  }
});

// ---------- alerts ----------
function alertWorld(over = {}) {
  const w = { alerts: [], targets: [], done: [], emails: [], pushes: [], claims: 0, raised: [], ...over };
  w.fetchFn = async (url, init = {}) => {
    if (url.startsWith("https://sb.test/rest/v1/rpc/")) {
      assert.equal(init.headers["x-intake-secret"], "isec", "server calls carry the intake secret");
      const name = url.split("/").pop(); const args = JSON.parse(init.body || "{}");
      if (name === "server_alerts_claim") { w.claims++; const a = w.alerts.filter((x) => !x.claimed); a.forEach((x) => { x.claimed = true; }); return Response.json({ alerts: a, targets: w.targets }); }
      if (name === "server_alert_done") { w.done.push(args); return Response.json({ ok: true }); }
      if (name === "server_raise_alert") { w.raised.push(args); if (!w.alerts.some((x) => x.kind === args.p_kind && x.ref_id === args.p_ref)) w.alerts.push({ id: "a" + (w.alerts.length + 1), kind: args.p_kind, ref_id: args.p_ref, title: args.p_title, body: args.p_body, url: args.p_url, email_by: args.p_email_by }); return Response.json({ new: true }); }
      throw new Error("unexpected rpc " + name);
    }
    throw new Error("unexpected " + url);
  };
  w.sendNotification = async (sub, body) => { w.pushes.push({ sub, body: JSON.parse(body) }); if (w.gone && w.gone.includes(sub.endpoint)) { const e = new Error("gone"); e.statusCode = 410; throw e; } };
  w.sendEmail = async (m) => { if (w.emailDown) throw new Error("Email not sent: down"); w.emails.push(m); };
  return w;
}
const adeps = (w) => ({ fetchFn: w.fetchFn, env: ENV, origin: "https://plan-proof.com", sendNotification: w.sendNotification, sendEmail: w.sendEmail });
const A = (o) => ({ id: "a1", kind: "sponsor_comment", ref_id: "c1", title: "R-2026-0099 · the sponsor commented on v2", body: "Dana: please check inject 3 — copy the revised prompt for Claude", url: "/admin/#request/" + SUB, email_by: "alerts", ...o });

test("an alert goes to every device by push AND by email, once; the payload is the next-action line and opens the request", async () => {
  const w = alertWorld({ alerts: [A()], targets: [{ id: "t1", endpoint: "https://push.example/1", p256dh: "k", auth: "a" }, { id: "t2", endpoint: "https://push.example/2", p256dh: "k", auth: "a" }] });
  const out = await deliverAlerts(adeps(w));
  assert.equal(out.pushed, 2); assert.equal(out.emailed, 1);
  assert.equal(w.pushes[0].body.url, `https://plan-proof.com/admin/#request/${SUB}`);
  assert.match(w.pushes[0].body.body, /copy the revised prompt for Claude/);
  assert.match(w.emails[0].subject, /^PlanProof alert — R-2026-0099/);
  assert.deepEqual(w.emails[0].to, ["exercises@plan-proof.com"]);
  assert.equal(w.done[0].p_emailed, true);
  // a second deliver (the hourly check) finds nothing new: no duplicate push, no duplicate email
  const again = await deliverAlerts(adeps(w));
  assert.equal(again.claimed, 0); assert.equal(w.emails.length, 1); assert.equal(w.pushes.length, 2);
});

test("the new-request alert is pushed but NOT emailed again (the intake email is its email)", async () => {
  const w = alertWorld({ alerts: [A({ kind: "new_request", email_by: "intake" })], targets: [{ id: "t1", endpoint: "https://push.example/1", p256dh: "k", auth: "a" }] });
  const out = await deliverAlerts(adeps(w));
  assert.equal(out.pushed, 1); assert.equal(w.emails.length, 0); assert.equal(w.done[0].p_emailed, false);
});

test("a subscription the browser ended (410) is reported as gone, so the page says 'turn on again'; the email still goes", async () => {
  const w = alertWorld({ alerts: [A()], gone: ["https://push.example/old"], targets: [{ id: "old", endpoint: "https://push.example/old", p256dh: "k", auth: "a" }, { id: "new", endpoint: "https://push.example/new", p256dh: "k", auth: "a" }] });
  await deliverAlerts(adeps(w));
  assert.deepEqual(w.done[0].p_gone, ["old"]); assert.deepEqual(w.done[0].p_ok, ["new"]);
  assert.equal(w.done[0].p_emailed, true);
});

test("with no push keys the alert is still emailed (push is an extra, email is the record)", async () => {
  const w = alertWorld({ alerts: [A()], targets: [{ id: "t1", endpoint: "https://push.example/1", p256dh: "k", auth: "a" }] });
  const out = await deliverAlerts({ ...adeps(w), env: { ...ENV, VAPID_PRIVATE_KEY: "" } });
  assert.equal(w.pushes.length, 0); assert.equal(out.emailed, 1);
});

test("an email that fails leaves the alert open (done not set) so the next deliver tries again; deliver never throws", async () => {
  const w = alertWorld({ alerts: [A()], emailDown: true });
  const out = await deliverAlerts(adeps(w));
  assert.equal(w.done[0].p_emailed, false); assert.match(w.done[0].p_email_error, /down/); assert.ok(out.errors.length);
  const bad = await deliverAlerts({ ...adeps(w), fetchFn: async () => { throw new Error("network"); } });
  assert.equal(bad.claimed, 0); assert.ok(bad.errors.length);
});

test("raise-and-deliver (media ready): raised once, sent once", async () => {
  const w = alertWorld();
  await raiseAndDeliver(adeps(w), { kind: "media_ready", ref: "r1", title: "Voice and video ready", body: "x", url: "/admin/" });
  assert.equal(w.raised.length, 1); assert.equal(w.emails.length, 1);
});

test("payload and email texts", () => {
  assert.equal(JSON.parse(payloadFor(A(), "https://plan-proof.com")).tag, "sponsor_comment-c1");
  assert.match(emailFor(A(), "https://plan-proof.com").text, /Open it: https:\/\/plan-proof\.com\/admin\/#request\//);
});

// ---------- the admin app's service worker ----------
test("admin/sw.js shows push alerts and has NO fetch handler (it caches nothing)", () => {
  const sw = readFileSync(new URL("../admin/sw.js", import.meta.url), "utf8");
  const code = sw.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.doesNotMatch(code, /addEventListener\(\s*["']fetch["']/);
  assert.doesNotMatch(code, /\bonfetch\b|caches\.|CacheStorage/);
  assert.match(code, /addEventListener\("push"/);
  assert.match(code, /addEventListener\("notificationclick"/);
});

test("the sponsor's page asks for the second tick and sends it (fix 12)", () => {
  const c = readFileSync(new URL("../c/index.html", import.meta.url), "utf8");
  assert.match(c, /I will not share this scenario with anyone taking part in the exercise/);
  assert.match(c, /p_no_share: true/);
  assert.match(c, /Confidential — for " \+ \(d\.sponsor \|\| "the sponsor"\) \+ " only\. Not for participants\./);
});
