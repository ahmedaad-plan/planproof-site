// W6a (2 November 2026) — "Voice and video: prepare" on the admin page.
// Makes, once per exercise and days before it, the inject narration (Azure
// Speech) and the newsroom clips (Azure voice + HeyGen presenter), uploads
// them to the public bucket "exercise-media" under unguessable names, and
// records them in exercise_sessions.media. The room never calls Azure or
// HeyGen live (design: planproof-exercise-player/w6-design.md §4.3).
//
// Everything goes to Supabase with the ADMIN'S OWN sign-in (apikey = the
// publishable key, Authorization = the admin's access token with the second
// factor) — no secret key, so it works on deploy previews and production.
//
// Pure helpers (SSML, header sentence, time words, the plan) are exported for
// the unit tests (tests/media-prepare.test.mjs).

export const BUCKET = "exercise-media";
export const MAX_SCRIPT_WORDS = 130;
export const MAX_CLIPS = 6;
export const USD_PER_CLIP = 4;

export const VOICES = {
  // Ahmed, 2 November 2026: Ryan and Hamdan only (Sonia and Fatima dropped);
  // one voice per language, never English and Arabic in one recording.
  narration: { en: "en-GB-RyanNeural", ar: "ar-AE-HamdanNeural" },
  presenter: { en: "en-GB-RyanNeural", ar: "ar-AE-HamdanNeural" },
};
const RATE = { en: "-5%", ar: "-8%" }; // 0.95 / 0.92 (scripts doc §5)

// ---------- urgency (Ahmed, 2 November 2026, 19:48) ----------
// Breaking news, alerts and urgent injects must SOUND urgent: faster, a
// little higher, stronger, with short pauses. Ryan has no "news" style in
// Azure, so it is built with SSML prosody. Three levels per inject:
//   calm   — the briefing videos (clear, unhurried)
//   brisk  — ordinary emails, calls and messages
//   urgent — news clips, alerts and injects the scenario marks urgent
// The urgent strength (mild / medium / strong) was sampled for Ahmed; the one
// he picked is URGENT_LEVEL.
// Ahmed, 2 November 2026, 20:15: the first three samples were too fast and
// the wrong tone; he liked the brisk read (sample 4) and asked for low /
// medium / high urgency AT THAT SAME SPEED. So every urgent level keeps the
// brisk rate and adds urgency only through pitch, force and shorter pauses
// (samples B1–B3). "lead" lifts the first sentence a little more.
export const URGENT_PROFILES = {
  low:    { rate: { en: "+3%", ar: "-2%" }, pitch: "+2%", volume: "+5%",  gap: 0.75, lead: { pitch: "+4%",  volume: "+10%" } },
  medium: { rate: { en: "+3%", ar: "-2%" }, pitch: "+4%", volume: "+10%", gap: 0.65, lead: { pitch: "+7%",  volume: "+15%" } },
  high:   { rate: { en: "+3%", ar: "-2%" }, pitch: "+6%", volume: "+15%", gap: 0.55, lead: { pitch: "+10%", volume: "+20%" } },
};
export const URGENT_LEVEL = "medium";
export const PROFILES = {
  calm:  { rate: RATE, pitch: "+0%", volume: "+0%", gap: 1, lead: null },
  brisk: { rate: { en: "+3%", ar: "-2%" }, pitch: "+1%", volume: "+0%", gap: 0.8, lead: null },
};
// A scenario may write "urgent" (the standard level) or name one: urgent-low,
// urgent-medium, urgent-high.
export const URGENCY = ["calm", "brisk", "urgent", "urgent-low", "urgent-medium", "urgent-high"];
export function profileFor(urgency, level = URGENT_LEVEL) {
  if (urgency === "urgent") return URGENT_PROFILES[level];
  if (typeof urgency === "string" && urgency.startsWith("urgent-") && URGENT_PROFILES[urgency.slice(7)]) return URGENT_PROFILES[urgency.slice(7)];
  return PROFILES[urgency] || PROFILES.brisk;
}
export function urgencyOf(inject) {
  if (!inject) return "brisk";
  if (URGENCY.includes(inject.urgency)) return inject.urgency;
  const v = inject.video;
  if (v && (v.script_en || v.script_ar)) return "urgent";
  const parts = messageParts(inject.desc || "");
  if (parts.header && /alert|alarm|breaking|system|news/i.test(parts.header[0] || "")) return "urgent";
  return "brisk";
}
// What a narration file was made with; a different key means "make it again".
export function styleKey(lang, urgency) {
  const v = VOICES.narration[lang];
  return urgency === "urgent" ? `${v}|urgent-${URGENT_LEVEL}|w6b2` : `${v}|${urgency}|w6b2`;
}
const XML_LANG = { en: "en-GB", ar: "ar-AE" };
const AUDIO_FORMAT = "audio-48khz-192kbitrate-mono-mp3";
const AUDIO_BITRATE = 192000;

