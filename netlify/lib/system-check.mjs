// PlanProof system check: is everything that handles a client request
// working? Used by
//   - /api/health (netlify/functions/health.mjs): for an outside uptime
//     monitor and for the admin page's warning banner;
//   - system-check (netlify/functions/system-check.mjs, every hour): emails an
//     alert when something is wrong, a "resolved" note when it recovers, a
//     daily digest of possible-spam requests that were not emailed one by
//     one, and a weekly all-clear heartbeat (so silence itself is noticed).
//
// Added 9 October 2026 after the whole-system review: before this, a request
// that could not be delivered was retried silently and dropped after 7 days
// with only a log line. Now nothing is dropped, and a problem raises an alarm.
//
// What is checked:
//   database   Supabase answers (also keeps the Free-plan project from being
//              paused for inactivity) and, once INTAKE_DB_SECRET is set, that
//              the function's server-only secret is accepted.
//   email      the Resend key is accepted and the sending domain is verified.
//   requests   no request has waited more than 30 minutes to be delivered.
//   scheduler  the 5-minute retry job has run recently.
//
// The public /api/health answer contains only these four words and short
// problem codes — never client data, counts or settings.

import { INBOX, supabaseHeaders, sendViaResend, readStats } from "./intake-core.mjs";

export const DELAYED_AFTER_MS = 30 * 60 * 1000;
export const RETRY_STALE_AFTER_MS = 20 * 60 * 1000;
export const REALERT_AFTER_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const PROBLEM_TEXT = {
  database_unreachable: "The database (Supabase) is not answering. New requests are still emailed, but the admin page and the exercise player will not work. If the project was paused, open Supabase and press Restore.",
  db_secret_rejected: "The database refused the website's server key (INTAKE_DB_SECRET). New requests are emailed but are NOT reaching the admin page. Check the INTAKE_DB_SECRET value in Netlify.",
  email_key_rejected: "The email service (Resend) refused PlanProof's key. New requests reach the admin page but are NOT emailed. Check RESEND_API_KEY in Netlify and the key in Resend.",
  email_unreachable: "The email service (Resend) could not be reached. Emails are being retried automatically.",
  email_domain_unverified: "The sending domain notify.plan-proof.com is no longer verified in Resend, so emails fall back to Resend's shared sender and may be filtered. Re-verify the domain in Resend.",
  requests_delayed: "At least one website request has been waiting more than 30 minutes to be delivered. It is safely stored and is being retried.",
  retry_job_not_running: "The automatic retry job has not run in the last 20 minutes. Check the Functions tab in Netlify.",
  storage_unreachable: "The temporary request store (Netlify Blobs) could not be read.",
};

async function timedFetch(deps, url, init = {}, ms = 5000) {
  return deps.fetchFn(url, { ...init, signal: AbortSignal.timeout(ms) });
}

async function checkDatabase(deps, out) {
  const { env } = deps;
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) { out.checks.database = "fail"; out.problems.push("database_unreachable"); return; }
  try {
    const res = await timedFetch(deps, `${env.SUPABASE_URL}/rest/v1/rpc/intake_self_check`, {
      method: "POST",
      headers: supabaseHeaders(env, { "Content-Type": "application/json" }),
      body: "{}",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const r = await res.json();
    out.checks.database = "ok";
    out.internal.dbSecret = env.INTAKE_DB_SECRET ? (r.secret_ok ? "accepted" : "rejected") : "not set";
    out.internal.dbLock = r.lock === true ? "on" : r.lock === false ? "off" : "unknown";
    if (env.INTAKE_DB_SECRET && !r.secret_ok) { out.checks.database = "fail"; out.problems.push("db_secret_rejected"); }
  } catch (err) {
    out.checks.database = "fail";
    out.problems.push("database_unreachable");
    out.internal.dbError = err.message;
  }
}

async function checkEmail(deps, out) {
  const { env } = deps;
  if (!env.RESEND_API_KEY) { out.checks.email = "fail"; out.problems.push("email_key_rejected"); return; }
  try {
    const res = await timedFetch(deps, "https://api.resend.com/domains", { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } });
    if (res.ok) {
      out.checks.email = "ok";
      const body = await res.json().catch(() => ({}));
      const domains = Array.isArray(body.data) ? body.data : [];
      const notify = domains.find((d) => d.name === "notify.plan-proof.com");
      if (notify && notify.status && notify.status !== "verified") { out.checks.email = "fail"; out.problems.push("email_domain_unverified"); }
      return;
    }
    const text = await res.text();
    // A "sending access" key may not list domains, but answering this way
    // proves the key itself is accepted.
    if (res.status === 401 && /restricted_api_key/i.test(text)) { out.checks.email = "ok"; return; }
    out.checks.email = "fail";
    out.problems.push(res.status === 401 || res.status === 403 ? "email_key_rejected" : "email_unreachable");
    out.internal.emailError = `HTTP ${res.status}`;
  } catch (err) {
    out.checks.email = "fail";
    out.problems.push("email_unreachable");
    out.internal.emailError = err.message;
  }
}

