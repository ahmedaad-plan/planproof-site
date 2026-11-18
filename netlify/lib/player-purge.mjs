// Removes an exercise's player data 7 days after its request is marked
// "Delivered" (W5, 26 October 2026), and reminds PlanProof when an exercise
// record was downloaded 30 days ago but the request was never marked
// Delivered. Runs daily (netlify/functions/player-purge.mjs).
//
// What it removes, per exercise: the attachment FILES and (W6a) the narration
// and news-clip files in exercise-media (Storage refuses SQL
// removal, so they go first, through the Storage API), then — through
// public.service_purge_session — registrations, answers, notes, messages and
// the rest (see w5_purge_paste_into_supabase.sql). The database itself
// refuses an exercise that is not due, that was never exported, or whose
// files are still stored.
//
// Needs SUPABASE_SECRET_KEY (a Supabase "sb_secret_…" key, Netlify variable
// marked secret). Without it nothing is removed and nothing breaks: the admin
// page shows the removal as overdue and offers "Remove player data now".
import { INBOX, sendViaResend } from "./intake-core.mjs";

export const BUCKET = "submission-attachments";
// W6a: an exercise's narration and news clips (briefing videos are shared and never removed).
export const MEDIA_BUCKET = "exercise-media";
// W8: files the client sent or that we send them (scenario drafts, report files).
// The database marks a file "to delete" when its request or client goes; this
// morning job removes it from storage (storage refuses deleting by SQL).
export const CLIENT_BUCKET = "client-files";
export const mediaPrefixes = (sessionId) => [`narration/${sessionId}`, `clips/${sessionId}`];

function headers(env, extra = {}) {
  // New-style secret keys go in the apikey header only (never as a Bearer token).
  return { apikey: env.SUPABASE_SECRET_KEY, ...extra };
}
async function call(deps, path, init = {}) {
  const res = await deps.fetchFn(`${deps.env.SUPABASE_URL}${path}`, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? 15000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}
const rpc = (deps, name, args = {}) => call(deps, `/rest/v1/rpc/${name}`, {
  method: "POST", headers: headers(deps.env, { "Content-Type": "application/json" }), body: JSON.stringify(args) });

// Every stored file under "<session id>/", however deep (folders have id null).
export async function listFiles(deps, prefix, depth = 0, bucket = BUCKET) {
  if (depth > 6) return [];
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const items = await call(deps, `/storage/v1/object/list/${bucket}`, {
      method: "POST", headers: headers(deps.env, { "Content-Type": "application/json" }),
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }) }) || [];
    for (const it of items) {
      const p = `${prefix}/${it.name}`;
      if (it.id == null) out.push(...await listFiles(deps, p, depth + 1, bucket)); else out.push(p);
    }
    if (items.length < 1000) break;
  }
  return out;
}
export async function removeFiles(deps, paths, bucket = BUCKET) {
  for (let i = 0; i < paths.length; i += 100) {
    await call(deps, `/storage/v1/object/${bucket}`, {
      method: "DELETE", headers: headers(deps.env, { "Content-Type": "application/json" }), body: JSON.stringify({ prefixes: paths.slice(i, i + 100) }) });
  }
}

function recipients(env) {
  const extra = String(env.ALERT_EMAIL || "").split(",").map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  return [INBOX, ...extra.filter((e) => e.toLowerCase() !== INBOX)];
}
const uaeDate = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const name = (x) => `${x.request_no || "(no request)"} — ${x.label || "exercise"}`;

// The morning reminders email (W8 build 3): one email, only when something needs Ahmed.
export function morningReminders(rem, nowMs) {
  const lines = [];
  const uae = new Date(nowMs + 4 * 3600000);
  const lessons = rem.lessons_missing || [], zoho = rem.zoho_open || [];
  if (lessons.length) {
    lines.push("Lessons record — the insight is not written yet for:");
    lessons.forEach((x) => lines.push(`- ${x.request_no || "(request deleted)"}${x.delivered_at ? " (delivered " + uaeDate(x.delivered_at) + ")" : ""}`));
    lines.push("On the request, press \"Copy the lessons prompt for Claude\" and paste it into the report chat. Claude writes it; you approve the wording.", "");
  }
  if (zoho.length) {
    lines.push("Zoho Mail — delete the emails with client material (Inbox and Sent), then press Done ✓ in the request's Done block:");
    zoho.forEach((r) => lines.push("- " + r));
    lines.push("");
  }
  const monthly = uae.getUTCDate() === 1;
  if (monthly) {
    lines.push(`Monthly export due — last export ${rem.last_export_at ? uaeDate(rem.last_export_at) : "never"}.`,
      "Admin page → Clients → Export everything (top right). Move the zip to OneDrive \\ PlanProof New \\ 08 Full backup \\ <date>; keep the two newest.", "");
  }
  const subject = monthly && !lessons.length && !zoho.length ? "PlanProof: monthly export due" : "PlanProof: this morning's reminders";
  return { lines, subject, lessons: lessons.length, zoho: zoho.length, monthly };
}

