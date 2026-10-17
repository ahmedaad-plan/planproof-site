// Voice notes (17 October 2026): turns a short recorded clip into text with
// the speech-to-text provider PlanProof chose. Logic kept apart from the
// Netlify function so it can be tested with a fake fetch.
//
// Settings (Netlify environment variables, Functions scope):
//   SPEECH_PROVIDER   "openai" | "deepgram" | "azure"   (unset = not configured:
//                     the pages then use the browser's own speech service)
//   SPEECH_API_KEY    the provider's key
//   SPEECH_REGION     Azure only, e.g. "uaenorth"
//   SPEECH_MODEL      optional (OpenAI: gpt-4o-mini-transcribe; Deepgram: nova-3)
// Who may use it: a registered Observer of the exercise (attendee id) or the
// facilitator link (token header) — checked by the database (speech_allowed).
// Nothing is stored here; the clip is forwarded and forgotten.

export const MAX_CLIP_BYTES = 4 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isConfigured(env) {
  return !!(env.SPEECH_PROVIDER && env.SPEECH_API_KEY && (env.SPEECH_PROVIDER !== "azure" || env.SPEECH_REGION));
}

// A two-letter language from a BCP-47 tag ("en-US" → "en", "ar-AE" → "ar").
export function shortLang(tag) {
  const m = /^([a-z]{2})(?:[-_]|$)/i.exec(String(tag || ""));
  return m ? m[1].toLowerCase() : "en";
}
export function fullLang(tag) {
  const s = String(tag || "").trim();
  return /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(s) ? s : "en-US";
}

// Words the provider should expect — the exercise's own vocabulary. Cleaned
// and capped so nothing odd reaches the provider.
export function cleanVocabulary(text) {
  return String(text || "")
    .split(/[\n,]+/)
    .map((w) => w.trim())
    .filter((w) => w && w.length <= 40 && /^[\p{L}\p{N}][\p{L}\p{N}\s'&.-]*$/u.test(w))
    .slice(0, 60);
}

// Does this request belong to someone who may dictate? Asks the database.
export async function allowed({ env, fetchFn, sessionId, attendeeId, facilitatorToken }) {
  if (!UUID_RE.test(sessionId || "")) return false;
  if (attendeeId && !UUID_RE.test(attendeeId)) return false;
  const headers = {
    apikey: env.SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (facilitatorToken) headers["x-facilitator-token"] = facilitatorToken;
  const res = await fetchFn(`${env.SUPABASE_URL}/rest/v1/rpc/speech_allowed`, {
    method: "POST",
    headers,
    body: JSON.stringify({ p_session_id: sessionId, p_attendee_id: attendeeId || null }),
  });
  if (!res.ok) return false;
  const out = await res.json().catch(() => null);
  return out === true;
}

// The provider call. Returns { text } or throws { code }.
export async function transcribe({ env, fetchFn, audio, mime, lang, vocabulary }) {
  const provider = env.SPEECH_PROVIDER;
  const key = env.SPEECH_API_KEY;
  const words = cleanVocabulary(vocabulary);
  if (provider === "openai") {
    const form = new FormData();
    form.append("file", new Blob([audio], { type: mime }), mime.includes("mp4") ? "clip.mp4" : "clip.webm");
    form.append("model", env.SPEECH_MODEL || "gpt-4o-mini-transcribe");
    form.append("language", shortLang(lang));
    form.append("response_format", "json");
    if (words.length) form.append("prompt", words.join(", "));
    const res = await fetchFn("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
    });
    if (!res.ok) throw providerError(res.status);
    const out = await res.json();
    return { text: String(out && out.text || "").trim() };
  }
  if (provider === "deepgram") {
    const q = new URLSearchParams({ model: env.SPEECH_MODEL || "nova-3", language: shortLang(lang), smart_format: "true", punctuate: "true" });
    words.forEach((w) => q.append("keyterm", w));
    const res = await fetchFn(`https://api.deepgram.com/v1/listen?${q}`, {
      method: "POST", headers: { Authorization: `Token ${key}`, "Content-Type": mime }, body: audio,
    });
    if (!res.ok) throw providerError(res.status);
    const out = await res.json();
    const alt = out && out.results && out.results.channels && out.results.channels[0] && out.results.channels[0].alternatives && out.results.channels[0].alternatives[0];
    return { text: String(alt && alt.transcript || "").trim() };
  }
  if (provider === "azure") {
    // Azure AI Speech, fast transcription (REST). Region from SPEECH_REGION
    // (e.g. uaenorth). The accepted audio formats are confirmed at setup time.
    const form = new FormData();
    form.append("audio", new Blob([audio], { type: mime }), mime.includes("mp4") ? "clip.mp4" : "clip.webm");
    form.append("definition", JSON.stringify({ locales: [fullLang(lang)], profanityFilterMode: "None" }));
    const res = await fetchFn(`https://${env.SPEECH_REGION}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`, {
      method: "POST", headers: { "Ocp-Apim-Subscription-Key": key }, body: form,
    });
    if (!res.ok) throw providerError(res.status);
    const out = await res.json();
    const text = out && Array.isArray(out.combinedPhrases) ? out.combinedPhrases.map((p) => p.text).join(" ") : "";
    return { text: String(text || "").trim() };
  }
  throw { code: "not_configured" };
}

function providerError(status) {
  return { code: status === 401 || status === 403 ? "provider_refused" : status === 429 ? "provider_busy" : "provider_failed", status };
}

// The whole request: checks, then the provider. Returns { status, body }.
export async function handleTranscribe({ env, fetchFn, form, facilitatorToken }) {
  if (!isConfigured(env)) return { status: 503, body: { reason: "not_configured" } };
  const sessionId = String(form.get("session") || "");
  const attendeeId = String(form.get("attendee") || "") || null;
  const lang = String(form.get("lang") || "en-US");
  const vocabulary = String(form.get("vocabulary") || "");
  const file = form.get("audio");
  if (!file || typeof file.arrayBuffer !== "function") return { status: 400, body: { reason: "no_audio" } };
  if (file.size > MAX_CLIP_BYTES) return { status: 413, body: { reason: "too_large" } };
  if (!(await allowed({ env, fetchFn, sessionId, attendeeId, facilitatorToken }))) return { status: 403, body: { reason: "not_allowed" } };
  const audio = await file.arrayBuffer();
  const mime = String(file.type || "audio/webm").split(";")[0] === "audio/mp4" ? "audio/mp4" : (file.type || "audio/webm");
  try {
    const out = await transcribe({ env, fetchFn, audio, mime, lang, vocabulary });
    return { status: 200, body: { text: out.text } };
  } catch (err) {
    const code = (err && err.code) || "provider_failed";
    return { status: code === "not_configured" ? 503 : 502, body: { reason: code } };
  }
}