// ---------- text helpers ----------
export function xmlEscape(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
export function wordCount(s) {
  return String(s ?? "").trim().split(/\s+/).filter(Boolean).length;
}

const EN_UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const EN_TENS = { 2: "twenty", 3: "thirty", 4: "forty", 5: "fifty" };
function enNumber(n) {
  if (n < 20) return EN_UNITS[n];
  const t = Math.floor(n / 10), u = n % 10;
  return EN_TENS[t] + (u ? "-" + EN_UNITS[u] : "");
}
// "07:12" → "seven twelve"; "07:05" → "seven oh five"; "07:00" → "seven o'clock"; "13:20" → "thirteen twenty".
export function timeWordsEn(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const hw = h === 0 ? "zero" : enNumber(h);
  if (mi === 0) return `${hw} o'clock`;
  if (mi < 10) return `${hw} oh ${EN_UNITS[mi]}`;
  return `${hw} ${enNumber(mi)}`;
}

// Arabic: «في الساعة السابعة واثنتي عشرة دقيقة» — the hour as a feminine ordinal
// (12-hour clock, with صباحاً / مساءً), the minutes in the genitive.
const AR_HOURS = ["الثانية عشرة", "الواحدة", "الثانية", "الثالثة", "الرابعة", "الخامسة", "السادسة", "السابعة", "الثامنة", "التاسعة", "العاشرة", "الحادية عشرة", "الثانية عشرة"];
const AR_UNITS_F = ["", "واحدة", "اثنتين", "ثلاث", "أربع", "خمس", "ست", "سبع", "ثماني", "تسع"]; // counting a feminine noun, genitive
const AR_TENS_G = { 2: "عشرين", 3: "ثلاثين", 4: "أربعين", 5: "خمسين" };
function arMinutesGenitive(mi) {
  if (mi === 1) return "دقيقة واحدة";
  if (mi === 2) return "دقيقتين";
  if (mi >= 3 && mi <= 9) return `${AR_UNITS_F[mi]} دقائق`;
  if (mi === 10) return "عشر دقائق";
  if (mi === 11) return "إحدى عشرة دقيقة";
  if (mi === 12) return "اثنتي عشرة دقيقة";
  if (mi >= 13 && mi <= 19) return `${AR_UNITS_F[mi - 10]} عشرة دقيقة`;
  const t = Math.floor(mi / 10), u = mi % 10;
  if (!u) return `${AR_TENS_G[t]} دقيقة`;
  const unit = u === 1 ? "إحدى" : u === 2 ? "اثنتين" : AR_UNITS_F[u];
  return `${unit} و${AR_TENS_G[t]} دقيقة`;
}
export function timeWordsAr(hhmm) {
  const m = String(hhmm || "").match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  const hour = AR_HOURS[h % 12 === 0 ? 0 : h % 12];
  const period = h < 12 ? "صباحاً" : "مساءً";
  const mins = mi === 0 ? "تماماً" : `و${arMinutesGenitive(mi)}`;
  return `في الساعة ${hour} ${mins} ${period}`;
}

// The v7 header line, exactly as the player reads it (shared.js injectMessageParts).
export function messageParts(desc) {
  const d = String(desc || "");
  const nl = d.indexOf("\n");
  const first = (nl >= 0 ? d.slice(0, nl) : d).trim();
  const rest = nl >= 0 ? d.slice(nl + 1).replace(/^\s+/, "") : "";
  if (nl < 0 || !rest || first.length > 220 || first.indexOf(" · ") < 0) return { header: null, body: d };
  return { header: first.split(" · ").map((x) => x.trim()).filter(Boolean), body: rest };
}

const CHANNEL_EN = [
  [/mail/i, "An email"], [/call|phone/i, "A phone call"], [/alert|alarm|system/i, "An alert"],
  [/situation|update/i, "A situation update"], [/letter|notice/i, "A letter"],
];
const CHANNEL_AR = [
  [/بريد|mail/i, "رسالة بريد إلكتروني"], [/مكالمة|هاتف|call|phone/i, "مكالمة هاتفية"], [/تنبيه|إنذار|alert|alarm/i, "تنبيه"],
  [/تحديث|update/i, "تحديث للموقف"], [/خطاب|رسالة رسمية|letter/i, "خطاب"],
];
// "Email · From: Head of IT · To: Crisis Management Team · 07:12" →
// "An email from Head of IT to the Crisis Management Team, at seven twelve."
export function headerSentence(header, lang) {
  if (!header || !header.length) return null;
  const [channel, ...rest] = header;
  let from = null, to = null, time = null;
  for (const seg of rest) {
    let mm;
    if ((mm = seg.match(/^(?:from|من)\s*:\s*(.+)$/i))) from = mm[1].trim();
    else if ((mm = seg.match(/^(?:to|إلى|الى)\s*:\s*(.+)$/i))) to = mm[1].trim();
    else if (/^\d{1,2}[:.]\d{2}$/.test(seg)) time = seg;
  }
  if (lang === "ar") {
    const ch = (CHANNEL_AR.find(([re]) => re.test(channel)) || [null, channel])[1];
    let s = ch;
    if (from) s += ` من ${from}`;
    if (to) s += ` إلى ${to}`;
    const tw = time && timeWordsAr(time);
    if (tw) s += `، ${tw}`;
    return s + ".";
  }
  const ch = (CHANNEL_EN.find(([re]) => re.test(channel)) || [null, channel])[1];
  let s = ch;
  if (from) s += ` from ${withThe(from)}`;
  if (to) s += ` to ${withThe(to)}`;
  const tw = time && timeWordsEn(time);
  if (tw) s += `, at ${tw}`;
  return s + ".";
}
// "Head of IT" → "the Head of IT"; "Crisis Management Team" → "the Crisis Management Team".
// Personal-sounding or already-determined names are left alone.
function withThe(x) {
  if (/^(the|a|an|our|your|mr|ms|mrs|dr)\b/i.test(x)) return x;
  return "the " + x;
}

// The inject text for one language: English from title/desc; Arabic only
// from the scenario's Arabic fields (title_ar / desc_ar) — never English text
// read by an Arabic voice.
export function injectText(inject, lang) {
  if (lang === "ar") {
    const t = inject.title_ar, d = inject.desc_ar;
    if (!t && !d) return null;
    return { title: t || "", desc: d || "" };
  }
  return { title: inject.title || "", desc: inject.desc || "" };
}

export function narrationSsml(inject, lang, voice = VOICES.narration[lang], urgency = urgencyOf(inject)) {
  const txt = injectText(inject, lang);
  if (!txt) return null;
  const parts = messageParts(txt.desc);
  const prof = profileFor(urgency);
  const lead = (t) => prof.lead ? `<prosody pitch="${prof.lead.pitch}" volume="${prof.lead.volume}">${t}</prosody>` : t;
  const out = [];
  if (parts.header) {
    out.push(lead(xmlEscape(headerSentence(parts.header, lang))), '<break time="400ms"/>');
    let body = parts.body;
    const sm = body.match(/^(EXERCISE|تمرين)\s*[–—:-]\s*([^\n]*)\n+/i);
    if (sm) {
      out.push(lang === "ar" ? "تمرين." : "Exercise.", '<break time="400ms"/>', xmlEscape(sm[2].trim()), '<break time="300ms"/>');
      body = body.slice(sm[0].length);
    }
    out.push('<break time="600ms"/>', paragraphs(body));
  } else {
    if (txt.title) out.push(lead(xmlEscape(txt.title)), '<break time="600ms"/>');
    out.push(paragraphs(txt.desc));
  }
  return speakStyled(lang, voice, prof, out.join(""));
}
function scaleBreaks(inner, gap) {
  if (gap === 1) return inner;
  return inner.replace(/<break time="(\d+)ms"\/>/g, (m, n) => `<break time="${Math.max(120, Math.round(Number(n) * gap))}ms"/>`);
}
export function speakStyled(lang, voice, prof, inner) {
  const attrs = `rate="${prof.rate[lang]}"` + (prof.pitch !== "+0%" ? ` pitch="${prof.pitch}"` : "") + (prof.volume !== "+0%" ? ` volume="${prof.volume}"` : "");
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${XML_LANG[lang]}">` +
    `<voice name="${voice}"><prosody ${attrs}>${scaleBreaks(inner, prof.gap)}</prosody></voice></speak>`;
}
function paragraphs(text) {
  return String(text || "").split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean)
    .map(xmlEscape).join('<break time="500ms"/>');
}
function speak(lang, voice, rate, inner) {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${XML_LANG[lang]}">` +
    `<voice name="${voice}"><prosody rate="${rate}">${inner}</prosody></voice></speak>`;
}

