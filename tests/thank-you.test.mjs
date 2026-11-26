// W8 finish (21 November 2026, fix item 25): the client's thank-you email when the client presses
// "We accept the report". It rides on the report_accepted alert; the database logs it first and
// allows one per request. Supabase and Resend are faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deliverAlerts } from "../netlify/lib/alerts.mjs";
import { thankYouMessage, thankYouSubject, sendThankYou, thankYouLine } from "../netlify/lib/thank-you.mjs";

const SUB = "11111111-1111-4111-8111-111111111111";
const ENV = { SUPABASE_URL: "https://sb.test", SUPABASE_PUBLISHABLE_KEY: "pk", RESEND_API_KEY: "rk", INTAKE_DB_SECRET: "isec", VAPID_PUBLIC_KEY: "BPub", VAPID_PRIVATE_KEY: "priv" };
const FACTS = { email_id: "te1", to: "marwan@zephyr-quay.invalid", request_no: "R-2026-9902", client_ref: "PP-2026-9999", first_name: "Marwan", accepted_on: "2026-11-21", keep_until: "2026-11-28" };

// A fake database that behaves like server_thank_you_begin: one thank-you per request.
function world(over = {}) {
  const w = { alerts: [], done: [], tyDone: [], resend: [], internal: [], thankYouRows: 0, resendDown: false, ...over };
  w.fetchFn = async (url, init = {}) => {
    if (url.startsWith("https://sb.test/rest/v1/rpc/")) {
      assert.equal(init.headers["x-intake-secret"], "isec", "server calls carry the intake secret");
      const name = url.split("/").pop(); const args = JSON.parse(init.body || "{}");
      if (name === "server_alerts_claim") { const a = w.alerts.filter((x) => !x.claimed); a.forEach((x) => { x.claimed = true; }); return Response.json({ alerts: a, targets: [] }); }
      if (name === "server_alert_done") { w.done.push(args); const a = w.alerts.find((x) => x.id === args.p_alert); if (a && !args.p_emailed) a.claimed = false; return Response.json({ ok: true }); }
      if (name === "server_thank_you_begin") {
        assert.equal(args.p_submission, SUB);
        if (w.notAccepted) return Response.json({ skip: "the client has not accepted the report on the page" });
        if (w.thankYouRows > 0) return Response.json({ skip: "already sent" });
        w.thankYouRows++; return Response.json(w.facts || FACTS);
      }
      if (name === "server_thank_you_done") { w.tyDone.push(args); return Response.json({ ok: true }); }
      throw new Error("unexpected rpc " + name);
    }
    if (url === "https://api.resend.com/emails") {
      if (w.resendDown) return new Response("server error", { status: 500 });
      w.resend.push(JSON.parse(init.body)); return Response.json({ id: "re_" + w.resend.length });
    }
    throw new Error("unexpected " + url);
  };
  w.sendEmail = async (m) => { if (w.internalDown) throw new Error("Email not sent: down"); w.internal.push(m); };
  return w;
}
const deps = (w) => ({ fetchFn: w.fetchFn, env: ENV, origin: "https://plan-proof.com", sendEmail: w.sendEmail });
const ACCEPTED = { id: "a1", kind: "report_accepted", ref_id: SUB, submission_id: SUB, title: "R-2026-9902 · the client accepted the report",
  body: "Marwan Testperson accepted the report — press Client accepted the report", url: "/admin/#request/" + SUB, email_by: "alerts" };

test("the thank-you text: accepted on <date>, both copies until <date> (download them), quote the client reference; ends Kind regards, The PlanProof team", () => {
  const m = thankYouMessage(FACTS);
  assert.match(m, /^Dear Marwan,/);
  assert.match(m, /Thank you — your exercise report is accepted \(R-2026-9902\)\. We recorded your acceptance on 21 November 2026\./);
  assert.match(m, /The short report and the full report \(each in English and Arabic\) stay on your private report page until 28 November 2026\. Please download them/); // fix 68
  assert.match(m, /please quote your client reference PP-2026-9999 \(this exercise was R-2026-9902\)/);
  assert.equal(thankYouSubject(FACTS), "Thank you — your exercise report is accepted (R-2026-9902)");
  // no client reference yet → the request number is quoted
  assert.match(thankYouMessage({ ...FACTS, client_ref: null, first_name: null }), /^Hello,[\s\S]*please quote the reference R-2026-9902,/);
});

