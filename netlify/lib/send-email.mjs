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

const KINDS = new Set(["review", "confirmation", "invitation", "report", "test"]);
// A test copy to PlanProof itself (v7.1): no private link; the place where it would go is marked.
export const TEST_LINK_TEXT = "[TEST COPY — the sponsor's private link appears here]";
// v7.3 (remark 10): the test copy says at once why it has no working link.
export const TEST_INTRO = "TEST COPY — this is how the sponsor's email will look. It has no working link: the sponsor's private link is made only when you press Send on the admin page.";
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
// build 3 finish (Ahmed, 21 Nov 2026): the logo and the name under every client email (HTML part; the
// plain-text part keeps the written sign-off). The logo travels inside the email (an inline image, cid:) so mail
// apps that block outside pictures — Zoho, Outlook, Gmail for a new sender — still show it.
export const LOGO_ATTACHMENT = { filename: "planproof-logo.png", content: "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nfD6nDIxM6Iy+Lnb82WmSWNjI9+84Xr++p9/znr/LW9s5drx1+H1ek8oGfuEADYMg9bWNq65+kpeXrkMOxmQFkJQXVPL8MtH09rWhtPp7D6HpSyJZGRM9+BKo1gsllg19cYGynv3Tq8oMgyD8ZOn8er6jRQUBE8oe1+eaKp9YUGQteteZeGipRhGIiaslKKyopzHH32QSKTjhIZYqsRgT07rk5x87ejo4I+PPkhFeXl6NZRhGCxYtIS169afMLiJ9R6+4K9P+GVlYkh984a5+LzehE+vFBcMPA+lFC+tXE2goOC0WRzjcDhoqK3lvnvv5oe33IyVjDkIIaivb2DuDd8mblk5x37zArAGXC4nNTU11NbVM3P6VOykF2QrxTVXjebD/fvZuvVNAsHgKQfZ4XBQX1fHP934TR576IGkxybTptmtP76DTZu3EOyhd+0RCVZK4ff72frmW5RXlDN86JA0yFprrps8kW3v/p33tv+DQDBwykBOgTtx4gT+67lnEVKkI4KmafKnZ/6D397/ACXdVMw9ruSONne01sRiMdasXsGIyy/Dsux0BZRQKMTseTeyZs1aSstKicfjpwDceiZMGMuC558jEPCnK5yYpsGW17cybtJUnE5nui+nVeKJTvruQghu+NZNVFV9iGka6TyKQCDAssXzmTlzGvU1tZimeVLqUAohME2T+poaZs2aztKF8wkE/On3Mk2DqqoPueFbN2UtreV0zOxRSuHxuKmtrWf67HnU1NRmWRYet5sFz/+F227/MQ0NjWney1dLubsNDY3cceftLHj+L7iTMeuUxVBdU8P02fOoq6vH43H3OH31eOqUZdkEgwH2VO1lyoy5aZBTnZJS8siD9/PUE4+itSYUCuFwOHpUmoUQOBwmoVAIgKeffJyHHvhdeuinPmx1TQ1TZsxlT9VeAsFAskgTp39uWqKuRAF/276dcZOmsW//x2k3NGU//+B7/8z6V1ZxySWDqa+tS0tUT0it1pr62nqGDrmE115Zzfdvvinr2aZpsm//x4yfNI3t29+jsLCgx5RaVwCrfIFcVFjIrt17GDtxCm9teyfD109o7ku+MZj1r6zmV/fdDUBLSwuGYWB0w/40pMQwDFpaWtFac++9d/HqmlUMHnxx1jNN0+Stbe8wduIUdu2uorCwMG/gAspweYM/FwJHvlawe70empqaeH7+As7o149Bgy5K00EiOOTgqitHM2nieA4d+oT3P/iAeDyO2+0+LoWTqi0cam+noyPK5EkTeO7ZZ5g3d3ZayaaUl5SS//tfL3DDt26ipaWVQCCQT3DRmg7D7Qv8SCBTyWUiHyC7XC5s22bh4iW0t4cZNWoEDocjHbtQSlFR3psbrp/DkG8M5sDBQ+zeU0U8HksD3VV5mJT5F4l0MGLE5Tz20AP86p676N27LOvehmEQ7ezk7nt/zS/uvg+Hw4Hb7c5nhYBEyrfQdaKgpM8mKcXIEylMl0t58KbGRi677FIef+QPDB1ySZoXE1ItkFKgNSxdvoI/Pf3vbNi0hXg8hj8QwJmsxhqLxQi1t+NyOhk54gp+eMvNzJoxLT39REbQBuDtbe/ykzt+xtatb1Hcqzgd1MljO1KYrrC08mEh5O09VVrxeEKEbW1tuN1ubvsft/KvP72dQCCQ1u6pYZ9qr23YxJ+f/T+8snYddXX1yWTD3owfO4Z//u63uXLUyKzgUypSJoSgLRTigQcf4bE/Pkk0GiUYDOaVEroorfioKCrpMxkpXuzp4qDH4k3btmlpbubCCy/kV/fcxexZ05OUotE6saLDSAIFsP/jA8xfsAgpJfPmzOKMZEkxrTW2SqRWCSnTecGLFi/jN//2W95//wMKi4rSz+SkrSATAq0nidLSUn9MO3dIKfrlmya64tFwOEwsFufqq0bzszt/wvix12bXMUtSy9GWhW3bifCl1lkZ9i+vWcsfHn6M9Rs24nQkSomd5NpBKXo46BSx8xMFmkv6PCYN+eN8F2j+rMC3EIK2tjaEEIy7dgw/vOVmJk4Yl1XI82iAMqsKKqVY/dIannz6z7yy9lW01gSDwSza4WSWGc8s0AwQ6FU5wJDig1O5dU7KQWhrCwGaYUOHcPN3v8PM6VMoKirq8j9Nzc0sXbaCf3/2L7y97R1AEAwGEvHoU1NDKFViXNlKXxhqPLw7XSS/sLTyGSGM752KIvlHAw3Q3t5OLBan/5lfZ+KEccydPYORI64AYNPm11m4eCmrXlrDvn37cTod+P3+LEV3ipolhDS1tv/cUn/4+6k8GQngr6goNuPy/VO5zUNX1JEq9OxyORk2dEi6yGhnZwyf34fb5TpVVPCZ2zxYDnVhe3V106c2Kikq6TMJKVaeDhuVZHNtIlchHA4DiTptqRyM06TwXXqjEkvpSaGGT1anMDUyLjCikdAepycQl1KOBW2lZs9PfdG4hGPgcrnSM9RK6dNphy5LCOmwlf5lqOGTZzN35jKOTnTsjIQ2uL3+AiGMEcldCThdduA6CR5YN2gBLaQ0tVYPtTZ8cm9qw63P2o0rJckvuT1+W0g5JmnpW3yxN+br3r5yQhhCCKmVurel4fA9GdtQfuZ2Z5kgb3C7fX9HiNFCygK0/groIxv2GSIR6juMUje2NFY/c7wb9mWD3NG+U/rczxta+oGLhJROkZFJmsPeoP/dt5xUCX0rRBLYToF+Jkbsn0INte90Z8vJrjZNHagSm6ZOQ4gzxZds09SkW74P9DJD6acbG6t3neimqV1u+1tcXBzU0jNSCTEerYd+Kbb9FWKb1PplqaObGhsbQ7ls+/v/AUdsNLlhjDD5AAAAAElFTkSuQmCC", content_type: "image/png", content_id: "planproof-logo" };
export const SIGNATURE_HTML = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:6px;border-top:1px solid #e3e6ea"><tr>` +
  `<td style="padding:14px 12px 0 0;vertical-align:middle"><img src="cid:planproof-logo" width="44" height="44" alt="PlanProof" style="display:block;border:0;border-radius:10px"></td>` +
  `<td style="padding:14px 0 0;vertical-align:middle;font-family:Arial,Helvetica,sans-serif"><div style="font-size:17px;font-weight:700;color:#11161d">Plan<span style="color:#d84a3a">Proof</span></div>` +
  `<div style="font-size:12px;color:#6b7480">Business continuity exercises · <a href="https://plan-proof.com" style="color:#6b7480">plan-proof.com</a></div></td></tr></table>`;
