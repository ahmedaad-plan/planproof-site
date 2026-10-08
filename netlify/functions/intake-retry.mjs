// Runs every 5 minutes. Finishes any request whose Supabase save or email
// failed the first time (retried for up to 7 days), and deletes plan-document
// parts whose form was never sent. Logic in ../lib/intake-core.mjs.
import { getStore } from "@netlify/blobs";
import { retryPending } from "../lib/intake-core.mjs";

export default async () => {
  const summary = await retryPending({
    pending: getStore({ name: "intake-pending", consistency: "strong" }),
    uploads: getStore({ name: "intake-uploads", consistency: "strong" }),
    fetchFn: fetch,
    env: {
      SUPABASE_URL: Netlify.env.get("SUPABASE_URL"),
      SUPABASE_PUBLISHABLE_KEY: Netlify.env.get("SUPABASE_PUBLISHABLE_KEY"),
      RESEND_API_KEY: Netlify.env.get("RESEND_API_KEY"),
      RESEND_FROM_ADDRESS: Netlify.env.get("RESEND_FROM_ADDRESS"),
    },
  });
  if (summary.retried || summary.gaveUp || summary.uploadsDeleted) console.log("intake-retry:", JSON.stringify(summary));
};

export const config = { schedule: "*/5 * * * *" }; // every 5 minutes (UTC, no local-hour dependency)
