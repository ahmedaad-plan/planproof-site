// W6b (2 November 2026) — the media studio: the production-side workshop that
// makes the briefing voice-overs, the urgency samples, the HeyGen presenter
// clips and joins sound and pictures with ffmpeg. Claude's cloud workspace
// cannot reach Azure, HeyGen or the storage, so the heavy media steps run here.
//
// No sign-in is needed: every call carries a ONE-TIME PASS that only the
// database owner can create (private.studio_jobs, hashed, 60-minute expiry,
// spent once by public.studio_take_ticket — service role only). The function
// runs with the Supabase secret key, which exists on production only, so a
// deploy preview can never run it. Results (paths, sizes, durations, the
// ffmpeg log tail) are written back to the same row (public.studio_report).
//
// Steps (run in order, each result kept):
//   { kind: "tts", ssml, out }                        Azure Speech → bucket
//   { kind: "heygen_avatars", out }                    list the studio presenters → JSON
//   { kind: "heygen_clip", audio, background, avatar_id, out }   presenter clip
//   { kind: "ffmpeg", inputs: [url|bucket path], args: [...], out, type }
//        args use {in0}, {in1}… and {out}; no shell.
//   { kind: "narration", session_id, langs, what, force } — the W6a "prepare"
//        run for one exercise, with the secret key instead of an admin sign-in.
import { azureTts, heygenClip, BUCKET } from "./media-prepare.mjs";

export const STUDIO_PREFIXES = ["studio/", "samples/", "briefing/", "plates/", "site/", "narration/", "clips/"];
const INPUT_HOSTS = [/^https:\/\/raw\.githubusercontent\.com\/ahmedaad-plan\/planproof-site\//, /^https:\/\/[a-z0-9.-]*heygen\.(com|ai)\//, /^https:\/\/[a-z0-9.-]*\.amazonaws\.com\//, /^https:\/\/[a-z0-9.-]*cloudfront\.net\//];

export function okOut(path) {
  return typeof path === "string" && !path.includes("..") && /^[a-z0-9/_.-]+$/i.test(path) && STUDIO_PREFIXES.some((p) => path.startsWith(p));
}
export function inputUrl(env, ref) {
  if (typeof ref !== "string") throw new Error("Bad input.");
  if (/^https:\/\//.test(ref)) {
    if (ref.startsWith(`${env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`)) return ref;
    if (INPUT_HOSTS.some((re) => re.test(ref))) return ref;
    throw new Error(`Input host not allowed: ${ref.slice(0, 80)}`);
  }
  if (!okOut(ref) && !ref.startsWith("plates/")) throw new Error(`Bad bucket path: ${ref}`);
  return `${env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${ref}`;
}
export function fillArgs(args, inPaths, outPath) {
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) throw new Error("ffmpeg args must be strings.");
  return args.map((a) => a.replace(/\{in(\d+)\}/g, (_, n) => {
    const p = inPaths[Number(n)];
    if (!p) throw new Error(`No input ${n}.`);
    return p;
  }).replace(/\{out\}/g, outPath));
}

