// W8 (11 November 2026) — emails the admin page sends to a client: the scenario
// for review (with its private client link), and later the confirmation, the
// invitation and the report (build chats 2 and 3). Design: w8-design.md D.3.
//
// The order is what keeps it honest:
//   1. the database logs the email FIRST (status "sending") and, for a review,
//      makes or reuses the version's private link — admin_record_email, called
//      with the admin's own sign-in, so only a signed-in admin with the second
//      factor can send anything;
//   2. Resend sends it, from exercises@plan-proof.com — or, if Resend refuses
//      that domain, from exercises@notify.plan-proof.com (the verified one) with
//      Reply-To exercises@plan-proof.com;
//   3. the result goes back to the log (admin_email_status); a review that has
//      really gone freezes its version.
// If step 3 cannot be written, the log keeps "sending" and the next poll marks
// it "unknown" — the page then says so and offers "Copy the link".
//
// Delivery status: there is no webhook (nothing for Ahmed to configure). The
// page asks for a poll when it opens a request; the hourly system check polls
// every email of the last 7 days that has no final answer yet.

export const FROM_CANDIDATES = ["PlanProof <exercises@plan-proof.com>", "PlanProof <exercises@notify.plan-proof.com>"];
export const REPLY_TO = "exercises@plan-proof.com";
export const LINK_MARKER = "[the private link]";
export const UNKNOWN_AFTER_MS = 10 * 60 * 1000;   // "sending" with no answer after 10 minutes → unknown
export const NOT_DELIVERED_AFTER_MS = 60 * 60 * 1000; // design D.3: alert after 1 hour

const KINDS = new Set(["review", "confirmation", "invitation", "report"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class SendError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Supabase with the admin's own sign-in (publishable key + the admin's access token).
function userRpc(deps, token) {
  return async (name, args) => {
    const res = await deps.fetchFn(`${deps.env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: deps.env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args || {}),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try { const j = JSON.parse(text); msg = j.message || j.hint || text; } catch { /* plain text */ }
      throw new SendError(res.status === 401 || res.status === 403 ? 401 : 400, String(msg).slice(0, 400));
    }
    return text ? JSON.parse(text) : null;
  };
}
// Supabase with the server's secret key (the hourly check, production only).
function serviceRpc(deps) {
  return async (name, args) => {
    const res = await deps.fetchFn(`${deps.env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { apikey: deps.env.SUPABASE_SECRET_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(args || {}),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${name} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const linkFor = (origin, token) => `${String(origin).replace(/\/+$/, "")}/c/${token}`;
const longDate = (iso) => new Date(iso).toLocaleDateString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "long", year: "numeric" });

// The message as Ahmed left it in the box, with the link put where the marker is
// (or, if he deleted the marker, after the first paragraph) — the link itself is
// never typed by hand. Returns { text, html }.
export function buildBody(message, link, expiresAt) {
  const linkLine = link ? `${link}${expiresAt ? ` (valid until ${longDate(expiresAt)})` : ""}` : "";
  let text = String(message || "").replace(/\r\n/g, "\n").trim();
  if (link) {
    if (text.includes(LINK_MARKER)) text = text.split(LINK_MARKER).join(linkLine);
    else {
      const parts = text.split(/\n\s*\n/);
      parts.splice(Math.min(1, parts.length), 0, `Open it here: ${linkLine}`);
      text = parts.join("\n\n");
    }
  }
  const html = text.split(/\n\s*\n/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")
    .replace(link ? new RegExp(esc(link).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : /$^/, `<a href="${esc(link)}">${esc(link)}</a>`)}</p>`).join("");
  return { text, html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1d2433;max-width:620px">${html}</div>` };
}

// One Resend send; tries the senders in order on a sender (4xx, not 429) refusal.
export async function resendSend(deps, { to, subject, text, html }) {
  const tries = [];
  for (const from of FROM_CANDIDATES) {
    let res;
    try {
      res = await deps.fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${deps.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], reply_to: REPLY_TO, subject, text, html }),
        signal: AbortSignal.timeout(deps.timeoutMs ?? 15000),
      });
    } catch (err) { tries.push(`${from}: ${err.message}`); break; }
    const body = await res.text();
    if (res.ok) {
      let id = null; try { id = JSON.parse(body).id || null; } catch { /* ignore */ }
      return { ok: true, id, from };
    }
    tries.push(`${from}: HTTP ${res.status} ${body.slice(0, 160)}`);
    if (!(res.status >= 400 && res.status < 500 && res.status !== 429)) break;
  }
  return { ok: false, error: tries.join(" | ").slice(0, 900) };
}

