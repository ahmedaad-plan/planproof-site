// W8 finish (21 November 2026, fix item 25) — the client's thank-you email when the
// client presses "We accept the report" on the report page.
//
// How it holds together (design for failure):
//   - It rides on the "report_accepted" alert: the database hands that alert to exactly
//     one caller (server_alerts_claim), and the thank-you is sent inside that delivery.
//   - Never twice: server_thank_you_begin() logs the email FIRST in sent_emails
//     (kind "thank_you"); a unique index allows one thank-you per request, so a second
//     delivery of the same alert (a retry after a lost write) finds the row and skips.
//   - The facts (address, dates, references) come from the database, never from a page:
//     the address is the one the report email went to.
//   - The internal alert email to PlanProof says whether the thank-you went, so a failed
//     one is seen the same minute (and shows in red on the request, Report block).
//   - Never throws: an alert must never break the client's acceptance.
import { buildBody, resendSend, LOGO_ATTACHMENT } from "./send-email.mjs";

const longDate = (ymd) => {
  const [y, m, d] = String(ymd).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
};

// The message (plain text; buildBody adds the HTML, the sign-off and the logo).
export function thankYouMessage(f) {
  const hello = f.first_name ? `Dear ${f.first_name},` : "Hello,";
  const ref = f.client_ref ? `your client reference ${f.client_ref} (this exercise was ${f.request_no})` : `the reference ${f.request_no}`;
  return [
    hello,
    `Thank you — your exercise report is accepted (${f.request_no}). We recorded your acceptance on ${longDate(f.accepted_on)}.`,
    `The short report and the full report (each in English and Arabic) stay on your private report page until ${longDate(f.keep_until)}. Please download them before then: after that date they are removed, as our privacy policy promises.`,
    `When you plan your next exercise, please quote ${ref}, so we can build on this one.`,
    "Kind regards,",
  ].join("\n\n");
}

export const thankYouSubject = (f) => `Thank you — your exercise report is accepted (${f.request_no})`;

// Returns { sent: true|false, skipped?: reason, to?, error? }.
export async function sendThankYou(deps, rpc, submissionId) {
  if (!submissionId) return { sent: false, skipped: "no request" };
  let f;
  try { f = await rpc("server_thank_you_begin", { p_submission: submissionId }); }
  catch (err) { return { sent: false, error: "could not log it: " + String(err.message || err).slice(0, 200) }; }
  if (!f || f.skip) return { sent: false, skipped: (f && f.skip) || "no answer" };
  if (!deps.env.RESEND_API_KEY) {
    await rpc("server_thank_you_done", { p_email: f.email_id, p_status: "failed", p_error: "RESEND_API_KEY missing on the server" }).catch(() => null);
    return { sent: false, to: f.to, error: "RESEND_API_KEY missing" };
  }
  const { text, html } = buildBody(thankYouMessage(f), null, null);
  let r;
  try { r = await (deps.resendSend || resendSend)(deps, { to: f.to, subject: thankYouSubject(f), text, html, attachments: [LOGO_ATTACHMENT] }); }
  catch (err) { r = { ok: false, error: String(err.message || err) }; }
  await rpc("server_thank_you_done", { p_email: f.email_id, p_status: r.ok ? "sent" : "failed", p_resend_id: r.id || null, p_error: r.ok ? null : String(r.error).slice(0, 900), p_from: r.from || null }).catch(() => null);
  return r.ok ? { sent: true, to: f.to } : { sent: false, to: f.to, error: String(r.error).slice(0, 300) };
}

// The line added to PlanProof's own alert email.
export function thankYouLine(t) {
  if (!t) return null;
  if (t.sent) return `Thank-you email sent to the client (${t.to}).`;
  if (t.skipped === "already sent") return "The thank-you email had already gone to the client.";
  if (t.skipped) return `No thank-you email to the client: ${t.skipped}.`;
  return `THE THANK-YOU EMAIL TO THE CLIENT FAILED${t.to ? " (" + t.to + ")" : ""}: ${t.error}. Send a short thank-you by hand from Zoho Mail.`;
}
