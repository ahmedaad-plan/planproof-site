// W6a — "Voice and video: prepare" (admin page, step 4). A background
// function: answers 202 at once and works for up to 15 minutes, writing its
// progress into exercise_sessions.media, which the admin page reads every
// 5 seconds. Logic and tests: ../lib/media-prepare.mjs,
// tests/media-prepare.test.mjs. Uses the admin's own sign-in (no secret key).
import { readFile } from "node:fs/promises";
import { runMediaPrepare } from "../lib/media-prepare.mjs";

// The newsroom plates are bundled (netlify.toml included_files); where they
// land depends on the bundler, so try the likely places in turn.
async function readPlate(lang) {
  const name = `marsa-plate-${lang === "ar" ? "ar" : "en"}.jpg`;
  const tries = [new URL(`../media/${name}`, import.meta.url), `${process.cwd()}/netlify/media/${name}`, `/var/task/netlify/media/${name}`];
  for (const t of tries) { try { return await readFile(t); } catch {} }
  throw new Error("The newsroom background image is missing from the function bundle.");
}

export default async (req) => {
  try {
    const auth = req.headers.get("authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const body = await req.json().catch(() => ({}));
    const sessionId = String(body.session_id || "");
    if (!token || !/^[0-9a-f-]{36}$/i.test(sessionId)) { console.log("media-prepare: refused (no token or session)"); return; }
    const env = {
      SUPABASE_URL: Netlify.env.get("SUPABASE_URL"),
      SUPABASE_PUBLISHABLE_KEY: Netlify.env.get("SUPABASE_PUBLISHABLE_KEY"),
      SPEECH_API_KEY: Netlify.env.get("SPEECH_API_KEY"),
      SPEECH_REGION: Netlify.env.get("SPEECH_REGION"),
      HEYGEN_API_KEY: Netlify.env.get("HEYGEN_API_KEY"),
      HEYGEN_AVATAR_ID: Netlify.env.get("HEYGEN_AVATAR_ID"),
      HEYGEN_ENGINE: Netlify.env.get("HEYGEN_ENGINE"),
      HEYGEN_MOTION_PROMPT: Netlify.env.get("HEYGEN_MOTION_PROMPT"),
      HEYGEN_REMOVE_BG: Netlify.env.get("HEYGEN_REMOVE_BG"),
      HEYGEN_FIT: Netlify.env.get("HEYGEN_FIT"),
    };
    const done = await runMediaPrepare({
      fetchFn: fetch, env, token, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      readPlate,
      log: (m) => console.log("media-prepare:", m),
    }, { session_id: sessionId, langs: body.langs, what: body.what, force: !!body.force });
    console.log("media-prepare: done", JSON.stringify(done));
  } catch (err) {
    // Never throw: a background function that throws is retried by Netlify.
    console.log("media-prepare: error", String(err && err.message || err).slice(0, 300));
  }
};

export const config = { path: "/api/media-prepare", background: true };