// A presenter clip's audio: the script, paragraph breaks become the half-second
// pause between the lead and the detail (scripts doc §4.1).
export function clipSsml(script, lang, voice = VOICES.presenter[lang], urgency = "urgent") {
  // W6b: news clips are read urgent; the first sentence ("We begin with
  // breaking news.") is lifted a little more, then a short pause.
  const prof = profileFor(urgency);
  const paras = String(script || "").split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  if (!paras.length) return speakStyled(lang, voice, prof, "");
  return speakStyled(lang, voice, prof, leadSentences(paras[0], prof) +
    (paras.length > 1 ? '<break time="500ms"/>' + paras.slice(1).map(xmlEscape).join('<break time="500ms"/>') : ""));
}
// "Good morning. We begin with breaking news. A network…": the greeting and the
// "breaking news" sentence are the lead; a short pause before the detail.
function leadSentences(p, prof) {
  const sent = p.match(/[^.!?؟]+[.!?؟]+|[^.!?؟]+$/g) || [p];
  let k = sent.findIndex((x) => /breaking news|عاجل|returning to our top story|نعود إلى|we go now|ننتقل الآن/i.test(x));
  if (k < 0) k = 0;
  const head = sent.slice(0, k + 1).map((x) => xmlEscape(x.trim())).join(" ");
  const tail = sent.slice(k + 1).map((x) => xmlEscape(x.trim())).join(" ");
  const h = prof.lead ? `<prosody pitch="${prof.lead.pitch}" volume="${prof.lead.volume}">${head}</prosody>` : head;
  return tail ? `${h}<break time="400ms"/>${tail}` : h;
}

