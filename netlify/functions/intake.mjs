// Receives a request from any of the website's four forms (see index.html,
// submitIntake). Replaces Netlify Forms, whose spam filter could silently
// drop a real client request. All the logic is in ../lib/intake-core.mjs.
import { getStore } from "@netlify/blobs";
import { handleIntake, IntakeError, MAX_BODY_CHARS } from "../lib/intake-core.mjs";
import { serverEnv } from "../lib/env.mjs";

const json = (status, obj) => Response.json(obj, { status, headers: { "Cache-Control": "no-store" } });

export default async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return json(413, { ok: false, error: "Request too large" });
    body = JSON.parse(text);
  } catch {
    return json(400, { ok: false, error: "Invalid request" });
  }
  try {
    const result = await handleIntake(body, {
      pending: getStore({ name: "intake-pending", consistency: "strong" }),
      uploads: getStore({ name: "intake-uploads", consistency: "strong" }),
      fetchFn: fetch,
      env: serverEnv(),
    });
    return json(result.ok ? 200 : 503, { ok: result.ok });
  } catch (err) {
    if (err instanceof IntakeError) return json(err.status, { ok: false, error: err.message });
    console.error("intake error:", err);
    return json(500, { ok: false, error: "Server error" });
  }
};

// Rate limit (added 9 October 2026): a person sends one request; 10 a minute
// from one visitor is a bot. Over the limit, Netlify answers 429 and the page
// retries a moment later, then offers the one-click email fallback.
export const config = {
  path: "/api/intake",
  method: "POST",
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 10 },
};
