// W8 — POST /api/send-email (admin page). {action:"send", …} sends one client
// email (the scenario for review in build chat 1); {action:"poll", submission_id}
// asks Resend for the delivery status of the emails not yet answered. Uses the
// admin's own sign-in (Authorization: Bearer <access token>) — every database
// call refuses anyone else. Logic and tests: ../lib/send-email.mjs,
// tests/send-email.test.mjs.
import { sendClientEmail, pollForPage, SendError } from "../lib/send-email.mjs";

export default async (req) => {
  const json = (status, obj) => Response.json(obj, { status, headers: { "Cache-Control": "no-store" } });
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const body = await req.json().catch(() => ({}));
  const deps = {
    fetchFn: fetch,
    origin: new URL(req.url).origin,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    env: {
      SUPABASE_URL: Netlify.env.get("SUPABASE_URL"),
      SUPABASE_PUBLISHABLE_KEY: Netlify.env.get("SUPABASE_PUBLISHABLE_KEY"),
      RESEND_API_KEY: Netlify.env.get("RESEND_API_KEY"),
    },
  };
  try {
    if (body.action === "poll") return json(200, await pollForPage(deps, token, body));
    if (body.action === "send") {
      const out = await sendClientEmail(deps, token, body);
      console.log("send-email:", JSON.stringify({ kind: body.kind, ok: out.ok, status: out.status, from: out.from, recorded: out.recorded }));
      return json(out.ok ? 200 : 502, out);
    }
    return json(400, { ok: false, error: "Unknown action" });
  } catch (err) {
    const status = err instanceof SendError ? err.status : 500;
    console.log("send-email: error", status, String(err && err.message || err).slice(0, 300));
    return json(status, { ok: false, error: String(err && err.message || err) });
  }
};

export const config = {
  path: "/api/send-email",
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 30 },
};