// Where the lower-third changes to headline2: the start of the second
// paragraph, as a share of the spoken words, in seconds of the audio.
export function clipCues(script, duration, video) {
  if (!video || !video.headline2 || !duration) return [];
  const paras = String(script || "").split(/\n\s*\n/).filter((p) => p.trim());
  if (paras.length < 2) return [];
  const total = wordCount(script);
  const before = wordCount(paras[0]);
  return [{ at: Math.round((before / total) * duration * 10) / 10, line: 2 }];
}

export function mp3Duration(bytes) {
  return Math.round((bytes * 8 / AUDIO_BITRATE) * 10) / 10;
}

// ---------- the plan: what this run makes ----------
// Returns { narration: [{index, lang}], clips: [{index, lang, script}], refused: [{index, lang, kind, reason}] }.
export function planMedia(scenario, media, opts = {}) {
  const langs = (opts.langs && opts.langs.length ? opts.langs : ["en", "ar"]).filter((l) => l === "en" || l === "ar");
  const what = opts.what || "all";
  const force = !!opts.force;
  const items = (media && media.items) || {};
  const injects = Array.isArray(scenario && scenario.injects) ? scenario.injects : [];
  const plan = { narration: [], clips: [], refused: [], skipped: [], langsUsed: langs };
  let clipInjects = 0;
  injects.forEach((inj, i) => {
    const k = String(i);
    const have = items[k] || {};
    // The scenario skill writes narration "on" / "off"; older files use false (W6b).
    const sensitive = inj && (inj.narration === false || String(inj.narration).toLowerCase() === "off");
    if (sensitive) { plan.skipped.push({ index: i, why: "narration_false" }); return; }
    if (what === "all" || what === "narration") {
      for (const lang of langs) {
        if (!injectText(inj, lang)) { plan.skipped.push({ index: i, lang, kind: "narration", why: "no_text_in_language" }); continue; }
        // A file made with an earlier voice or urgency is made again (W6b).
        const sameStyle = have.narration_style && have.narration_style[lang] === styleKey(lang, urgencyOf(inj));
        if (!force && have.narration && have.narration[lang] && sameStyle) continue;
        plan.narration.push({ index: i, lang });
      }
    }
    const v = inj && inj.video;
    if ((what === "all" || what === "clips") && v && (v.script_en || v.script_ar)) {
      clipInjects += 1;
      for (const lang of langs) {
        const script = v["script_" + lang];
        if (!script) continue;
        if (clipInjects > MAX_CLIPS) { plan.refused.push({ index: i, lang, kind: "clip", reason: `More than ${MAX_CLIPS} news clips in one exercise.` }); continue; }
        const wc = wordCount(script);
        if (wc > MAX_SCRIPT_WORDS) { plan.refused.push({ index: i, lang, kind: "clip", reason: `The script has ${wc} words; the limit is ${MAX_SCRIPT_WORDS}.` }); continue; }
        if (!force && have.clip && have.clip[lang] && have.clip[lang].path) continue;
        plan.clips.push({ index: i, lang, script });
      }
    }
  });
  plan.estimate_usd = plan.clips.length * USD_PER_CLIP;
  return plan;
}