async function checkQueue(deps, out, nowMs) {
  try {
    const { blobs } = await deps.pending.list();
    let oldest = null, waiting = 0;
    for (const { key } of blobs) {
      if (!key.startsWith("rec/")) continue;
      const rec = await deps.pending.get(key, { type: "json" });
      if (!rec) continue;
      waiting++;
      const t = Date.parse(rec.receivedAt);
      if (oldest === null || t < oldest) oldest = t;
    }
    out.internal.waiting = waiting;
    out.internal.oldestWaitingMinutes = oldest === null ? 0 : Math.round((nowMs - oldest) / 60000);
    out.checks.requests = oldest !== null && nowMs - oldest > DELAYED_AFTER_MS ? "delayed" : "ok";
    if (out.checks.requests === "delayed") out.problems.push("requests_delayed");

    const last = await deps.pending.get("meta/last-retry-run", { type: "json" });
    if (!last) out.checks.scheduler = "unknown"; // a brand-new deploy, before the first run
    else if (nowMs - last.at > RETRY_STALE_AFTER_MS) { out.checks.scheduler = "stale"; out.problems.push("retry_job_not_running"); }
    else out.checks.scheduler = "ok";
  } catch (err) {
    out.checks.requests = "fail";
    out.checks.scheduler = "unknown";
    out.problems.push("storage_unreachable");
    out.internal.storageError = err.message;
  }
}

// deps: { pending, fetchFn, env, nowMs? }
export async function checkHealth(deps) {
  const nowMs = deps.nowMs ?? Date.now();
  const out = { status: "ok", checks: {}, problems: [], checkedAt: new Date(nowMs).toISOString(), internal: {} };
  await Promise.all([checkDatabase(deps, out), checkEmail(deps, out), checkQueue(deps, out, nowMs)]);
  if (out.problems.length) out.status = "problem";
  return out;
}

// What /api/health shows to anyone: status words and problem codes only.
export function publicHealth(h) {
  return { status: h.status, checks: h.checks, problems: h.problems, checked_at: h.checkedAt };
}

