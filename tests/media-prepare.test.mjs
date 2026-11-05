// W6a — "Voice and video: prepare" (netlify/lib/media-prepare.mjs), with recorded
// stand-ins for Supabase, Azure Speech and HeyGen (no live call).
import test from "node:test";
import assert from "node:assert/strict";
import {
  heygenRequest,
  timeWordsEn, timeWordsAr, headerSentence, messageParts, narrationSsml, clipSsml, clipCues,
  planMedia, runMediaPrepare, wordCount, mp3Duration, MAX_CLIPS, urgencyOf, styleKey, URGENT_PROFILES,
} from "../netlify/lib/media-prepare.mjs";

const SID = "7f674d9e-7aa2-4e0c-8bef-9b02e118734e";
const jwt = (claims) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
const ADMIN = jwt({ sub: "u1", aal: "aal2", role: "authenticated" });

const V7 = "Email · From: Head of IT · To: Crisis Management Team · 07:12\nEXERCISE – Ransom note on screens\n\nStaff report a message on every screen.\n\nPlease confirm the next step.";
const SCRIPT_EN = "Good morning. We begin with breaking news. A clinic network says its systems were locked.\n\nStaff at several branches are turning patients away.\n\nWe'll bring you more as it comes in.";

test("time words: English and Arabic (genitive after في الساعة)", () => {
  assert.equal(timeWordsEn("07:12"), "seven twelve");
  assert.equal(timeWordsEn("07:05"), "seven oh five");
  assert.equal(timeWordsEn("07:00"), "seven o'clock");
  assert.equal(timeWordsEn("13:45"), "thirteen forty-five");
  assert.equal(timeWordsEn("25:00"), null);
  assert.equal(timeWordsAr("07:12"), "في الساعة السابعة واثنتي عشرة دقيقة صباحاً");
  assert.equal(timeWordsAr("19:05"), "في الساعة السابعة وخمس دقائق مساءً");
  assert.equal(timeWordsAr("12:00"), "في الساعة الثانية عشرة تماماً مساءً");
  assert.equal(timeWordsAr("08:21"), "في الساعة الثامنة وإحدى وعشرين دقيقة صباحاً");
});

test("the v7 header line is spoken as a sentence", () => {
  const p = messageParts(V7);
  assert.deepEqual(p.header, ["Email", "From: Head of IT", "To: Crisis Management Team", "07:12"]);
  assert.equal(headerSentence(p.header, "en"), "An email from the Head of IT to the Crisis Management Team, at seven twelve.");
  assert.equal(headerSentence(["Phone call", "From: Warehouse Shift Supervisor", "To: Operations Duty Manager", "07:20"], "en"),
    "A phone call from the Warehouse Shift Supervisor to the Operations Duty Manager, at seven twenty.");
  assert.equal(headerSentence(["بريد إلكتروني", "من: رئيس تقنية المعلومات", "إلى: فريق إدارة الأزمات", "07:12"], "ar"),
    "رسالة بريد إلكتروني من رئيس تقنية المعلومات إلى فريق إدارة الأزمات، في الساعة السابعة واثنتي عشرة دقيقة صباحاً.");
  assert.equal(messageParts("Just a sentence.").header, null);
});

test("narration SSML: header, 'Exercise.' once with a pause, subject, body; never the task or notes", () => {
  // W6b: read "calm" here so the base pauses are checked; brisk/urgent below.
  const ssml = narrationSsml({ title: "Ransom", desc: V7, task: "SECRET TASK", facilitatorNotes: "NOTES", observerWatch: ["WATCH"], urgency: "calm" }, "en");
  assert.match(ssml, /voice name="en-GB-RyanNeural"/);
  assert.match(ssml, /prosody rate="-5%"/);
  assert.match(ssml, /An email from the Head of IT to the Crisis Management Team, at seven twelve\.<break time="400ms"\/>Exercise\.<break time="400ms"\/>Ransom note on screens<break time="300ms"\/><break time="600ms"\/>Staff report a message on every screen\.<break time="500ms"\/>Please confirm the next step\./);
  assert.doesNotMatch(ssml, /SECRET|NOTES|WATCH|EXERCISE –/);
  const old = narrationSsml({ title: "Fire intensifies", desc: "Smoke & heat <rising>.", urgency: "calm" }, "en");
  assert.match(old, /Fire intensifies<break time="600ms"\/>Smoke &amp; heat &lt;rising&gt;\./);
});