// ---------- the voice samples for Ahmed (W6a, scripts doc §8) ----------
// Four short files, made once (kept under samples/ — no client data): Sonia
// reading A2, Fatima reading A5 and A6 (English button names inside Arabic),
// Ryan and Hamdan reading the demo clip's lead. Samples 1 and 2 keep the
// voices they were made with (Ahmed dropped Sonia and Fatima, 2 November
// 2026); the files already exist, so they are never made again.
const br = (ms) => `<break time="${ms}ms"/>`;
export const SAMPLES = [
  { name: "w6a-sample-1-sonia-en-A2.mp3", lang: "en", voice: "en-GB-SoniaNeural", rate: RATE.en,
    inner: `First, the most important thing.${br(500)}This exercise tests the plan,${br(250)} not individuals. Findings are reported at team level, and the report names no one.` },
  { name: "w6a-sample-2-fatima-ar-A5-A6.mp3", lang: "ar", voice: "ar-AE-FatimaNeural", rate: RATE.ar,
    inner: `اضغطوا ${br(350)}"Submit answer" قبل انتهاء الوقت. وحتى ذلك الحين، يمكنكم التعديل بزر ${br(350)}"Edit answer"، ثم اضغطوا ${br(350)}"Submit changes".${br(600)}` +
      `تحتاجون وقتاً إضافياً؟ من Messages أرسلوا ${br(350)}"We need a few more minutes". وإذا مُنح وقت إضافي، فهو للجميع. وتظهر رسائل الميسّر في أعلى الشاشة: Reply للرد، أو Got it للتأكيد.` },
  { name: "w6a-sample-3-ryan-en-demo-lead.mp3", lang: "en", voice: VOICES.presenter.en, rate: "0%",
    inner: `Good morning. We begin with breaking news.${br(500)}A network of private clinics in the UAE says its patient-record systems were locked by a cyber-attack early this morning.` },
  { name: "w6a-sample-4-hamdan-ar-demo-lead.mp3", lang: "ar", voice: VOICES.presenter.ar, rate: "0%",
    inner: `صباح الخير. نبدأ بخبر عاجل.${br(500)}تقول شبكة عيادات خاصة في دولة الإمارات إن أنظمة سجلات المرضى لديها تعطّلت جرّاء هجوم إلكتروني في ساعات الصباح الأولى.` },
];
export const sampleSsml = (x) => speak(x.lang, x.voice, x.rate, x.inner);
async function ensureSamples(deps, api, note) {
  const made = [];
  for (const x of SAMPLES) {
    const path = `samples/${x.name}`;
    if (await api.exists(path)) continue;
    const audio = await azureTts(deps, sampleSsml(x));
    await api.upload(path, audio, "audio/mpeg");
    made.push(path);
  }
  if (made.length) note(`Voice samples made: ${made.length}.`);
  return SAMPLES.map((x) => api.publicUrl(`samples/${x.name}`));
}