export async function runPlayerPurge(deps) {
  const { env } = deps;
  const report = { removed: [], failed: [], reminded: [], retention: [], clientFiles: null, nightly: null, skipped: null };
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) { report.skipped = "SUPABASE_SECRET_KEY not set"; return report; }

  const due = await rpc(deps, "service_purge_due");
  for (const x of due || []) {
    try {
      const files = await listFiles(deps, x.session_id);
      await removeFiles(deps, files);
      const left = await listFiles(deps, x.session_id);
      if (left.length) throw new Error(`${left.length} file(s) could not be removed`);
      // W6a: the exercise's narration and news clips go too (the database refuses while any remain).
      let media = [];
      for (const pre of mediaPrefixes(x.session_id)) media.push(...await listFiles(deps, pre, 0, MEDIA_BUCKET));
      await removeFiles(deps, media, MEDIA_BUCKET);
      let mediaLeft = [];
      for (const pre of mediaPrefixes(x.session_id)) mediaLeft.push(...await listFiles(deps, pre, 0, MEDIA_BUCKET));
      if (mediaLeft.length) throw new Error(`${mediaLeft.length} voice or video file(s) could not be removed`);
      const res = await rpc(deps, "service_purge_session", { p_session: x.session_id });
      report.removed.push({ ...x, files: files.length, result: res });
    } catch (err) {
      report.failed.push({ ...x, error: err.message });
    }
  }
  const remind = await rpc(deps, "service_reminders_due");
  const to = recipients(env);
  if (report.removed.length || report.failed.length) {
    const lines = ["PlanProof removed exercise player data, as promised in the privacy policy (7 days after the report was delivered).", ""];
    report.removed.forEach((x) => { const r = x.result || {}; lines.push(`Removed: ${name(x)} (delivered ${uaeDate(x.delivered_at)}) — ${r.registrations ?? "?"} registrations, ${r.answers ?? "?"} answers, ${r.notes ?? "?"} notes, ${r.messages ?? "?"} messages, ${x.files} files.`); });
    if (report.failed.length) {
      lines.push("", "NOT removed — please press \"Remove player data now\" on the request's Exercise tab:");
      report.failed.forEach((x) => lines.push(`- ${name(x)}: ${x.error}`));
    }
    lines.push("", "The anonymous survey answers stay (role only), and comments only where the person ticked that we may quote them. Nothing else is kept from these exercises except our copy of each delivered report (without participants' names) and, if the client opted in, the history record.");
    await sendViaResend({ to, subject: report.failed.length ? "PlanProof: player data removal needs you" : "PlanProof: exercise player data removed", text: lines.join("\n") }, deps);
  }
  if ((remind || []).length) {
    const lines = ["These exercise records were downloaded 30 days ago or more, but their request is still not marked \"Delivered\" on the admin page.", "",
      "Their participants' names, answers and notes stay in the database until you do (they are removed 7 days after Delivered).", ""];
    remind.forEach((x) => lines.push(`- ${name(x)} — first downloaded ${uaeDate(x.exported_at)}`));
    lines.push("", "If the report was delivered: open the request on plan-proof.com/admin and set the stage to Delivered.");
    await sendViaResend({ to, subject: "PlanProof: exercise records waiting to be marked Delivered", text: lines.join("\n") }, deps);
    for (const x of remind) { await rpc(deps, "service_mark_reminded", { p_session: x.session_id }); report.reminded.push(x); }
  }
  // W7 (8 November 2026): the database deletes client records on its own each night
  // (1 year after the last contact if no exercise went ahead; 3 years after the latest
  // exercise). Tell PlanProof the same morning, so the report copy on the drive goes too.
  const gone = await rpc(deps, "service_retention_unreported");
  if ((gone || []).length) {
    const lines = ["As the privacy policy promises, the database deleted these client records last night:", ""];
    gone.forEach((x) => lines.push(`- ${x.company_name || "(no client name)"}${x.request_nos && x.request_nos.length ? " — " + x.request_nos.join(", ") : ""}: ${x.reason}.`));
    const delivered = gone.filter((x) => x.had_delivery);
    // W8 build 3 (decision 12): report files live in the database's private bucket and go
    // with the client's record by themselves; the one hand deletion left is Zoho Mail.
    lines.push("", "ACTION (Zoho Mail only) — delete their emails with client material (Inbox and Sent) in the exercises@plan-proof.com mailbox:");
    gone.forEach((x) => lines.push(`- ${x.company_name || "(no client name)"}${x.request_nos && x.request_nos.length ? " (" + x.request_nos.join(", ") + ")" : ""}`));
    lines.push("", "Their report files (also the archive copies) were deleted from storage with the record — nothing to delete on the drive.");
    lines.push("", "If someone had ticked \"marketing emails\", only their email address and the date they ticked are kept, until they withdraw.");
    await sendViaResend({ to, subject: delivered.length ? "PlanProof: client records deleted — delete their emails in Zoho Mail" : "PlanProof: old enquiries deleted", text: lines.join("\n") }, deps);
    await rpc(deps, "service_mark_retention_reported", { p_ids: gone.map((x) => x.id) });
    report.retention.push(...gone);
  }
  // W8 build 3 (18 November 2026): this morning's reminders — the lessons insight still to write,
  // the Zoho Mail deletion still to tick, and on the 1st of the month the export (decision 11).
  try {
    const rem = await rpc(deps, "service_morning_reminders") || {};
    report.reminders = morningReminders(rem, deps.nowMs ?? Date.now());
    if (report.reminders.lines.length) await sendViaResend({ to, subject: report.reminders.subject, text: report.reminders.lines.join("\n") }, deps);
  } catch (e) { report.reminders = { error: e.message }; }
  // W8 (11 November 2026): client files whose request or client was deleted overnight.
  try {
    const pending = await rpc(deps, "service_client_files_pending") || [];
    const deleted = [], failed = [];
    let err = null;
    for (let i = 0; i < pending.length; i += 100) {
      const batch = pending.slice(i, i + 100);
      try {
        // A file already missing from storage counts as gone (storage answers
        // without an error); a refused call leaves the whole batch for tomorrow.
        await call(deps, `/storage/v1/object/${CLIENT_BUCKET}`, {
          method: "DELETE", headers: headers(env, { "Content-Type": "application/json" }), body: JSON.stringify({ prefixes: batch.map((f) => f.path) }) });
        batch.forEach((f) => deleted.push(f.id));
      } catch (e) { err = e.message; batch.forEach((f) => failed.push(f.id)); }
    }
    const res = pending.length ? await rpc(deps, "service_client_files_result", { p_deleted: deleted, p_failed: failed, p_error: err }) : { rows_deleted: 0, failed: 0, stuck: 0 };
    report.clientFiles = { pending: pending.length, deleted: deleted.length, failed: failed.length, stuck: (res && res.stuck) || 0, error: err };
    report.nightly = await rpc(deps, "service_last_purge").catch(() => null);
    if (failed.length && report.clientFiles.stuck) {
      await sendViaResend({ to, subject: "PlanProof: client files could not be deleted", text: [
        `The morning job could not delete ${report.clientFiles.stuck} client file(s) from storage after two tries (bucket ${CLIENT_BUCKET}).`,
        err ? "Error: " + err : "", "", "Open Supabase → Storage → client-files and delete them by hand, or tell Claude."].filter(Boolean).join("\n") }, deps);
    }
  } catch (e) { report.clientFiles = { error: e.message }; }
  // W8 build 2 (16 Nov 2026): voice and clip files of a never-started exercise
  // whose request was deleted. A refused call stays queued for tomorrow.
  try {
    const queued = await rpc(deps, "service_media_remove_pending") || [];
    report.orphanMedia = { queued: queued.length, removed: 0, failed: 0 };
    for (const q of queued) {
      try {
        const paths = [];
        for (const pre of mediaPrefixes(q.session_id)) paths.push(...await listFiles(deps, pre, 0, MEDIA_BUCKET));
        if (paths.length) await removeFiles(deps, paths, MEDIA_BUCKET);
        const left = [];
        for (const pre of mediaPrefixes(q.session_id)) left.push(...await listFiles(deps, pre, 0, MEDIA_BUCKET));
        if (left.length) throw new Error(left.length + " file(s) still in storage");
        await rpc(deps, "service_media_remove_result", { p_session: q.session_id, p_ok: true });
        report.orphanMedia.removed++;
      } catch (e) {
        report.orphanMedia.failed++;
        await rpc(deps, "service_media_remove_result", { p_session: q.session_id, p_ok: false, p_error: e.message }).catch(() => null);
      }
    }
  } catch (e) { report.orphanMedia = { error: e.message }; }
  return report;
}
