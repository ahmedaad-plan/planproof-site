// Every hour at minute 7 (UTC): checks the database, email, waiting requests
// and the retry job; emails an alert (and a "resolved" note), the daily
// possible-spam digest at 08:07 UAE, and a Monday all-clear heartbeat. Its
// database call also keeps the Supabase project active. Logic in
// ../lib/system-check.mjs.
import { getStore } from "@netlify/blobs";
import { runSystemCheck } from "../lib/system-check.mjs";
import { serverEnv } from "../lib/env.mjs";

export default async () => {
  const done = await runSystemCheck({
    pending: getStore({ name: "intake-pending", consistency: "strong" }),
    fetchFn: fetch,
    env: serverEnv(),
  });
  if (done.problems.length || done.sent.length) console.log("system-check:", JSON.stringify(done));
};

export const config = { schedule: "7 * * * *" }; // hourly at :07 UTC