// "Kind regards, / PlanProof" or "Kind regards, / Ahmed" becomes "Kind regards, / The PlanProof team" (an email
// address line under it stays); a message with no closing gets one. Never two sign-offs.
const CLOSING = /^(kind regards|best regards|warm regards|regards|best wishes|many thanks|thank you|thanks|sincerely|yours sincerely)[,.!]?$/i;
export function withTeamSignOff(text) {
  const paras = String(text).replace(/\s+$/, "").split(/\n\s*\n/);
  const last = paras[paras.length - 1].split("\n").map((l) => l.trim());
  if (CLOSING.test(last[0])) {
    const mail = last.slice(1).filter((l) => /@/.test(l));
    paras[paras.length - 1] = [last[0].replace(/[,.!]?$/, ","), "The PlanProof team", ...mail].join("\n");
    // an earlier closing just above (e.g. a draft's old one) is dropped: one sign-off only
    while (paras.length > 2 && CLOSING.test(paras[paras.length - 2].split("\n")[0].trim())) paras.splice(paras.length - 2, 1);
    return paras.join("\n\n");
  }
  if (/PlanProof team/i.test(text)) return text;
  return paras.join("\n\n") + "\n\nKind regards,\nThe PlanProof team";
}
// Fix 68 (Ahmed, 26 Nov 2026): the report email has two buttons — the short report and the full report.
// Each goes to the same private page, opened at that copy (…/c/<token>?copy=short|full).
export const REPORT_BUTTONS = [{ copy: "short", label: "Open the short report" }, { copy: "full", label: "Open the full report" }];
export const reportButtonHref = (link, copy) => `${link}?copy=${copy}`;
const BUTTONS_TOKEN = "\u0000PP_REPORT_BUTTONS\u0000";
export function buildBody(message, link, expiresAt, opts = {}) {
  const linkLine = link ? `${link}${expiresAt ? ` (valid until ${longDate(expiresAt)})` : ""}` : "";
  let text = String(message || "").replace(/\r\n/g, "\n").trim();
  if (link && opts.reportButtons) {
    // the paragraph with the marker (or a new one after the first paragraph) becomes the two buttons
    if (text.includes(LINK_MARKER)) text = text.split(LINK_MARKER).join(BUTTONS_TOKEN);
    else { const parts = text.split(/\n\s*\n/); parts.splice(Math.min(1, parts.length), 0, BUTTONS_TOKEN); text = parts.join("\n\n"); }
    text = withTeamSignOff(text);
    const until = expiresAt ? ` (the link works until ${longDate(expiresAt)})` : "";
    const plain = REPORT_BUTTONS.map((b) => `${b.label}: ${reportButtonHref(link, b.copy)}`).join("\n") + until;
    const btn = (b, dark) => `<a href="${esc(reportButtonHref(link, b.copy))}" style="display:inline-block;margin:0 10px 10px 0;padding:12px 20px;border-radius:8px;font-weight:700;text-decoration:none;` +
      (dark ? "background:#11161d;color:#ffffff" : "background:#ffffff;color:#11161d;border:2px solid #11161d") + `">${esc(b.label)}</a>`;
    const buttonsHtml = `<p style="margin:0 0 14px">${btn(REPORT_BUTTONS[0], true)}${btn(REPORT_BUTTONS[1], false)}${until ? `<br><span style="font-size:13px;color:#6b7480">${esc(until.trim())}</span>` : ""}</p>`;
    const paras = text.split(/\n\s*\n/);
    const html = paras.map((p) => p.includes(BUTTONS_TOKEN) ? buttonsHtml
      : `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>").replace(/\*\*(.+?)\*\*/gs, "<strong>$1</strong>")}</p>`).join("");
    return { text: text.split(BUTTONS_TOKEN).join(plain).replace(/\*\*(.+?)\*\*/gs, "$1"),
      html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1d2433;max-width:620px">${html}${SIGNATURE_HTML}</div>` };
  }
  if (link) {
    if (text.includes(LINK_MARKER)) text = text.split(LINK_MARKER).join(linkLine);
    else {
      const parts = text.split(/\n\s*\n/);
      parts.splice(Math.min(1, parts.length), 0, `Open it here: ${linkLine}`);
      text = parts.join("\n\n");
    }
  }
  // build 3 finish (Ahmed, 21 Nov 2026): every client email ends with "The PlanProof team" — added if the box lost it
  text = withTeamSignOff(text);
  // v7.3 (remark 21): **…** is bold in the HTML email; the plain-text part shows it without the stars
  const html = text.split(/\n\s*\n/).map((p) => `<p style="margin:0 0 14px">${esc(p).replace(/\n/g, "<br>")
    .replace(link ? new RegExp(esc(link).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : /$^/, `<a href="${esc(link)}">${esc(link)}</a>`).replace(/\*\*(.+?)\*\*/gs, "<strong>$1</strong>")
    // fix 36 (23 Nov 2026): the review deadline is bold without ** in the box
    .replace(/(?<!<strong>)at least 10 working days before the exercise date/g, "<strong>$&</strong>")
    // live-experience (23 Nov 2026): the example page is a link in the HTML email too
    .replace(/https:\/\/plan-proof\.com\/live-example(?![\w\/-])/g, (u) => `<a href="${u}">${u}</a>`)}</p>`).join("");
  return { text: text.replace(/\*\*(.+?)\*\*/gs, "$1"), html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1d2433;max-width:620px">${html}${SIGNATURE_HTML}</div>` };
}

// One Resend send; tries the senders in order on a sender (4xx, not 429) refusal.
// W8 build 2 (D.8): the calendar file for the confirmation and the invitation. The time is
// UAE time, written with its zone (Asia/Dubai, no daylight saving: UTC+4 all year), so a
// calendar abroad shows the right hour. One event; its UID stays the same for one exercise,
// so a re-sent invitation updates the event instead of adding a second one (SEQUENCE grows).
export const ICS_JOIN_MARKER = "[the join link]";
export const ICS_CHECK_MARKER = "[the connection check link]";
const icsEsc = (s) => String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const fold = (line) => { const out = []; let s = line; while (Buffer.byteLength(s, "utf8") > 74) { let n = 74; while (Buffer.byteLength(s.slice(0, n), "utf8") > 74) n--; out.push(s.slice(0, n)); s = " " + s.slice(n); } out.push(s); return out.join("\r\n"); };
export function buildIcs({ uid, date, time, minutes, title, location, description, sequence = 0, stampMs = Date.now() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) || !/^\d{2}:\d{2}$/.test(String(time || ""))) throw new SendError(400, "The exercise date and time are not set.");
  const [y, mo, d] = date.split("-").map(Number), [hh, mm] = time.split(":").map(Number);
  // UAE local → UTC is −4 hours (no daylight saving)
  const startUtc = Date.UTC(y, mo - 1, d, hh - 4, mm), endUtc = startUtc + (Number(minutes) || 90) * 60000;
  const loc = (ms) => { const x = new Date(ms + 4 * 3600000); return x.toISOString().replace(/[-:]/g, "").slice(0, 15); };
  const utc = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//PlanProof//Exercise//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VTIMEZONE", "TZID:Asia/Dubai", "X-LIC-LOCATION:Asia/Dubai", "BEGIN:STANDARD", "TZOFFSETFROM:+0400", "TZOFFSETTO:+0400", "TZNAME:+04", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE",
    "BEGIN:VEVENT", `UID:${uid}@plan-proof.com`, `DTSTAMP:${utc(stampMs)}`, `SEQUENCE:${sequence}`,
    `DTSTART;TZID=Asia/Dubai:${loc(startUtc)}`, `DTEND;TZID=Asia/Dubai:${loc(endUtc)}`,
    `SUMMARY:${icsEsc(title)}`, `LOCATION:${icsEsc(location)}`, `DESCRIPTION:${icsEsc(description)}`, "STATUS:CONFIRMED", "TRANSP:OPAQUE",
    "END:VEVENT", "END:VCALENDAR"];
  return lines.map(fold).join("\r\n") + "\r\n";
}

