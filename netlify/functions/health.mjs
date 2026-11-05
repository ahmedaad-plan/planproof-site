// GET /api/health — is everything that handles a client request working?
// 200 {"status":"ok",...} or 503 {"status":"problem","problems":[codes]}.
// For an outside uptime monitor (alerts Ahmed by a route that does not depend
// on PlanProof's own email) and the admin page's warning banner. Shows only
// status words and problem codes. Logic in ../lib/system-check.mjs.
import { getStore } from "@netlify/blobs";
import { checkHealth, publicHealth } from "../lib/system-check.mjs";
import { serverEnv } from "../lib/env.mjs";

export default async () => {
  const h = await checkHealth({
    pending: getStore({ name: "intake-pending", consistency: "strong" }),
    fetchFn: fetch,
    env: serverEnv(),
  });
  return Response.json(publicHealth(h), { status: h.status === "ok" ? 200 : 503, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
};

export const config = {
  path: "/api/health",
  method: "GET",
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 20 },
};