test("Arabic narration only from Arabic text; Arabic rate and voice", () => {
  assert.equal(narrationSsml({ title: "Fire", desc: "English only" }, "ar"), null);
  const ssml = narrationSsml({ title_ar: "حريق", desc_ar: "اندلع حريق في المستودع.", urgency: "calm" }, "ar");
  assert.match(ssml, /ar-AE-HamdanNeural/);
  assert.match(ssml, /rate="-8%"/);
  assert.match(ssml, /xml:lang="ar-AE"/);
});

test("clip SSML uses the presenter voice; cues for the second headline", () => {
  assert.match(clipSsml(SCRIPT_EN, "en"), /en-GB-RyanNeural/);
  assert.match(clipSsml("خبر.", "ar"), /ar-AE-HamdanNeural/);
  const cues = clipCues(SCRIPT_EN, 30, { headline2: "Several branches" });
  assert.equal(cues.length, 1);
  assert.ok(cues[0].at > 10 && cues[0].at < 25, `cue at ${cues[0].at}`);
  assert.deepEqual(clipCues(SCRIPT_EN, 30, { headline: "x" }), []);
  assert.equal(mp3Duration(24000 * 10), 10);
});

test("the plan: sensitive injects skipped, existing files kept, word and clip limits, cost", () => {
  const long = Array(131).fill("word").join(" ");
  const sc = { injects: [
    { title: "A", desc: V7, video: { script_en: SCRIPT_EN, script_ar: "خبر عاجل." } },
    { title: "B", desc: "b", narration: false, video: { script_en: SCRIPT_EN } },
    { title: "C", desc: "c", video: { script_en: long } },
    { title: "D", desc: "d" },
  ] };
  const p = planMedia(sc, { items: { "3": { narration: { en: "narration/x/d.mp3" }, narration_voice: { en: "en-GB-RyanNeural" }, narration_style: { en: styleKey("en", "brisk") } } } }, { langs: ["en", "ar"] });
  assert.deepEqual(p.narration.map((j) => `${j.index}${j.lang}`), ["0en", "2en"]);
  assert.deepEqual(p.clips.map((j) => `${j.index}${j.lang}`), ["0en", "0ar"]);
  assert.equal(p.refused.length, 1);
  assert.match(p.refused[0].reason, /131 words; the limit is 130/);
  assert.equal(p.estimate_usd, 8);
  assert.ok(p.skipped.some((s) => s.index === 1 && s.why === "narration_false"));
  assert.ok(p.skipped.some((s) => s.index === 0 && s.lang === "ar" && s.why === "no_text_in_language"));
  const forced = planMedia(sc, { items: { "3": { narration: { en: "x" } } } }, { langs: ["en"], what: "narration", force: true });
  assert.deepEqual(forced.narration.map((j) => j.index), [0, 2, 3]);
  assert.equal(forced.clips.length, 0);
  const many = { injects: Array.from({ length: 8 }, (_, i) => ({ title: `N${i}`, desc: "x", video: { script_en: "Short news." } })) };
  const pm = planMedia(many, {}, { langs: ["en"], what: "clips" });
  assert.equal(pm.clips.length, MAX_CLIPS);
  assert.equal(pm.refused.length, 2);
  assert.equal(wordCount("  a b\n c "), 3);
});