function recipients(env) {
  const extra = String(env.ALERT_EMAIL || "").split(",").map((s) => s.trim()).filter((s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  return [...new Set([INBOX, ...extra])];
}

function describe(h) {
  const lines = [];
  for (const code of h.problems) lines.push(`• ${PROBLEM_TEXT[code] || code}`);
  return lines.join("\n");
}

function statusLines(h) {
  return [
    `Database: ${h.checks.database}${h.internal.dbSecret ? ` (server key: ${h.internal.dbSecret}, public writes ${h.internal.dbLock === "on" ? "blocked" : "still allowed"})` : ""}`,
    `Email: ${h.checks.email}`,
    `Requests waiting: ${h.internal.waiting ?? "?"}${h.internal.oldestWaitingMinutes ? ` (oldest ${h.internal.oldestWaitingMinutes} min)` : ""}`,
    `Retry job: ${h.checks.scheduler}`,
  ];
}

const uaeDate = (ms) => new Date(ms).toLocaleString("en-GB", { timeZone: "Asia/Dubai", dateStyle: "medium", timeStyle: "short" });

// The hourly job. Returns what it did (for logs and tests).
export async function runSystemCheck(deps) {
  const log = deps.log || console;
  const nowMs = deps.nowMs ?? Date.now();
  const h = await checkHealth({ ...deps, nowMs });
  const done = { status: h.status, problems: h.problems, sent: [] };
  const to = recipients(deps.env);
  let state = {};
  try { state = (await deps.pending.get("meta/alert-state", { type: "json" })) || {}; } catch { /* storage problem already reported */ }

  const key = [...h.problems].sort().join(",");
  const send = async (kind, subject, text) => {
    try { await sendViaResend({ to, subject, text }, deps); done.sent.push(kind); }
    catch (err) { log.error(`system-check: could not send the ${kind} email:`, err.message); }
  };

  // Whenever the alert recipients change (e.g. ALERT_EMAIL set or edited in
  // Netlify), send one confirmation to the new list, so a mistyped address is
  // noticed now rather than when a real alert fails to arrive.
  const recipientsKey = to.join(",");
  if (state.recipients !== recipientsKey) {
    await send("recipients", "PlanProof alerts — recipient list confirmed",
      [`From now on PlanProof system alerts, "resolved" notes, the daily possible-spam digest and the Monday all-clear go to:`,
        ...to.map((a) => `• ${a}`), "",
        "No action is needed. If you did not expect this email, tell Claude.", "",
        `Current status (${uaeDate(nowMs)} UAE time):`, ...statusLines(h)].join("\n"));
    if (done.sent.includes("recipients")) state.recipients = recipientsKey;
  }

  if (h.problems.length) {
    if (key !== state.key || !state.sentAt || nowMs - state.sentAt > REALERT_AFTER_MS) {
      await send("alert", "⚠ PlanProof system alert — action may be needed",
        [`Checked ${uaeDate(nowMs)} (UAE time).`, "", "What is wrong:", describe(h), "", ...statusLines(h), "",
          "No website request is ever deleted because of this: everything waiting is kept and retried until it is delivered.",
          "This alert repeats every 6 hours while the problem lasts, and you will get a 'resolved' email when it clears.",
          "Live status: https://plan-proof.com/api/health"].join("\n"));
      if (done.sent.includes("alert")) state = { ...state, key, sentAt: nowMs, since: state.key ? state.since || nowMs : nowMs };
    }
  } else if (state.key) {
    await send("resolved", "✓ PlanProof system alert resolved",
      [`All checks passed at ${uaeDate(nowMs)} (UAE time).`, "", ...statusLines(h)].join("\n"));
    if (done.sent.includes("resolved")) state = { digestDay: state.digestDay, recipients: state.recipients };
  }

  // Once a day at 04:xx UTC (08:xx UAE): digest of possible-spam requests that were not emailed.
  const hour = new Date(nowMs).getUTCHours();
  if (hour === 4 && state.digestDay !== new Date(nowMs).toISOString().slice(0, 10)) {
    const y = await readStats(deps.pending, nowMs - DAY_MS);
    if (y.spamSuppressed) {
      await send("digest", `PlanProof: ${y.spamSuppressed} possible-spam request(s) yesterday were not emailed`,
        [`Yesterday, after ${y.spamEmailed || 0} possible-spam emails, ${y.spamSuppressed} more request(s) labelled "possible spam" were saved to the admin page without an individual email (flood protection).`,
          "", "Check them on the admin page (Requests) and erase any junk: https://plan-proof.com/admin/"].join("\n"));
    }
    state.digestDay = new Date(nowMs).toISOString().slice(0, 10);

    // Mondays: weekly heartbeat, so a silent week is noticed.
    if (new Date(nowMs).getUTCDay() === 1) {
      let received = 0, spam = 0;
      for (let i = 1; i <= 7; i++) { const st = await readStats(deps.pending, nowMs - i * DAY_MS); received += st.received || 0; spam += (st.receivedSpam || 0); }
      await send("heartbeat", h.problems.length ? "PlanProof weekly check — problems open" : "✓ PlanProof weekly check — all clear",
        [`Weekly check, ${uaeDate(nowMs)} (UAE time).`, "", ...statusLines(h), "",
          `Website requests in the last 7 days: ${received} (plus ${spam} labelled possible spam).`,
          h.problems.length ? `\nOpen problems:\n${describe(h)}` : "",
          "", "If this email ever stops arriving on Monday mornings, the alarm itself is not working — tell Claude."].join("\n"));
    }
  }

  try { await deps.pending.setJSON("meta/alert-state", state); } catch { /* reported by the health check */ }
  if (h.problems.length) log.error("system-check problems:", JSON.stringify({ problems: h.problems, internal: h.internal }));
  return done;
}
