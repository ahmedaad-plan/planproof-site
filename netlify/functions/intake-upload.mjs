// Receives one part (at most 2 MB) of a plan document from the "Test my plan"
// form. Files are sent in parts because a single function request is limited
// to about 4.5 MB, and the site accepts plans up to 8 MB. Parts are held in
// Netlify Blobs only until the email carrying the file has been sent
// (intake-core deletes them), or for a day if the form is never sent.
import { getStore } from "@netlify/blobs";
import { checkUploadParams, IntakeError } from "../lib/intake-core.mjs";

const json = (status, obj) => Response.json(obj, { status, headers: { "Cache-Control": "no-store" } });

export default async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  try {
    const bytes = await req.arrayBuffer();
    const { key, parts } = checkUploadParams(new URL(req.url).searchParams, bytes.byteLength);
    const uploads = getStore({ name: "intake-uploads", consistency: "strong" });
    await uploads.set(key, bytes, { metadata: { uploadedAt: Date.now(), parts } });
    return json(200, { ok: true });
  } catch (err) {
    if (err instanceof IntakeError) return json(err.status, { ok: false, error: err.message });
    console.error("intake-upload error:", err);
    return json(500, { ok: false, error: "Server error" });
  }
};

// Rate limit (added 9 October 2026): one plan is at most 4 parts (plus browser
// retries), so 30 parts a minute from one visitor is far above real use.
export const config = {
  path: "/api/intake-upload",
  method: "POST",
  rateLimit: { action: "rate_limit", aggregateBy: ["ip", "domain"], windowSize: 60, windowLimit: 30 },
};