function world(opts = {}) {
  const w = { calls: [], uploads: {}, medias: [], ssml: [], heygen: [], polls: 0, clock: 0, ...opts };
  w.scenario = opts.scenario || { injects: [
    { title: "A", desc: V7, video: { script_en: SCRIPT_EN, headline2: "Second line" } },
    { title: "B", desc: "Plain text.", narration: false },
    { title: "C", desc: "Another one." },
  ] };
  w.fetchFn = async (url, init = {}) => {
    const u = new URL(url);
    w.calls.push(`${init.method || "GET"} ${u.hostname}${u.pathname}`);
    const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
    if (u.hostname === "db.test" && u.pathname.startsWith("/storage/v1/object/public/exercise-media/")) return new Response("", { status: w.plateThere ? 200 : 404 });
    if (u.hostname === "db.test") {
      assert.equal(init.headers.apikey, "sb_publishable_test", "only the publishable key, never a secret key");
      assert.equal(init.headers.Authorization, `Bearer ${ADMIN}`, "the admin's own sign-in");
      if (u.pathname === "/rest/v1/rpc/admin_whoami") return json(opts.notAdmin ? false : true);
      if (u.pathname === "/rest/v1/rpc/admin_session_scenario") return json({ id: SID, status: opts.status || "lobby", scenario: w.scenario, media: opts.media || {} });
      if (u.pathname === "/rest/v1/rpc/admin_set_media") { const b = JSON.parse(init.body); w.medias.push(b.p_media); return json({ ok: true }); }
      if (u.pathname.startsWith("/storage/v1/object/exercise-media/")) {
        assert.equal(init.headers["x-upsert"], "true");
        w.uploads[u.pathname.replace("/storage/v1/object/exercise-media/", "")] = init.headers["Content-Type"];
        return json({ Key: "ok" });
      }
    }
    if (u.hostname === "uaenorth.tts.speech.microsoft.com") {
      assert.equal(init.headers["Ocp-Apim-Subscription-Key"], "speech_test");
      assert.equal(init.headers["X-Microsoft-OutputFormat"], "audio-48khz-192kbitrate-mono-mp3");
      w.ssml.push(init.body);
      if (opts.azureDown) return new Response("down", { status: 503 });
      return new Response(new Uint8Array(24000 * 12), { status: 200 });
    }
    if (u.hostname === "api.heygen.com") {
      assert.equal(init.headers["X-Api-Key"], "heygen_test");
      if (u.pathname === "/v3/videos" && init.method === "POST") { w.heygen.push(JSON.parse(init.body)); return json({ data: { video_id: "vid1" } }); }
      if (u.pathname === "/v3/videos/vid1") {
        w.polls += 1;
        if (opts.heygenFails) return json({ data: { status: "failed", failure_message: "bad audio" } });
        return json({ code: 100, data: w.polls < 2 ? { status: "processing" } : { status: "completed", video_url: "https://files.test/v.mp4", duration: 41.5 } });
      }
    }
    if (u.hostname === "files.test") return new Response(new Uint8Array(5000), { status: 200 });
    return json({ message: "unexpected " + url }, 404);
  };
  w.env = { SUPABASE_URL: "https://db.test", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SPEECH_API_KEY: "speech_test", SPEECH_REGION: "uaenorth",
    HEYGEN_API_KEY: "heygen_test", HEYGEN_AVATAR_ID: "avatar_test", ...(opts.env || {}) };
  w.deps = { fetchFn: w.fetchFn, env: w.env, token: opts.token || ADMIN, now: () => (w.clock += 1000), sleep: async () => {},
    readPlate: async () => new Uint8Array(100), pollMs: 0 };
  return w;
}
const last = (w) => w.medias[w.medias.length - 1];

test("refuses without the second factor, for a non-admin and while running — before any cost", async () => {
  let w = world({ token: jwt({ sub: "u1", aal: "aal1" }) });
  assert.match((await runMediaPrepare(w.deps, { session_id: SID })).error, /authenticator/);
  assert.equal(w.calls.length, 0);
  w = world({ notAdmin: true });
  assert.match((await runMediaPrepare(w.deps, { session_id: SID })).error, /Not authorised/);
  w = world({ status: "running" });
  assert.match((await runMediaPrepare(w.deps, { session_id: SID })).error, /running/);
  assert.equal(w.ssml.length, 0);
});

