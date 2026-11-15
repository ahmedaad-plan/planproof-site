// W8 build 2 (15 November 2026) — PlanProof's alerts: a push to every phone or
// laptop where Ahmed turned "Alerts on", and ALWAYS an email too (design D.10,
// decision 8: push is a convenience, email is the record).
//
// How it holds together (design for failure):
//   - The database decides what is an alert and keeps ONE row per event
//     (alerts, unique per kind + the thing it is about). Anybody may ask for a
//     "deliver" — the intake function after a new request, the sponsor's page
//     after a comment or an approval, the hourly system check as the safety
//     net — and nothing is sent twice: server_alerts_claim() hands each alert
//     to exactly one caller (FOR UPDATE SKIP LOCKED), and server_alert_done()
//     closes it once the email went.
//   - The server's calls carry the x-intake-secret header (INTAKE_DB_SECRET),
//     which every deploy context has; no secret key is needed on previews.
//   - A subscription the browser has ended (HTTP 404/410 from the push
//     service) is switched off in the database; the admin page then says
//     "Alerts off on this device — turn on again".
//   - The new-request alert's email is the intake email itself (email_by
//     "intake"), so it is never sent twice; the email-problem alert's email is
//     the system check's own (email_by "system-check").
import webpush from "web-push";
import { sendViaResend } from "./intake-core.mjs";

export const ALERT_INBOX = "exercises@plan-proof.com";
const SUBJECT_PREFIX = "PlanProof alert — ";

function serverRpc(deps) {
  const env = deps.env;
  return async (name, args) => {
    const headers = { apikey: env.SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" };
    if (env.INTAKE_DB_SECRET) headers["x-intake-secret"] = env.INTAKE_DB_SECRET;
    const res = await deps.fetchFn(`${env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST", headers, body: JSON.stringify(args || {}), signal: AbortSignal.timeout(deps.timeoutMs ?? 15000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${name} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
}

// The notification the phone shows: the title, the next-action line, where it opens.
export function payloadFor(alert, origin) {
  return JSON.stringify({
    title: alert.title, body: alert.body,
    url: alert.url ? new URL(alert.url, origin || "https://plan-proof.com").toString() : (origin || "https://plan-proof.com") + "/admin/",
    tag: `${alert.kind}-${alert.ref_id || alert.id}`,
  });
}

export function emailFor(alert, origin) {
  const url = alert.url ? new URL(alert.url, origin || "https://plan-proof.com").toString() : null;
  return {
    subject: SUBJECT_PREFIX + alert.title,
    text: [alert.body, url ? `Open it: ${url}` : null, "",
      "You receive this email for every PlanProof alert (push notifications are an extra; this email is the record)."].filter((x) => x != null).join("\n"),
  };
}

// Send one push; returns "ok" | "gone" | "failed".
export async function pushOne(deps, target, payload) {
  const send = deps.sendNotification || ((sub, body, opts) => webpush.sendNotification(sub, body, opts));
  try {
    await send({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, payload, {
      TTL: 6 * 3600, urgency: "high",
      vapidDetails: { subject: "mailto:" + ALERT_INBOX, publicKey: deps.env.VAPID_PUBLIC_KEY, privateKey: deps.env.VAPID_PRIVATE_KEY },
    });
    return "ok";
  } catch (err) {
    const code = err && (err.statusCode || err.status);
    return code === 404 || code === 410 ? "gone" : "failed";
  }
}

// Find what is new, claim it, push it, email it, close it. Never throws to the caller
// (an alert must never break the request, the comment or the hourly check).
export async function deliverAlerts(deps) {
  const out = { claimed: 0, pushed: 0, push_failed: 0, emailed: 0, errors: [] };
  const env = deps.env || {};
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) { out.errors.push("database settings missing"); return out; }
  const rpc = serverRpc(deps);
  let claim;
  try { claim = await rpc("server_alerts_claim", {}); } catch (err) { out.errors.push(String(err.message || err)); return out; }
  const alerts = (claim && claim.alerts) || [];
  const targets = (claim && claim.targets) || [];
  const canPush = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
  if (!canPush && alerts.length) out.errors.push("VAPID keys missing — email only");
  out.claimed = alerts.length;
  for (const a of alerts) {
    const gone = [], ok = [];
    let pushed = 0, failed = 0;
    if (canPush) {
      const payload = payloadFor(a, deps.origin);
      for (const t of targets) {
        const r = await pushOne(deps, t, payload);
        if (r === "ok") { pushed++; ok.push(t.id); } else { failed++; if (r === "gone") gone.push(t.id); }
      }
    }
    let emailed = false, emailError = null;
    if (a.email_by === "alerts") {
      try {
        const m = emailFor(a, deps.origin);
        await (deps.sendEmail || sendViaResend)({ to: [ALERT_INBOX], subject: m.subject, text: m.text }, deps);
        emailed = true;
      } catch (err) { emailError = String(err.message || err).slice(0, 400); }
    }
    try { await rpc("server_alert_done", { p_alert: a.id, p_pushed: pushed, p_push_failed: failed, p_emailed: emailed, p_email_error: emailError, p_gone: gone, p_ok: ok }); }
    catch (err) { out.errors.push(String(err.message || err)); }
    out.pushed += pushed; out.push_failed += failed; if (emailed) out.emailed++;
    if (emailError) out.errors.push(emailError);
  }
  return out;
}

// Raise one alert by name (media ready/failed, the hourly email problem) and deliver at once.
export async function raiseAndDeliver(deps, alert) {
  try {
    await serverRpc(deps)("server_raise_alert", { p_kind: alert.kind, p_ref: alert.ref || null, p_submission: alert.submission || null,
      p_title: alert.title, p_body: alert.body, p_url: alert.url || null, p_email_by: alert.email_by || "alerts" });
  } catch (err) { return { claimed: 0, errors: [String(err.message || err)] }; }
  return deliverAlerts(deps);
}