// ---------- the run ----------
export function jwtClaims(token) {
  try {
    const p = String(token).split(".")[1];
    return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  } catch { return null; }
}
const uuid = () => (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function sb(deps) {
  const { env, token } = deps;
  const base = env.SUPABASE_URL;
  const h = (extra = {}) => ({ apikey: env.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, ...extra });
  async function req(path, init) {
    const res = await deps.fetchFn(base + path, { ...init, signal: AbortSignal.timeout(deps.timeoutMs ?? 60000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path.split("?")[0]} → HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }
  return {
    rpc: (name, args) => req(`/rest/v1/rpc/${name}`, { method: "POST", headers: h({ "Content-Type": "application/json" }), body: JSON.stringify(args || {}) }),
    upload: (path, bytes, type) => req(`/storage/v1/object/${BUCKET}/${path}`, {
      method: "POST", headers: h({ "Content-Type": type, "x-upsert": "true", "Cache-Control": "max-age=31536000" }), body: bytes }),
    publicUrl: (path) => `${base}/storage/v1/object/public/${BUCKET}/${path}`,
    exists: async (path) => {
      const res = await deps.fetchFn(`${base}/storage/v1/object/public/${BUCKET}/${path}`, { method: "HEAD", signal: AbortSignal.timeout(15000) });
      return res.ok;
    },
  };
}

export async function azureTts(deps, ssml) {
  const { env } = deps;
  const res = await deps.fetchFn(`https://${env.SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": env.SPEECH_API_KEY, "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": AUDIO_FORMAT, "User-Agent": "planproof-media-prepare" },
    body: ssml, signal: AbortSignal.timeout(deps.timeoutMs ?? 60000),
  });
  if (!res.ok) throw new Error(`Azure Speech → HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error("Azure Speech returned an empty file.");
  return buf;
}

// HeyGen v3 (W6b, 2 November 2026): v1/v2 were supported only until
// 31 October 2026. POST /v3/videos (type "avatar", our own audio by URL, the
// newsroom plate as the background), then GET /v3/videos/{id} until
// completed. The engine (avatar_iii keeps the actor's recorded motion and
// only syncs the lips; avatar_iv generates the face from the audio; avatar_v
// takes a motion prompt) is chosen with the presenter: HEYGEN_ENGINE,
// HEYGEN_MOTION_PROMPT (avatar_v only).
export function heygenRequest(env, { audioUrl, backgroundUrl, engine, motionPrompt, avatarId }) {
  const body = { type: "avatar", avatar_id: avatarId || env.HEYGEN_AVATAR_ID, audio_url: audioUrl,
    background: { type: "image", url: backgroundUrl }, resolution: "1080p", aspect_ratio: "16:9", title: "PlanProof Marsa News clip" };
  const eng = engine || env.HEYGEN_ENGINE;
  if (eng) body.engine = { type: eng };
  const mp = motionPrompt || env.HEYGEN_MOTION_PROMPT;
  if (mp && eng === "avatar_v") body.motion_prompt = String(mp).slice(0, 400);
  return body;
}
export async function heygenClip(deps, opts) {
  const { env } = deps;
  const H = { "X-Api-Key": env.HEYGEN_API_KEY, "Content-Type": "application/json", Accept: "application/json" };
  const gen = await deps.fetchFn("https://api.heygen.com/v3/videos", {
    method: "POST", headers: H, signal: AbortSignal.timeout(60000), body: JSON.stringify(heygenRequest(env, opts)),
  });
  const gj = await gen.json().catch(() => ({}));
  const id = gj && gj.data && (gj.data.video_id || gj.data.id);
  if (!gen.ok || !id) throw new Error(`HeyGen → HTTP ${gen.status}: ${JSON.stringify(gj.error || gj.message || gj).slice(0, 200)}`);
  const started = deps.now();
  const limit = deps.clipTimeoutMs ?? 12 * 60 * 1000;
  for (;;) {
    await deps.sleep(deps.pollMs ?? 15000);
    const st = await deps.fetchFn(`https://api.heygen.com/v3/videos/${encodeURIComponent(id)}`, { headers: H, signal: AbortSignal.timeout(30000) });
    const sj = await st.json().catch(() => ({}));
    const d = (sj && sj.data) || {};
    if (d.status === "completed" && d.video_url) {
      const mp4 = await deps.fetchFn(d.video_url, { signal: AbortSignal.timeout(120000) });
      if (!mp4.ok) throw new Error(`HeyGen video download → HTTP ${mp4.status}`);
      return { bytes: new Uint8Array(await mp4.arrayBuffer()), duration: d.duration || null, heygen_id: id };
    }
    if (d.status === "failed" || d.status === "cancelled") throw new Error(`HeyGen could not make the clip: ${String(d.failure_message || d.failure_code || JSON.stringify(d.error || "")).slice(0, 200)}`);
    if (deps.now() - started > limit) throw new Error("HeyGen took longer than 12 minutes; press Retry failed later.");
  }
}

// The newsroom plate behind the presenter (bundled with the function; uploaded once).
async function ensurePlate(deps, api, lang) {
  const path = `plates/marsa-${lang}.jpg`;
  if (await api.exists(path)) return api.publicUrl(path);
  const bytes = await deps.readPlate(lang);
  await api.upload(path, bytes, "image/jpeg");
  return api.publicUrl(path);
}

// args: { session_id, langs, what, force }.  deps: { fetchFn, env, token, now, sleep, readPlate, log }
export async function runMediaPrepare(deps, args) {
  const log = deps.log || (() => {});
  const { env } = deps;
  // W6b: the media studio (one-time pass, secret key, production only) passes
  // its own storage/database helper as deps.service instead of an admin sign-in.
  const service = deps.service || null;
  let api, sess;
  if (service) {
    if (!/^[0-9a-f-]{36}$/i.test(String(args.session_id || ""))) return { ok: false, error: "Bad session." };
    api = service;
    const rows = await api.select("exercise_sessions", `id=eq.${args.session_id}&select=status,scenario,media`);
    if (!rows || !rows[0]) return { ok: false, error: "No such exercise." };
    sess = rows[0];
  } else {
    const claims = jwtClaims(deps.token);
    if (!claims || claims.aal !== "aal2") return { ok: false, error: "Sign in with your authenticator first." };
    if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) return { ok: false, error: "The database settings are missing." };
    api = sb(deps);
    const isAdmin = await api.rpc("admin_whoami");
    if (isAdmin !== true) return { ok: false, error: "Not authorised." };
    sess = await api.rpc("admin_session_scenario", { p_session: args.session_id });
  }
  if (sess.status === "running") return { ok: false, error: "This exercise is running; prepare voice and video before it starts." };

  const media = { items: {}, ...(sess.media || {}) };
  media.items = { ...(media.items || {}) };
  const plan = planMedia(sess.scenario, media, args);
  const prevLog = Array.isArray(media.log) ? media.log.slice(-40) : [];
  const runLog = [];
  const note = (msg) => { runLog.push({ at: new Date(deps.now()).toISOString(), msg }); log(msg); };
  const failures = {};
  const total = plan.narration.length + plan.clips.length;
  let done = 0;
  const save = async (status) => {
    const failedCount = Object.values(media.items).reduce((n, it) => n + Object.keys((it && it.failed) || {}).length, 0);
    const out = { ...media, status, langs: plan.langsUsed, updated_at: new Date(deps.now()).toISOString(),
      progress: { done, total }, counts: countMedia(media), failed_count: failedCount,
      refused: plan.refused, skipped: plan.skipped, estimate_usd: plan.estimate_usd, log: [...prevLog, ...runLog].slice(-60) };
    if (status === "ready" || status === "failed") out.prepared_at = out.updated_at;
    if (service) await api.patch("exercise_sessions", `id=eq.${args.session_id}`, { media: out });
    else await api.rpc("admin_set_media", { p_session: args.session_id, p_media: out });
  };
  const fail = (i, key, err) => {
    const k = String(i);
    media.items[k] = { ...(media.items[k] || {}) };
    media.items[k].failed = { ...(media.items[k].failed || {}), [key]: String(err.message || err).slice(0, 200) };
    failures[`${k}:${key}`] = true;
    note(`Inject ${i + 1} ${key}: ${String(err.message || err).slice(0, 200)}`);
  };
  const clearFail = (i, key) => {
    const it = media.items[String(i)];
    if (it && it.failed) { delete it.failed[key]; if (!Object.keys(it.failed).length) delete it.failed; }
  };

  note(`Start: ${plan.narration.length} narration file(s), ${plan.clips.length} clip(s)${plan.clips.length ? ` (about USD ${plan.estimate_usd})` : ""}.`);
  await save("preparing");

  const speechReady = !!(env.SPEECH_API_KEY && env.SPEECH_REGION);
  if (speechReady && args.samples !== false) {
    try { media.samples = await ensureSamples(deps, api, note); } catch (err) { note(`Voice samples: ${String(err.message || err).slice(0, 160)}`); }
  }
  for (const job of plan.narration) {
    const key = `narration_${job.lang}`;
    try {
      if (!speechReady) throw new Error("The speech service settings (SPEECH_API_KEY, SPEECH_REGION) are missing.");
      const ssml = narrationSsml(sess.scenario.injects[job.index], job.lang);
      const audio = await azureTts(deps, ssml);
      const path = `narration/${args.session_id}/${uuid()}.mp3`;
      await api.upload(path, audio, "audio/mpeg");
      const k = String(job.index);
      media.items[k] = { ...(media.items[k] || {}) };
      media.items[k].narration = { ...(media.items[k].narration || {}), [job.lang]: path };
      media.items[k].narration_voice = { ...(media.items[k].narration_voice || {}), [job.lang]: VOICES.narration[job.lang] };
      media.items[k].narration_style = { ...(media.items[k].narration_style || {}), [job.lang]: styleKey(job.lang, urgencyOf(sess.scenario.injects[job.index])) };
      media.items[k].narration_duration = { ...(media.items[k].narration_duration || {}), [job.lang]: mp3Duration(audio.length) };
      clearFail(job.index, key);
    } catch (err) { fail(job.index, key, err); }
    done += 1;
    await save("preparing");
  }

  for (const job of plan.clips) {
    const key = `clip_${job.lang}`;
    try {
      if (!speechReady) throw new Error("The speech service settings are missing.");
      if (!env.HEYGEN_API_KEY) throw new Error("HEYGEN_API_KEY is not set in Netlify yet.");
      if (!env.HEYGEN_AVATAR_ID) throw new Error("HEYGEN_AVATAR_ID (the chosen presenter) is not set in Netlify yet.");
      const audio = await azureTts(deps, clipSsml(job.script, job.lang));
      const audioPath = `clips/${args.session_id}/${uuid()}.mp3`;
      await api.upload(audioPath, audio, "audio/mpeg");
      const plate = await ensurePlate(deps, api, job.lang);
      const clip = await heygenClip(deps, { audioUrl: api.publicUrl(audioPath), backgroundUrl: plate });
      const path = `clips/${args.session_id}/${uuid()}.mp4`;
      await api.upload(path, clip.bytes, "video/mp4");
      const duration = clip.duration || mp3Duration(audio.length);
      const video = (sess.scenario.injects[job.index] || {}).video || {};
      const k = String(job.index);
      media.items[k] = { ...(media.items[k] || {}) };
      media.items[k].clip = { ...(media.items[k].clip || {}), [job.lang]: { path, audio: audioPath, duration,
        cues: clipCues(job.script, mp3Duration(audio.length), video), heygen_id: clip.heygen_id } };
      clearFail(job.index, key);
      note(`Inject ${job.index + 1}: ${job.lang} clip made (${duration} s).`);
    } catch (err) { fail(job.index, key, err); }
    done += 1;
    await save("preparing");
  }

  const anyFailed = Object.keys(failures).length > 0 ||
    Object.values(media.items).some((it) => it && it.failed && Object.keys(it.failed).length);
  note(anyFailed ? "Finished with problems — press Retry failed." : "Finished.");
  await save(anyFailed ? "failed" : "ready");
  return { ok: !anyFailed, plan: { narration: plan.narration.length, clips: plan.clips.length, refused: plan.refused.length }, counts: countMedia(media) };
}

export function countMedia(media) {
  const items = (media && media.items) || {};
  let narration = 0, clips = 0;
  for (const it of Object.values(items)) {
    if (it && it.narration) narration += Object.keys(it.narration).length;
    if (it && it.clip) clips += Object.values(it.clip).filter((c) => c && c.path).length;
  }
  return { narration, clips };
}
