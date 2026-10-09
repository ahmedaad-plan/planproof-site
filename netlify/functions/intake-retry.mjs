// Runs every 5 minutes. Finishes any request whose Supabase save or email
// failed the first time (never gives up: hourly after a day, while the health
// check raises the alarm), and deletes plan-document parts whose form was
// never sent. Logic in ../lib/intake-core.mjs.
import { getStore } from "@netlify/blobs";
import { retryPending } from "../lib/intake-core.mjs";
import { serverEnv } from "../lib/env.mjs";

export default async () => {
  const summary = await retryPending({
    pending: getStore({ name: "intake-pending", consistency: "strong" }),
    uploads: getStore({ name: "intake-uploads", consistency: "strong" }),
    fetchFn: fetch,
    env: serverEnv(),
  });
  if (summary.retried || summary.uploadsDeleted) console.log("intake-retry:", JSON.stringify(summary));
};

export const config = { schedule: "*/5 * * * *" }; // every 5 minutes (UTC, no local-hour dependency)