test("the client accepts → ONE thank-you to the report email's address, with the logo inline and the team sign-off; the internal alert says it went", async () => {
  const w = world({ alerts: [{ ...ACCEPTED }] });
  const out = await deliverAlerts(deps(w));
  assert.equal(w.resend.length, 1);
  const e = w.resend[0];
  assert.deepEqual(e.to, ["marwan@zephyr-quay.invalid"]);
  assert.equal(e.subject, "Thank you — your exercise report is accepted (R-2026-9902)");
  assert.match(e.text, /Kind regards,\nThe PlanProof team$/);
  assert.match(e.html, /cid:planproof-logo/);
  assert.ok(e.attachments.some((a) => a.content_id === "planproof-logo" && a.content_type === "image/png"), "the logo travels inside the email");
  assert.equal(e.reply_to, "exercises@plan-proof.com");
  assert.doesNotMatch(e.text + e.html, /\/c\/|token|facilitator/i, "no private link in the thank-you");
  assert.deepEqual(w.tyDone, [{ p_email: "te1", p_status: "sent", p_resend_id: "re_1", p_error: null, p_from: "PlanProof <exercises@plan-proof.com>" }]);
  // the internal alert to PlanProof stays plain, and says the thank-you went
  assert.equal(w.internal.length, 1);
  assert.deepEqual(w.internal[0].to, ["exercises@plan-proof.com"]);
  assert.equal(w.internal[0].html, undefined, "internal alert stays plain text");
  assert.match(w.internal[0].text, /Thank-you email sent to the client \(marwan@zephyr-quay\.invalid\)\./);
  assert.equal(out.thank_you.sent, true);
});

test("never twice: the alert delivered again (internal email failed, retried) → the thank-you is skipped the second time", async () => {
  const w = world({ alerts: [{ ...ACCEPTED }], internalDown: true });
  await deliverAlerts(deps(w));
  assert.equal(w.resend.length, 1); assert.equal(w.done[0].p_emailed, false);
  w.internalDown = false;
  const again = await deliverAlerts(deps(w));
  assert.equal(again.claimed, 1, "the alert itself is retried");
  assert.equal(w.resend.length, 1, "but the client gets ONE thank-you");
  assert.match(w.internal[0].text, /had already gone to the client/);
});

test("other alerts never send a thank-you", async () => {
  const w = world({ alerts: [{ ...ACCEPTED, kind: "report_comment", id: "a2" }, { ...ACCEPTED, kind: "sponsor_approval", id: "a3" }] });
  await deliverAlerts(deps(w));
  assert.equal(w.resend.length, 0); assert.equal(w.thankYouRows, 0);
});

test("the email service refuses → logged as failed, the alert is still emailed and says FAILED (send by hand); deliver never throws", async () => {
  const w = world({ alerts: [{ ...ACCEPTED }], resendDown: true });
  const out = await deliverAlerts(deps(w));
  assert.equal(w.tyDone[0].p_status, "failed"); assert.match(w.tyDone[0].p_error, /HTTP 500/);
  assert.match(w.internal[0].text, /THE THANK-YOU EMAIL TO THE CLIENT FAILED \(marwan@zephyr-quay\.invalid\)[\s\S]*by hand from Zoho Mail/);
  assert.equal(w.done[0].p_emailed, true, "the internal alert still went");
  assert.ok(out.errors.some((x) => /thank-you/.test(x)));
});

test("the database says skip (not accepted on the page) → nothing sent; the alert email says why", async () => {
  const w = world({ alerts: [{ ...ACCEPTED }], notAccepted: true });
  await deliverAlerts(deps(w));
  assert.equal(w.resend.length, 0);
  assert.match(w.internal[0].text, /No thank-you email to the client: the client has not accepted the report on the page\./);
});

test("the database cannot be reached for the log → no email is sent (log first)", async () => {
  const w = world();
  const r = await sendThankYou({ ...deps(w), fetchFn: async () => { throw new Error("network"); } }, async () => { throw new Error("network"); }, SUB);
  assert.equal(r.sent, false); assert.match(r.error, /could not log it/);
  assert.equal(w.resend.length, 0);
  assert.match(thankYouLine(r), /FAILED/);
});

test("admin page: the Report block shows the thank-you's status, and the version mark (About) is reachable on a phone", () => {
  const html = readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
  assert.match(html, /Thank-you email to the client/);
  assert.match(html, /e\.kind === "thank_you"/);
  // fix 31: the phone rule no longer hides the version mark
  const phone = html.match(/@media \(max-width:899px\)\{ \.bar\{[^\n]*/)[0];
  assert.doesNotMatch(phone, /\.ver\{ display:none; \}/);
  assert.doesNotMatch(phone, /\.bar \.who \.ver\b/);
});
