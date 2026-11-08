// W5 — the daily removal of exercise player data (netlify/lib/player-purge.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { runPlayerPurge } from "../netlify/lib/player-purge.mjs";

const SID = "11111111-2222-4333-8444-555555555555";
function world(opts = {}) {
  const w = { files: new Set([`${SID}/0/IT/1-log.pdf`, `${SID}/2/IT/old.png`]), media: new Set([`narration/${SID}/a.mp3`, `clips/${SID}/b.mp4`, "briefing/participant-en.mp4"]), calls: [], emails: [], purged: [], reminded: [], ...opts };
  w.fetchFn = async (url, init = {}) => {
    const u = new URL(url); const body = init.body ? JSON.parse(init.body) : null;
    w.calls.push(`${init.method || "GET"} ${u.pathname}`);
    const ok = (data, status = 200) => new Response(data == null ? "" : JSON.stringify(data), { status });
    if (u.hostname === "api.resend.com") { w.emails.push(body); return ok({ id: "e" }); }
    assert.equal(init.headers.apikey, "sb_secret_test");
    assert.ok(!init.headers.Authorization, "a secret key is never sent as a Bearer token");
    if (u.pathname === "/rest/v1/rpc/service_purge_due") return ok(w.due ?? [{ session_id: SID, label: "Test", request_no: "R-2026-0001", delivered_at: "2026-10-10T08:00:00Z" }]);
    if (u.pathname === "/rest/v1/rpc/service_reminders_due") return ok(w.remind ?? []);
    if (u.pathname === "/rest/v1/rpc/service_mark_reminded") { w.reminded.push(body.p_session); return ok(null); }
    // W7: the client records the database deleted overnight
    if (u.pathname === "/rest/v1/rpc/service_retention_unreported") return ok(w.gone ?? []);
    if (u.pathname === "/rest/v1/rpc/service_mark_retention_reported") { w.markedGone = body.p_ids; return ok(body.p_ids.length); }
    if (u.pathname === "/rest/v1/rpc/service_purge_session") {
      if ([...w.files].some((p) => p.startsWith(body.p_session + "/"))) return ok({ message: "files still stored" }, 400);
      if ([...w.media].some((p) => p.includes(body.p_session))) return ok({ message: "media still stored" }, 400);
      w.purged.push(body.p_session); return ok({ status: "purged", registrations: 7, answers: 9, notes: 3, messages: 4 });
    }
    if (u.pathname === "/storage/v1/object/list/submission-attachments") {
      const pre = body.prefix; const names = new Map();
      for (const p of w.files) if (p.startsWith(pre + "/")) { const r = p.slice(pre.length + 1).split("/"); names.set(r[0], r.length > 1 ? null : "id"); }
      return ok([...names].map(([name, id]) => ({ name, id })));
    }
    // W6a: the exercise-media bucket (narration and clips of this exercise; briefings are shared)
    if (u.pathname === "/storage/v1/object/list/exercise-media") {
      const pre = body.prefix; const names = new Map();
      for (const p of w.media) if (p.startsWith(pre + "/")) { const r = p.slice(pre.length + 1).split("/"); names.set(r[0], r.length > 1 ? null : "id"); }
      return ok([...names].map(([name, id]) => ({ name, id })));
    }
    if (u.pathname === "/storage/v1/object/exercise-media" && init.method === "DELETE") {
      if (!w.mediaStuck) body.prefixes.forEach((p) => w.media.delete(p));
      return ok(body.prefixes.map((name) => ({ name })));
    }
    if (u.pathname === "/storage/v1/object/submission-attachments" && init.method === "DELETE") {
      if (!w.stuck) body.prefixes.forEach((p) => w.files.delete(p));
      return ok(body.prefixes.map((name) => ({ name })));
    }
    return ok({ message: "unexpected " + u.pathname }, 404);
  };
  w.env = { SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "sb_secret_test", RESEND_API_KEY: "re_test", ALERT_EMAIL: "owner@example.com" };
  return w;
}

test("without the secret key nothing is removed and nothing is called", async () => {
  const w = world(); w.env.SUPABASE_SECRET_KEY = "";
  const r = await runPlayerPurge({ fetchFn: w.fetchFn, env: w.env });
  assert.equal(r.skipped, "SUPABASE_SECRET_KEY not set");
  assert.equal(w.calls.length, 0);
});