test("a full run: narration for each non-sensitive inject, one English clip, progress saved, ready", async () => {
  const w = world();
  const r = await runMediaPrepare(w.deps, { session_id: SID, langs: ["en"], samples: false });
  assert.equal(r.ok, true);
  const m = last(w);
  assert.equal(m.status, "ready");
  assert.ok(w.medias[0].status === "preparing");
  assert.match(m.items["0"].narration.en, new RegExp(`^narration/${SID}/[0-9a-f-]{36}\\.mp3$`));
  assert.ok(!m.items["1"], "narration: false → nothing at all for that inject");
  assert.ok(m.items["2"].narration.en);
  assert.match(m.items["0"].clip.en.path, new RegExp(`^clips/${SID}/[0-9a-f-]{36}\\.mp4$`));
  assert.equal(m.items["0"].clip.en.duration, 41.5);
  assert.equal(m.items["0"].clip.en.cues.length, 1);
  assert.deepEqual(m.counts, { narration: 2, clips: 1 });
  assert.equal(m.progress.done, m.progress.total);
  // the presenter clip: audio from Azure (Ryan), our plate as background, 1080p
  const g = w.heygen[0];
  assert.equal(g.type, "avatar"); // W6b: HeyGen v3
  assert.equal(g.avatar_id, "avatar_test");
  assert.match(g.audio_url, /^https:\/\/db\.test\/storage\/v1\/object\/public\/exercise-media\/clips\//);
  assert.match(g.background.url, /plates\/marsa-en\.jpg$/);
  assert.equal(g.resolution, "1080p");
  assert.ok(w.ssml.some((s) => /en-GB-RyanNeural/.test(s)));
  assert.equal(w.uploads["plates/marsa-en.jpg"], "image/jpeg");
  assert.ok(Object.entries(w.uploads).some(([p, t]) => p.endsWith(".mp4") && t === "video/mp4"));
  assert.ok(!JSON.stringify(w.medias).includes("speech_test") && !JSON.stringify(w.medias).includes("heygen_test"), "no secret in the record");
});

test("without the HeyGen key: narration made, clips marked failed with a plain reason, nothing billed", async () => {
  const w = world({ env: { HEYGEN_API_KEY: "" } });
  const r = await runMediaPrepare(w.deps, { session_id: SID, langs: ["en"] });
  assert.equal(r.ok, false);
  const m = last(w);
  assert.equal(m.status, "failed");
  assert.match(m.items["0"].failed.clip_en, /HEYGEN_API_KEY is not set/);
  assert.ok(m.items["0"].narration.en);
  assert.equal(w.heygen.length, 0);
});

test("Azure down: every item failed, status failed; a later Retry makes only the missing ones", async () => {
  const w = world({ azureDown: true, env: { HEYGEN_API_KEY: "" } });
  await runMediaPrepare(w.deps, { session_id: SID, langs: ["en"], what: "narration" });
  const m = last(w);
  assert.equal(m.status, "failed");
  assert.match(m.items["0"].failed.narration_en, /Azure Speech → HTTP 503/);
  const w2 = world({ media: { items: { "0": { narration: { en: "narration/old.mp3" }, narration_voice: { en: "en-GB-RyanNeural" }, narration_style: { en: styleKey("en", "urgent") } } } } });
  await runMediaPrepare(w2.deps, { session_id: SID, langs: ["en"], what: "narration", samples: false });
  assert.equal(w2.ssml.length, 1, "only inject 3 was missing");
  assert.equal(last(w2).items["0"].narration.en, "narration/old.mp3");
  assert.equal(last(w2).status, "ready");
});

test("HeyGen fails: the clip is failed with HeyGen's reason; the existing plate is not uploaded again", async () => {
  const w = world({ heygenFails: true, plateThere: true });
  await runMediaPrepare(w.deps, { session_id: SID, langs: ["en"], what: "clips" });
  assert.match(last(w).items["0"].failed.clip_en, /HeyGen could not make the clip/);
  assert.ok(!w.uploads["plates/marsa-en.jpg"]);
});

test("the four voice samples are made once (Sonia, Fatima with English labels, Ryan, Hamdan) and kept", async () => {
  const w = world({ env: { HEYGEN_API_KEY: "" } });
  await runMediaPrepare(w.deps, { session_id: SID, langs: ["en"], what: "narration" });
  const names = Object.keys(w.uploads).filter((p) => p.startsWith("samples/"));
  assert.equal(names.length, 4);
  assert.ok(w.ssml.some((x) => /ar-AE-FatimaNeural/.test(x) && /"Submit answer"/.test(x) && /We need a few more minutes/.test(x)));
  assert.ok(w.ssml.some((x) => /en-GB-SoniaNeural/.test(x) && /not individuals/.test(x)));
  assert.ok(w.ssml.some((x) => /ar-AE-HamdanNeural/.test(x)));
  assert.equal(last(w).samples.length, 4);
  const w2 = world({ plateThere: true });
  await runMediaPrepare(w2.deps, { session_id: SID, langs: ["en"], what: "narration" });
  assert.equal(Object.keys(w2.uploads).filter((p) => p.startsWith("samples/")).length, 0, "already there: not made again");
});

test("voice change (2 November 2026): narration made with an earlier voice is made again with Ryan / Hamdan, and the voice is recorded", async () => {
  const sc = { injects: [{ title: "A", desc: "a" }, { title: "B", desc: "b" }] };
  const p = planMedia(sc, { items: {
    "0": { narration: { en: "narration/x/sonia.mp3" } },
    "1": { narration: { en: "narration/x/ryan.mp3" }, narration_voice: { en: "en-GB-RyanNeural" }, narration_style: { en: styleKey("en", "brisk") } },
  } }, { langs: ["en"], what: "narration" });
  assert.deepEqual(p.narration.map((j) => j.index), [0], "only the Sonia file is made again");
  const w = world({ media: { items: { "0": { narration: { en: "narration/old-sonia.mp3" } } } } });
  await runMediaPrepare(w.deps, { session_id: SID, langs: ["en"], what: "narration", samples: false });
  const m = last(w);
  assert.notEqual(m.items["0"].narration.en, "narration/old-sonia.mp3");
  assert.equal(m.items["0"].narration_voice.en, "en-GB-RyanNeural");
  assert.ok(w.ssml.some((x) => /en-GB-RyanNeural/.test(x)));
});

test("W6b urgency: brisk by default, urgent for news clips and alerts, the scenario's own level wins", () => {
  assert.equal(urgencyOf({ desc: V7 }), "brisk");
  assert.equal(urgencyOf({ desc: "Alert · From: Building management system · 07:30\nCooling failure." }), "urgent");
  assert.equal(urgencyOf({ desc: "x", video: { script_en: "News." } }), "urgent");
  assert.equal(urgencyOf({ desc: V7, urgency: "calm" }), "calm");
  assert.equal(urgencyOf({ desc: V7, urgency: "nonsense" }), "brisk");
  const brisk = narrationSsml({ desc: V7 }, "en");
  assert.match(brisk, /prosody rate="\+3%" pitch="\+1%"/);
  assert.match(brisk, /<break time="320ms"\/>Exercise\./, "pauses shortened (×0.8)");
  const urgent = narrationSsml({ desc: V7, urgency: "urgent" }, "en");
  assert.match(urgent, /prosody rate="\+3%" pitch="\+4%" volume="\+10%"/, "urgent keeps the brisk speed (Ahmed, 20:15)");
  assert.match(urgent, /<prosody pitch="\+7%" volume="\+15%">An email from/);
  assert.match(narrationSsml({ desc: V7, urgency: "urgent-high" }, "en"), /rate="\+3%" pitch="\+6%" volume="\+15%"/);
  assert.match(narrationSsml({ desc: V7, urgency: "urgent-low" }, "en"), /rate="\+3%" pitch="\+2%" volume="\+5%"/);
  assert.equal(urgencyOf({ desc: V7, urgency: "urgent-low" }), "urgent-low");
  assert.doesNotMatch(urgent, /break time="(\d{4,}|[0-9]{1,2})ms"/);
  assert.ok(URGENT_PROFILES.low && URGENT_PROFILES.high);
  for (const k of Object.keys(URGENT_PROFILES)) assert.equal(URGENT_PROFILES[k].rate.en, "+3%");
});

test("W6b: a news clip is read urgent with the lead lifted and a short pause before the detail", () => {
  const ssml = clipSsml("Good morning. We begin with breaking news. A clinic network says its systems were locked.\n\nMore later.", "en");
  assert.match(ssml, /rate="\+3%" pitch="\+4%"/);
  assert.match(ssml, /<prosody pitch="\+7%" volume="\+15%">Good morning\. We begin with breaking news\.<\/prosody><break time="260ms"\/>A clinic network/);
  assert.match(ssml, /<break time="325ms"\/>More later\./);
});

test("W6b: narration made at an earlier urgency (or none recorded) is made again, and the style recorded", async () => {
  const sc = { injects: [{ title: "A", desc: "a" }] };
  const p = planMedia(sc, { items: { "0": { narration: { en: "narration/x/a.mp3" }, narration_voice: { en: "en-GB-RyanNeural" }, narration_style: { en: "en-GB-RyanNeural|urgent-low|w6b" } } } }, { langs: ["en"], what: "narration" });
  assert.equal(p.narration.length, 1);
  const w = world({ media: { items: { "2": { narration: { en: "narration/old.mp3" }, narration_voice: { en: "en-GB-RyanNeural" } } } } });
  await runMediaPrepare(w.deps, { session_id: SID, langs: ["en"], what: "narration", samples: false });
  assert.equal(last(w).items["2"].narration_style.en, styleKey("en", "brisk"));
});

test("W6b: narration \"off\" (the scenario skill's wording) is treated like false; a News header is read urgent", () => {
  const sc = { injects: [{ title: "A", desc: "a", narration: "off", video: { script_en: "News." } }, { title: "B", desc: "b", narration: "on" }] };
  const p = planMedia(sc, {}, { langs: ["en"] });
  assert.deepEqual(p.narration.map((j) => j.index), [1]);
  assert.equal(p.clips.length, 0, "no clip for a sensitive inject either");
  assert.ok(p.skipped.some((x) => x.index === 0 && x.why === "narration_false"));
  assert.equal(urgencyOf({ desc: "News · Marsa News · 07:14\nFire at the warehouse." }), "urgent");
});

test("W6b: HeyGen v3 request — own audio, the plate, 1080p; engine and motion prompt only when chosen", () => {
  const env = { HEYGEN_AVATAR_ID: "Aditya_public_1" };
  const b = heygenRequest(env, { audioUrl: "https://a/x.mp3", backgroundUrl: "https://a/p.jpg" });
  assert.deepEqual(b, { type: "avatar", avatar_id: "Aditya_public_1", audio_url: "https://a/x.mp3", background: { type: "image", url: "https://a/p.jpg" }, resolution: "1080p", aspect_ratio: "16:9", title: "PlanProof Marsa News clip" });
  const iii = heygenRequest({ ...env, HEYGEN_ENGINE: "avatar_iii", HEYGEN_MOTION_PROMPT: "calm" }, { audioUrl: "u", backgroundUrl: "b" });
  assert.deepEqual(iii.engine, { type: "avatar_iii" });
  assert.equal(iii.motion_prompt, undefined, "no motion prompt with avatar_iii");
  const v = heygenRequest(env, { audioUrl: "u", backgroundUrl: "b", engine: "avatar_v", motionPrompt: "serious newsreader", avatarId: "other" });
  assert.equal(v.motion_prompt, "serious newsreader");
  assert.equal(v.avatar_id, "other");
  assert.equal(v.remove_background, undefined);
  const iv = heygenRequest({ ...env, HEYGEN_REMOVE_BG: "true" }, { audioUrl: "u", backgroundUrl: "b", engine: "avatar_iv", motionPrompt: "calm" });
  assert.equal(iv.motion_prompt, "calm");
  assert.equal(iv.remove_background, true);
  assert.equal(heygenRequest(env, { audioUrl: "u", backgroundUrl: "b", removeBackground: true }).remove_background, true);
  const w = heygenRequest(env, { audioUrl: "u", backgroundUrl: "b", removeBackground: true, fit: "contain", outputFormat: "webm" });
  assert.equal(w.output_format, "webm"); assert.equal(w.fit, "contain");
  assert.equal(w.background, undefined); assert.equal(w.remove_background, undefined);
});
