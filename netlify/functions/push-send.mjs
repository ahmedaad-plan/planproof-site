// W8 build 2 — POST /api/push (design D.10).
//   {action:"key"}      → the public push key, for the admin page's "Alerts: on".
//   {action:"deliver"}  → send every alert still waiting (push to each device + the
//                         email). Anyone may ask: the database decides what is new
//                         and sends each alert once (lib/alerts.mjs). The sponsor's
//                         page asks after a comment or an approval.
//   {action:"test"}     → a test alert, signed-in admin only (Bearer token).
import { deliverAlerts, raiseAndDeliver } from "../lib/alerts.mjs";
import { serverEnv } from "../lib/env.mjs";

const json = (status, obj) => Response.json(obj, { status, headers: { "Cache-Control": "no-store" } });

export default async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "POST only" });
  const body = await req.json().catch(() => ({}));
  const env = serverEnv();
  const deps = { fetchFn: fetch, env, origin: new URL(req.url).origin };
  if (body.action === "key") return json(200, { ok: !!env.VAPID_PUBLIC_KEY, publicKey: env.VAPID_PUBLIC_KEY || null });
  if (body.action === "deliver") {
    const out = await deliverAlerts(deps);
    console.log("push deliver:", JSON.stringify(out));
    return json(200, { ok: true, claimed: out.claimed });
  }
  if (body.action === "test") {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!token) return json(401, { ok: false, error: "Sign in again first." });
    const who = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/admin_whoami`, { method: "POST",
      headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}" })
      .then((r) => r.ok ? r.json() : null).catch(() => null);
    if (who !== true) return json(401, { ok: false, error: "Sign in again first (with your authenticator code)." });
    const out = await raiseAndDeliver(deps, { kind: "test", ref: crypto.randomUUID(), title: "Test alert",
      body: "Alerts work on this device. Every alert also comes by email to exercises@plan-proof.com.", url: "/admin/" });
    return json(200, { ok: true, pushed: out.pushed || 0, push_failed: out.push_failed || 0, emailed: out.emailed || 0, errors: out.errors || [] });
  }
  return json(400, { ok: false, error: "Unknown action" });
};

export const config = {
  path: "/api/push",
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 20 },
};
