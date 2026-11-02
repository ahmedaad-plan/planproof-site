// W6b — the media studio (netlify/lib/media-studio.mjs), with stand-ins for
// Supabase, Azure Speech, HeyGen and ffmpeg (no live call).
import test from "node:test";
import assert from "node:assert/strict";
import { runStudio, okOut, inputUrl, fillArgs } from "../netlify/lib/media-studio.mjs";

const URL0 = "https://db.example";
const ENV = { SUPABASE_URL: URL0, SUPABASE_SECRET_KEY: "sb_secret_x", SPEECH_API_KEY: "k", SPEECH_REGION: "uaenorth", HEYGEN_API_KEY: "h", HEYGEN_AVATAR_ID: "av1" };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

function world(opts = {}) {
  const w = { uploads: {}, reports: [], ssml: [], ff: [], files: {}, taken: false, headers: [] };
  w.fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin === URL0) w.headers.push(init.headers || {});
    if (u.pathname === "/rest/v1/rpc/studio_take_ticket") {
      if (opts.badTicket || w.taken) return json(null);
      w.taken = true; return json("job-1");
    }
    if (u.pathname === "/rest/v1/rpc/studio_report") { w.reports.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); }
    if (u.pathname.startsWith("/storage/v1/object/exercise-media/")) { w.uploads[u.pathname.replace("/storage/v1/object/exercise-media/", "")] = init.body; return json({ Key: "x" }); }
    if (u.pathname.startsWith("/storage/v1/object/public/exercise-media/")) return new Response(new Uint8Array(5000), { status: 200 });
    if (u.hostname.endsWith("tts.speech.microsoft.com")) { w.ssml.push(init.body); return new Response(new Uint8Array(24000 * 3), { status: 200 }); }
    if (u.hostname === "raw.githubusercontent.com") return new Response(new Uint8Array(9000), { status: 200 });
    if (u.pathname === "/v2/avatars") return json({ data: { avatars: [{ avatar_id: "a1", avatar_name: "Studio man", gender: "male", preview_image_url: "https://files.heygen.ai/a1.jpg" }] } });
    if (u.pathname === "/v2/user/remaining_quota") return json({ data: { remaining_quota: 1500 } });
    if (u.pathname === "/v3/videos" && init.method === "POST") { w.heygenBody = JSON.parse(init.body); return json({ data: { video_id: "v1" } }); }
    if (u.pathname === "/v3/videos/v1") return json({ data: { status: "completed", video_url: "https://files.heygen.ai/v1.mp4", duration: 12.5 } });
    if (u.href === "https://files.heygen.ai/v1.mp4") return new Response(new Uint8Array(70000), { status: 200 });
    return new Response("not found " + url, { status: 404 });
  };
  w.deps = {
    fetchFn: w.fetchFn, env: { ...ENV, ...(opts.env || {}) }, now: () => 0, sleep: async () => {}, pollMs: 0,
    tmpdir: "/tmp/x",
    writeFile: async (p, b) => { w.files[p] = b; },
    readFile: async (p) => w.files[p] || new Uint8Array(1234),
    runFfmpeg: async (args) => { w.ff.push(args); return { code: opts.ffFail ? 1 : 0, log: "frame=1 done" }; },
  };
  return w;
}
const TICKET = "t".repeat(40);

test("paths: outputs only under the media prefixes; inputs only from the repo, HeyGen or the bucket", () => {
  assert.ok(okOut("studio/a.mp3"));
  assert.ok(okOut("briefing/participant-en.mp4"));
  assert.ok(!okOut("../x"));
  assert.ok(!okOut("other/x.mp4"));
  assert.ok(!okOut("studio/a b.mp4"));
  assert.equal(inputUrl(ENV, "studio/a.mp3"), `${URL0}/storage/v1/object/public/exercise-media/studio/a.mp3`);
  assert.ok(inputUrl(ENV, "https://raw.githubusercontent.com/ahmedaad-plan/planproof-site/w6b/x.mp4"));
  assert.throws(() => inputUrl(ENV, "https://evil.example/x.mp4"), /not allowed/);
  assert.throws(() => inputUrl(ENV, "https://raw.githubusercontent.com/someone/else/x.mp4"), /not allowed/);
  assert.deepEqual(fillArgs(["-i", "{in0}", "-i", "{in1}", "{out}"], ["/a", "/b"], "/o.mp4"), ["-i", "/a", "-i", "/b", "/o.mp4"]);
  assert.throws(() => fillArgs(["{in2}"], ["/a"], "/o"), /No input 2/);
});