export async function resendSend(deps, { to, subject, text, html, attachments }) {
  const tries = [];
  for (const from of FROM_CANDIDATES) {
    let res;
    try {
      res = await deps.fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${deps.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], reply_to: REPLY_TO, subject, text, html, ...(attachments && attachments.length ? { attachments } : {}) }),
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
  const rec = await rpc("admin_record_email", { p_submission: body.submission_id, p_kind: kind, p_to: to, p_subject: subject, p_version: (kind === "review" || kind === "test") && UUID.test(String(body.version_id || "")) ? body.version_id : null });
  const link = rec && rec.token ? linkFor(deps.origin, rec.token) : null;
  if ((kind === "review" || kind === "report") && !link) throw new SendError(500, "The private link was not made — nothing was sent.");
  let attachments = null, msg = message;
  if (kind === "confirmation" || kind === "invitation") {
    // the facts come from the database (admin_record_email), never from the page
    const x = rec.exercise || {};
    if (!x.session_id) throw new SendError(400, "Set up the exercise first.");
    const join = `${String(deps.origin).replace(/\/+$/, "")}/play/join.html?session=${x.session_id}`;
    const check = `${String(deps.origin).replace(/\/+$/, "")}/play/check.html`;
    msg = msg.split(ICS_JOIN_MARKER).join(join).split(ICS_CHECK_MARKER).join(check);
    if (kind === "confirmation" && msg.includes(join)) throw new SendError(400, "The confirmation must not carry the join link — it goes in the invitation.");
    const ics = buildIcs({ uid: `exercise-${x.session_id}`, date: x.date, time: x.time, minutes: x.minutes, sequence: Math.floor((deps.nowMs ?? Date.now()) / 60000) % 100000,
      title: `${kind === "invitation" ? "Business continuity exercise" : "PlanProof exercise"} — ${x.organisation || ""}`.replace(/ — $/, ""),
      location: x.venue, description: kind === "invitation" ? `Join on the day: ${join}\nPlease bring a charged phone or laptop.` : `PlanProof tabletop exercise (${x.minutes} minutes). Reference ${x.request_no}.` });
    attachments = [{ filename: kind === "invitation" ? "exercise-invitation.ics" : "exercise.ics", content: Buffer.from(ics, "utf8").toString("base64"), content_type: "text/calendar; charset=utf-8" }];
  }
  if (/facilitator-test\.html|[?&]token=/.test(msg)) throw new SendError(400, "The facilitator link must never be emailed.");
  const { text, html } = kind === "test"
    ? buildBody(TEST_INTRO + "\n\n" + msg.split(LINK_MARKER).join(TEST_LINK_TEXT), null, null)
    : buildBody(msg, link, rec.expires_at, { reportButtons: kind === "report" });

  // 2. send
  if (html.includes("cid:planproof-logo")) attachments = (attachments || []).concat([LOGO_ATTACHMENT]);
  const sent = await resendSend(deps, { to, subject: kind === "test" && !/^TEST\b/.test(subject) ? "TEST — " + subject : subject, text, html, attachments });

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
  const problems = rows.filter((r) => r.kind !== "test").filter((r) => ["bounced", "complained", "failed", "unknown"].includes(r.status)
    || (r.status !== "delivered" && nowMs - Date.parse(r.created_at) > NOT_DELIVERED_AFTER_MS));
  return { skipped: false, checked: rows.length, problems };
}
