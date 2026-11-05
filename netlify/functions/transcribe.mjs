// /api/transcribe — voice notes (17 October 2026).
// GET  → {"configured": true|false}  (the pages ask once, before the first tap)
// POST → multipart: audio (a short clip), session, attendee (Observer) or the
//        x-facilitator-token header (Facilitator), lang, vocabulary
//        → {"text": "..."} or {"reason": code}
// The clip is forwarded to the provider PlanProof chose and never stored.
// Logic in ../lib/transcribe-core.mjs.
import { handleTranscribe, isConfigured } from "../lib/transcribe-core.mjs";

function env() {
  const get = (k) => Netlify.env.get(k);
  return {
    SUPABASE_URL: get("SUPABASE_URL"),
    SUPABASE_PUBLISHABLE_KEY: get("SUPABASE_PUBLISHABLE_KEY"),
    SPEECH_PROVIDER: get("SPEECH_PROVIDER"),
    SPEECH_API_KEY: get("SPEECH_API_KEY"),
    SPEECH_REGION: get("SPEECH_REGION"),
    SPEECH_MODEL: get("SPEECH_MODEL"),
  };
}
const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export default async (req) => {
  const e = env();
  if (req.method === "GET") {
    return Response.json({ configured: isConfigured(e) }, { headers: HEADERS });
  }
  let form;
  try { form = await req.formData(); } catch { return Response.json({ reason: "no_audio" }, { status: 400, headers: HEADERS }); }
  const out = await handleTranscribe({ env: e, fetchFn: fetch, form, facilitatorToken: req.headers.get("x-facilitator-token") || "" });
  return Response.json(out.body, { status: out.status, headers: HEADERS });
};

export const config = {
  path: "/api/transcribe",
  method: ["GET", "POST"],
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 30 },
};