test("refused without the secret key (deploy previews) or without a valid pass; a pass works once", async () => {
  const noKey = world({ env: { SUPABASE_SECRET_KEY: "" } });
  assert.equal((await runStudio(noKey.deps, { ticket: TICKET, steps: [] })).ok, false);
  const bad = world({ badTicket: true });
  const r = await runStudio(bad.deps, { ticket: TICKET, steps: [{ kind: "tts", ssml: "<speak/>", out: "studio/a.mp3" }] });
  assert.match(r.error, /unknown, used or expired/);
  assert.equal(bad.ssml.length, 0, "nothing made before the pass is checked");
  const w = world();
  assert.equal((await runStudio(w.deps, { ticket: "short", steps: [] })).ok, false);
  assert.equal((await runStudio(w.deps, { ticket: TICKET, steps: [] })).ok, true);
  assert.equal((await runStudio(w.deps, { ticket: TICKET, steps: [] })).ok, false, "second use refused");
  assert.ok(w.headers.every((h) => !h.Authorization), "secret key never sent as a Bearer token");
});

test("tts, avatars, a HeyGen clip and an ffmpeg join: uploads, durations and a report per step", async () => {
  const w = world();
  const r = await runStudio(w.deps, { ticket: TICKET, steps: [
    { kind: "tts", ssml: "<speak>a</speak>", out: "samples/w6b-urgency-1.mp3" },
    { kind: "heygen_avatars", out: "studio/avatars.json" },
    { kind: "heygen_clip", audio: "studio/a.mp3", background: "plates/marsa-en.jpg", avatar_id: "a1", engine: "avatar_iii", out: "studio/clip.mp4" },
    { kind: "ffmpeg", inputs: ["https://raw.githubusercontent.com/ahmedaad-plan/planproof-site/w6b/v.mp4", "studio/a.mp3"],
      args: ["-i", "{in0}", "-i", "{in1}", "-c:v", "copy", "{out}"], out: "briefing/participant-en.mp4" },
  ] });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.equal(r.results[0].duration, 3);
  assert.equal(r.results[1].count, 1);
  assert.equal(r.results[2].duration, 12.5);
  assert.ok(w.uploads["studio/clip.mp4"]);
  assert.deepEqual([w.heygenBody.avatar_id, w.heygenBody.engine], ["a1", { type: "avatar_iii" }]);
  assert.deepEqual(w.ff[0], ["-i", "/tmp/x/in3_0.mp4", "-i", "/tmp/x/in3_1.mp3", "-c:v", "copy", "/tmp/x/out3.mp4"]);
  assert.ok(w.uploads["briefing/participant-en.mp4"]);
  assert.equal(w.reports.at(-1).p_status, "done");
  assert.equal(w.reports.at(-1).p_result.steps.length, 4);
});

test("a failing step stops the run and is reported with its reason; nothing secret in the report", async () => {
  const w = world({ ffFail: true });
  const r = await runStudio(w.deps, { ticket: TICKET, steps: [
    { kind: "ffmpeg", inputs: [], args: ["-f", "lavfi", "-i", "anullsrc", "{out}"], out: "studio/x.mp3" },
    { kind: "tts", ssml: "<speak/>", out: "studio/never.mp3" },
  ] });
  assert.equal(r.ok, false);
  assert.equal(r.results.length, 1);
  assert.match(r.results[0].error, /ffmpeg exit 1/);
  assert.equal(w.reports.at(-1).p_status, "failed");
  assert.doesNotMatch(JSON.stringify(w.reports), /sb_secret|"k"|"h"/);
  const w2 = world();
  const r2 = await runStudio(w2.deps, { ticket: TICKET, steps: [{ kind: "tts", ssml: "x", out: "admin/x.mp3" }] });
  assert.match(r2.results[0].error, /Output path not allowed/);
});