function svc(deps) {
  const { env } = deps;
  const h = (extra = {}) => ({ apikey: env.SUPABASE_SECRET_KEY, ...extra });
  const req = async (path, init) => {
    const res = await deps.fetchFn(env.SUPABASE_URL + path, { ...init, signal: AbortSignal.timeout(120000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  return {
    rpc: (name, args) => req(`/rest/v1/rpc/${name}`, { method: "POST", headers: h({ "Content-Type": "application/json" }), body: JSON.stringify(args || {}) }),
    upload: (path, bytes, type) => req(`/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST", headers: h({ "Content-Type": type, "x-upsert": "true", "Cache-Control": "max-age=300" }), body: bytes }),
    publicUrl: (path) => `${env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`,
    exists: async (path) => (await deps.fetchFn(`${env.SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`, { method: "HEAD" })).ok,
    select: (table, query) => req(`/rest/v1/${table}?${query}`, { headers: h() }),
    patch: (table, query, body) => req(`/rest/v1/${table}?${query}`, { method: "PATCH", headers: h({ "Content-Type": "application/json", Prefer: "return=minimal" }), body: JSON.stringify(body) }),
  };
}

const TYPES = { mp3: "audio/mpeg", mp4: "video/mp4", vtt: "text/vtt", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", json: "application/json" };
const typeOf = (p) => TYPES[(p.split(".").pop() || "").toLowerCase()] || "application/octet-stream";

// deps: { fetchFn, env, now, sleep, runFfmpeg(args) → {code, log}, tmpdir, readFile, writeFile, readPlate, log }
export async function runStudio(deps, body) {
  const { env } = deps;
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return { ok: false, error: "The studio runs on production only (no secret key here)." };
  const ticket = String((body && body.ticket) || "");
  if (ticket.length < 24) return { ok: false, error: "No pass." };
  const api = svc(deps);
  const job = await api.rpc("studio_take_ticket", { p_ticket: ticket });
  if (!job) return { ok: false, error: "The pass is unknown, used or expired." };
  const steps = Array.isArray(body.steps) ? body.steps.slice(0, 40) : [];
  const results = [];
  const report = (status) => api.rpc("studio_report", { p_job: job, p_status: status, p_result: { steps: results, at: new Date(deps.now()).toISOString() } });
  await report("running");
  let failed = false;
  for (const [i, s] of steps.entries()) {
    const r = { i, kind: s && s.kind, out: s && s.out };
    const t0 = deps.now();
    try {
      if (s.kind !== "narration" && !okOut(s.out)) throw new Error(`Output path not allowed: ${s.out}`);
      if (s.kind === "tts") {
        const audio = await azureTts(deps, String(s.ssml || ""));
        await api.upload(s.out, audio, "audio/mpeg");
        r.bytes = audio.length;
        r.duration = Math.round((audio.length * 8 / 192000) * 100) / 100;
      } else if (s.kind === "heygen_avatars") {
        const H = { "X-Api-Key": env.HEYGEN_API_KEY, Accept: "application/json" };
        const av = await (await deps.fetchFn("https://api.heygen.com/v2/avatars", { headers: H })).json();
        let quota = null;
        try { quota = await (await deps.fetchFn("https://api.heygen.com/v2/user/remaining_quota", { headers: H })).json(); } catch {}
        const list = ((av && av.data && av.data.avatars) || []).map((a) => ({ id: a.avatar_id, name: a.avatar_name, gender: a.gender, preview: a.preview_image_url, video: a.preview_video_url, premium: a.premium, type: a.type }));
        const out = JSON.stringify({ count: list.length, quota: quota && quota.data, avatars: list });
        await api.upload(s.out, new TextEncoder().encode(out), "application/json");
        r.count = list.length;
        r.quota = quota && quota.data;
      } else if (s.kind === "heygen_clip") {
        const clip = await heygenClip({ ...deps, env: { ...env, HEYGEN_AVATAR_ID: s.avatar_id || env.HEYGEN_AVATAR_ID } },
          { audioUrl: inputUrl(env, s.audio), backgroundUrl: inputUrl(env, s.background) });
        await api.upload(s.out, clip.bytes, "video/mp4");
        r.bytes = clip.bytes.length;
        r.duration = clip.duration;
        r.heygen_id = clip.heygen_id;
      } else if (s.kind === "ffmpeg") {
        const ins = [];
        for (const [k, ref] of (s.inputs || []).entries()) {
          const url = inputUrl(env, ref);
          const res = await deps.fetchFn(url, { signal: AbortSignal.timeout(180000) });
          if (!res.ok) throw new Error(`Input ${k} → HTTP ${res.status}`);
          const p = `${deps.tmpdir}/in${i}_${k}.${(url.split("?")[0].split(".").pop() || "bin").slice(0, 5)}`;
          await deps.writeFile(p, new Uint8Array(await res.arrayBuffer()));
          ins.push(p);
        }
        const ext = (s.out.split(".").pop() || "bin");
        const outPath = `${deps.tmpdir}/out${i}.${ext}`;
        const run = await deps.runFfmpeg(fillArgs(s.args, ins, outPath));
        r.log = String(run.log || "").slice(-1500);
        if (run.code !== 0) throw new Error(`ffmpeg exit ${run.code}`);
        const bytes = await deps.readFile(outPath);
        await api.upload(s.out, bytes, s.type || typeOf(s.out));
        r.bytes = bytes.length;
      } else if (s.kind === "narration") {
        const { runMediaPrepare } = await import("./media-prepare.mjs");
        r.result = await runMediaPrepare({ ...deps, service: api }, { session_id: s.session_id, langs: s.langs, what: s.what || "all", force: !!s.force });
        if (!r.result.ok) throw new Error(r.result.error || "Prepare finished with problems.");
      } else {
        throw new Error(`Unknown step: ${s.kind}`);
      }
      if (s.kind !== "narration") r.url = api.publicUrl(s.out);
      r.ok = true;
    } catch (err) {
      r.ok = false;
      r.error = String((err && err.message) || err).slice(0, 400);
      failed = true;
    }
    r.ms = deps.now() - t0;
    results.push(r);
    await report("running");
    if (!r.ok && s.stop_on_error !== false) break;
  }
  await report(failed ? "failed" : "done");
  return { ok: !failed, job, results };
}
