// Daily at 02:17 UTC (06:17 UAE): removes the player data of exercises whose
// request was marked Delivered 7 or more days ago (after an export), and
// emails a reminder for exports never marked Delivered after 30 days.
// Logic in ../lib/player-purge.mjs.
import { runPlayerPurge } from "../lib/player-purge.mjs";

export default async () => {
  const env = {
    SUPABASE_URL: Netlify.env.get("SUPABASE_URL"),
    SUPABASE_SECRET_KEY: Netlify.env.get("SUPABASE_SECRET_KEY"),
    RESEND_API_KEY: Netlify.env.get("RESEND_API_KEY"),
    RESEND_FROM_ADDRESS: Netlify.env.get("RESEND_FROM_ADDRESS"),
    ALERT_EMAIL: Netlify.env.get("ALERT_EMAIL"),
  };
  const done = await runPlayerPurge({ fetchFn: fetch, env });
  console.log("player-purge:", JSON.stringify({ removed: done.removed.map((x) => x.request_no), failed: done.failed.map((x) => [x.request_no, x.error]), reminded: done.reminded.length, skipped: done.skipped }));
};

export const config = { schedule: "17 2 * * *" };