// POST /api/send-email {action:"send", submission_id, kind, version_id?, to, subject, message}
export async function sendClientEmail(deps, token, body) {
  const { env } = deps;
  if (!token) throw new SendError(401, "Sign in again first.");
  if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) throw new SendError(500, "The database settings are missing on the server.");
  if (!env.RESEND_API_KEY) throw new SendError(500, "The email key (RESEND_API_KEY) is missing on the server.");
  const kind = String(body.kind || "");
  if (!KINDS.has(kind)) throw new SendError(400, "Unknown kind of email.");
  if (!UUID.test(String(body.submission_id || ""))) throw new SendError(400, "Which request? (missing).");
  if (kind === "review" && !UUID.test(String(body.version_id || ""))) throw new SendError(400, "Which version? (missing).");
  const to = String(body.to || "").trim();
  const subject = String(body.subject || "").trim().slice(0, 300);
  const message = String(body.message || "").trim();
  if (!subject) throw new SendError(400, "The subject is empty.");
  if (!message) throw new SendError(400, "The message is empty.");
  if (message.length > 20000) throw new SendError(400, "The message is too long.");
  if (!deps.origin) throw new SendError(500, "The page address is unknown.");

  const rpc = userRpc(deps, token);
  // 1. log first (and make or reuse the private link); the database checks admin, address, version
  const rec = await rpc("admin_record_email", { p_submission: body.submission_id, p_kind: kind, p_to: to, p_subject: subject, p_version: kind === "review" ? body.version_id : null });
  const link = rec && rec.token ? linkFor(deps.origin, rec.token) : null;
  if ((kind === "review" || kind === "report") && !link) throw new SendError(500, "The private link was not made — nothing was sent.");
  const { text, html } = buildBody(message, link, rec.expires_at);

  // 2. send
  const sent = await resendSend(deps, { to, subject, text, html });

  // 3. record the answer (three tries; the poll repairs a lost write)
  const status = sent.ok ? "sent" : "failed";
  let recorded = null, recErr = null;
  for (let i = 0; i < 3 && !recorded; i++) {
    try { recorded = await rpc("admin_email_status", { p_email: rec.email_id, p_status: status, p_resend_id: sent.id || null, p_error: sent.ok ? null : sent.error, p_from: sent.from || null }); }
    catch (err) { recErr = err; if (deps.sleep) await deps.sleep(400 * (i + 1)); }
  }
  return {
    ok: sent.ok, email_id: rec.email_id, status, from: sent.from || null, link, expires_at: rec.expires_at,
    version_no: rec.version_no, error: sent.ok ? null : "The email service did not accept it: " + sent.error,
    recorded: !!recorded, record_error: recorded ? null : (recErr && recErr.message) || null,
  };
}

// Resend's last event → our status word.
export function mapEvent(ev) {
  const e = String(ev || "").toLowerCase();
  if (e === "delivered" || e === "opened" || e === "clicked") return "delivered";
  if (e === "bounced") return "bounced";
  if (e === "complained") return "complained";
  if (e === "delivery_delayed") return "delayed";
  if (e === "failed" || e === "canceled") return "failed";
  if (e === "sent" || e === "queued" || e === "scheduled") return "sent";
  return null;
}

// Asks Resend about every email still without a final answer; writes changes back.
// rpc: the admin's (page) or the service's (hourly check). Returns the rows with their new status.
export async function pollEmails(deps, rpc, listName, statusName, args = {}) {
  const rows = (await rpc(listName, args)) || [];
  const nowMs = deps.nowMs ?? Date.now();
  const out = [];
  for (const r of rows) {
    let next = null, error = null;
    if (!r.resend_id) {
      if (r.status === "sending" && nowMs - Date.parse(r.created_at) > UNKNOWN_AFTER_MS) { next = "unknown"; error = "The send was started but its answer was never recorded — check the mailbox, or Copy the link and send it yourself."; }
    } else {
      try {
        const res = await deps.fetchFn(`https://api.resend.com/emails/${encodeURIComponent(r.resend_id)}`, {
          headers: { Authorization: `Bearer ${deps.env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(deps.timeoutMs ?? 10000) });
        if (res.ok) next = mapEvent((await res.json()).last_event);
      } catch { /* try again next time */ }
    }
    if (next && next !== r.status) {
      const args2 = statusName === "service_email_status"
        ? { p_email: r.id, p_status: next, p_resend_id: null, p_error: error }
        : { p_email: r.id, p_status: next, p_resend_id: null, p_error: error, p_from: null };
      try { await rpc(statusName, args2); } catch { /* next time */ }
    }
    out.push({ ...r, status: next || r.status });
  }
  return out;
}

export async function pollForPage(deps, token, body) {
  if (!token) throw new SendError(401, "Sign in again first.");
  const sub = UUID.test(String(body.submission_id || "")) ? body.submission_id : null;
  const rows = await pollEmails(deps, userRpc(deps, token), "admin_emails_to_poll", "admin_email_status", { p_submission: sub });
  return { ok: true, checked: rows.length, rows: rows.map((r) => ({ id: r.id, status: r.status })) };
}

// The hourly system check (production, secret key). Returns the problem emails:
// bounced / complained / failed, or still not delivered one hour after sending.
export async function pollForSystemCheck(deps) {
  if (!deps.env.SUPABASE_SECRET_KEY || !deps.env.RESEND_API_KEY) return { skipped: true, problems: [] };
  const nowMs = deps.nowMs ?? Date.now();
  const rows = await pollEmails(deps, serviceRpc(deps), "service_emails_to_poll", "service_email_status");
  const problems = rows.filter((r) => ["bounced", "complained", "failed", "unknown"].includes(r.status)
    || (r.status !== "delivered" && nowMs - Date.parse(r.created_at) > NOT_DELIVERED_AFTER_MS));
  return { skipped: false, checked: rows.length, problems };
}
