// Removes an exercise's player data 7 days after its request is marked
// "Delivered" (W5, 26 October 2026), and reminds PlanProof when an exercise
// record was downloaded 30 days ago but the request was never marked
// Delivered. Runs daily (netlify/functions/player-purge.mjs).
//
// What it removes, per exercise: the attachment FILES (Storage refuses SQL
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
export async function listFiles(deps, prefix, depth = 0) {
  if (depth > 6) return [];
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const items = await call(deps, `/storage/v1/object/list/${BUCKET}`, {
      method: "POST", headers: headers(deps.env, { "Content-Type": "application/json" }),
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: "name", order: "asc" } }) }) || [];
    for (const it of items) {
      const p = `${prefix}/${it.name}`;
      if (it.id == null) out.push(...await listFiles(deps, p, depth + 1)); else out.push(p);
    }
    if (items.length < 1000) break;
  }
  return out;
}
export async function removeFiles(deps, paths) {
  for (let i = 0; i < paths.length; i += 100) {
    await call(deps, `/storage/v1/object/${BUCKET}`, {
      method: "DELETE", headers: headers(deps.env, { "Content-Type": "application/json" }), body: JSON.stringify({ prefixes: paths.slice(i, i + 100) }) });
  }
}

function recipients(env) {
  const extra = String(env.ALERT_EMAIL || "").split(",").map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  return [INBOX, ...extra.filter((e) => e.toLowerCase() !== INBOX)];
}
const uaeDate = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const name = (x) => `${x.request_no || "(no request)"} — ${x.label || "exercise"}`;

export async function runPlayerPurge(deps) {
  const { env } = deps;
  const report = { removed: [], failed: [], reminded: [], skipped: null };
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) { report.skipped = "SUPABASE_SECRET_KEY not set"; return report; }

  const due = await rpc(deps, "service_purge_due");
  for (const x of due || []) {
    try {
      const files = await listFiles(deps, x.session_id);
      await removeFiles(deps, files);
      const left = await listFiles(deps, x.session_id);
      if (left.length) throw new Error(`${left.length} file(s) could not be removed`);
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
    lines.push("", "The anonymous survey answers stay (role only). Nothing else is kept from these exercises except the delivered reports and, if the client opted in, the history record.");
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
  return report;
}
