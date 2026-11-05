// W6b — the media studio (see ../lib/media-studio.mjs). A background function
// on /api/media-studio: answers 202 at once, works up to 15 minutes, and
// writes its results into private.studio_jobs. Needs a one-time pass that
// only the database owner can create, and the Supabase secret key, which is
// set for production only — so it never runs on a deploy preview.
import { readFile, writeFile, mkdtemp, chmod, copyFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { runStudio } from "../lib/media-studio.mjs";

const require = createRequire(import.meta.url);

async function ffmpegPath() {
  // The binary ships in the npm package; copy it to /tmp so it is executable.
  const target = "/tmp/pp-ffmpeg";
  try { await access(target); return target; } catch {}
  let src;
  try { src = require("@ffmpeg-installer/ffmpeg").path; } catch { src = require.resolve("@ffmpeg-installer/linux-x64/ffmpeg"); }
  await copyFile(src, target);
  await chmod(target, 0o755);
  return target;
}

function runFfmpeg(bin) {
  return (args) => new Promise((resolve) => {
    const p = spawn(bin, ["-hide_banner", "-y", ...args]);
    let log = "";
    const keep = (d) => { log += d.toString(); if (log.length > 20000) log = log.slice(-20000); };
    p.stdout.on("data", keep); p.stderr.on("data", keep);
    const t = setTimeout(() => p.kill("SIGKILL"), 12 * 60 * 1000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, log }); });
    p.on("error", (e) => { clearTimeout(t); resolve({ code: -1, log: log + String(e) }); });
  });
}

export default async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const env = {
      SUPABASE_URL: Netlify.env.get("SUPABASE_URL"),
      SUPABASE_SECRET_KEY: Netlify.env.get("SUPABASE_SECRET_KEY"),
      SPEECH_API_KEY: Netlify.env.get("SPEECH_API_KEY"),
      SPEECH_REGION: Netlify.env.get("SPEECH_REGION"),
      HEYGEN_API_KEY: Netlify.env.get("HEYGEN_API_KEY"),
      HEYGEN_AVATAR_ID: Netlify.env.get("HEYGEN_AVATAR_ID"),
      HEYGEN_ENGINE: Netlify.env.get("HEYGEN_ENGINE"),
      HEYGEN_MOTION_PROMPT: Netlify.env.get("HEYGEN_MOTION_PROMPT"),
      HEYGEN_REMOVE_BG: Netlify.env.get("HEYGEN_REMOVE_BG"),
      HEYGEN_FIT: Netlify.env.get("HEYGEN_FIT"),
    };
    const dir = await mkdtemp(`${tmpdir()}/studio-`);
    let bin = null;
    const done = await runStudio({
      fetchFn: fetch, env, now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      tmpdir: dir, readFile, writeFile,
      runFfmpeg: async (args) => { bin = bin || await ffmpegPath(); return runFfmpeg(bin)(args); },
      readPlate: async (lang) => readFile(new URL(`../media/marsa-plate-${lang === "ar" ? "ar" : "en"}.jpg`, import.meta.url)).catch(() => readFile(`${process.cwd()}/netlify/media/marsa-plate-${lang === "ar" ? "ar" : "en"}.jpg`)),
      log: (m) => console.log("media-studio:", m),
    }, body);
    console.log("media-studio: done", JSON.stringify({ ok: done.ok, error: done.error, job: done.job, n: done.results && done.results.length }));
  } catch (err) {
    console.log("media-studio: error", String((err && err.message) || err).slice(0, 300));
  }
};

export const config = { path: "/api/media-studio", background: true };