test("a due exercise: every file (all runs, nested) first, then the rows, then one email", async () => {
  const w = world();
  const r = await runPlayerPurge({ fetchFn: w.fetchFn, env: w.env });
  assert.equal(w.files.size, 0);
  assert.deepEqual(w.purged, [SID]);
  assert.equal(r.removed[0].files, 2);
  assert.equal(w.emails.length, 1);
  assert.match(w.emails[0].subject, /player data removed/);
  assert.match(w.emails[0].text, /R-2026-0001.*7 registrations, 9 answers, 3 notes, 4 messages, 2 files/);
  assert.deepEqual(w.emails[0].to, ["exercises@plan-proof.com", "owner@example.com"]);
  assert.ok(w.calls.indexOf("POST /rest/v1/rpc/service_purge_session") > w.calls.lastIndexOf("DELETE /storage/v1/object/submission-attachments"));
});

test("files that will not go: rows are kept and the email asks for help", async () => {
  const w = world({ stuck: true });
  const r = await runPlayerPurge({ fetchFn: w.fetchFn, env: w.env });
  assert.equal(w.purged.length, 0);
  assert.equal(r.failed.length, 1);
  assert.match(w.emails[0].subject, /needs you/);
  assert.match(w.emails[0].text, /Remove player data now/);
});

test("nothing due and nothing to remind: no email", async () => {
  const w = world({ due: [] });
  await runPlayerPurge({ fetchFn: w.fetchFn, env: w.env });
  assert.equal(w.emails.length, 0);
});

test("30-day reminder: one email, then marked so it is sent once", async () => {
  const w = world({ due: [], remind: [{ session_id: SID, label: "Test", request_no: "R-2026-0001", exported_at: "2026-09-20T08:00:00Z" }] });
  const r = await runPlayerPurge({ fetchFn: w.fetchFn, env: w.env });
  assert.equal(w.emails.length, 1);
  assert.match(w.emails[0].subject, /waiting to be marked Delivered/);
  assert.deepEqual(w.reminded, [SID]);
  assert.equal(r.reminded.length, 1);
});

test("W6a: the exercise's narration and clips are removed before the rows; shared briefings stay", async () => {
  const w = world();
  await runPlayerPurge({ fetchFn: w.fetchFn, env: w.env });
  assert.deepEqual([...w.media], ["briefing/participant-en.mp4"]);
  assert.deepEqual(w.purged, [SID]);
  assert.ok(w.calls.indexOf("POST /rest/v1/rpc/service_purge_session") > w.calls.lastIndexOf("DELETE /storage/v1/object/exercise-media"));
});

test("W6a: media that will not go keeps the rows and asks for help", async () => {
  const w = world({ mediaStuck: true });
  const r = await runPlayerPurge({ fetchFn: w.fetchFn, env: w.env });
  assert.equal(w.purged.length, 0);
  assert.match(r.failed[0].error, /voice or video file/);
});

// W7 (8 November 2026): retention deletions are reported the same morning
test("W7: deleted client records with a delivered report — one email asking to delete the report copy, then marked", async () => {
  const w = world({ due: [], gone: [
    { id: 4, company_name: "Old Co", request_nos: ["R-2026-0020"], had_delivery: true, reason: "3 years since the latest exercise" },
    { id: 5, company_name: "Quiet Co", request_nos: ["R-2026-0031"], had_delivery: false, reason: "No exercise went ahead; 1 year since the last contact" }] });
  const r = await runPlayerPurge(w);
  assert.equal(w.emails.length, 1);
  assert.match(w.emails[0].subject, /delete the report copy/);
  assert.match(w.emails[0].text, /Old Co — R-2026-0020: 3 years/);
  assert.match(w.emails[0].text, /ACTION — please delete our copy of the delivered report for:\n- Old Co \(R-2026-0020\)/);
  assert.doesNotMatch(w.emails[0].text.split("ACTION")[1], /Quiet Co/);
  assert.match(w.emails[0].text, /03 Delivered reports/);
  assert.deepEqual(w.markedGone, [4, 5]);
  assert.equal(r.retention.length, 2);
});
test("W7: only old enquiries — a plain email, nothing to delete on the drive", async () => {
  const w = world({ due: [], gone: [{ id: 9, company_name: "Quiet Co", request_nos: [], had_delivery: false, reason: "No exercise went ahead; 1 year since the last contact" }] });
  await runPlayerPurge(w);
  assert.equal(w.emails.length, 1);
  assert.equal(w.emails[0].subject, "PlanProof: old enquiries deleted");
  assert.match(w.emails[0].text, /nothing to delete on the drive/);
  assert.doesNotMatch(w.emails[0].text, /ACTION/);
});
test("W7: nothing deleted overnight — no retention email and nothing marked", async () => {
  const w = world({ due: [] });
  await runPlayerPurge(w);
  assert.equal(w.emails.length, 0);
  assert.equal(w.markedGone, undefined);
});
