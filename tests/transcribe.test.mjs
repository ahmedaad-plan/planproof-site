// node --test tests/transcribe.test.mjs — the voice-note route with a fake fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { handleTranscribe, isConfigured, cleanVocabulary, shortLang, fullLang } from "../netlify/lib/transcribe-core.mjs";

const ENV = { SUPABASE_URL: "https://db.example", SUPABASE_PUBLISHABLE_KEY: "pk", SPEECH_PROVIDER: "openai", SPEECH_API_KEY: "sk" };
const SID = "11111111-1111-1111-1111-111111111111", AID = "22222222-2222-2222-2222-222222222222";
const form = (over = {}) => {
  const f = new FormData();
  f.append("audio", new Blob([new Uint8Array(100)], { type: "audio/webm" }), "clip.webm");
  f.append("session", SID); f.append("attendee", AID); f.append("lang", "en-US"); f.append("vocabulary", "RTO\nNCEMA 7000\nFinance");
  for (const [k, v] of Object.entries(over)) { f.delete(k); if (v !== null) f.append(k, v); }
  return f;
};
const fakeFetch = ({ allowed = true, providerStatus = 200, text = "Finance could not reach the approver." } = {}) => {
  const calls = [];
  return { calls, fetch: async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes("speech_allowed")) return { ok: true, json: async () => allowed };
    return { ok: providerStatus === 200, status: providerStatus, json: async () => ({ text }) };
  } };
};

test("not configured → 503 not_configured, nothing called", async () => {
  const f = fakeFetch();
  const out = await handleTranscribe({ env: { ...ENV, SPEECH_PROVIDER: "" }, fetchFn: f.fetch, form: form() });
  assert.equal(out.status, 503); assert.equal(out.body.reason, "not_configured"); assert.equal(f.calls.length, 0);
  assert.equal(isConfigured({ ...ENV, SPEECH_PROVIDER: "azure" }), false);
  assert.equal(isConfigured({ ...ENV, SPEECH_PROVIDER: "azure", SPEECH_REGION: "uaenorth" }), true);
});
test("an Observer's clip → the provider's text; the vocabulary goes with it", async () => {
  const f = fakeFetch();
  const out = await handleTranscribe({ env: ENV, fetchFn: f.fetch, form: form() });
  assert.equal(out.status, 200); assert.equal(out.body.text, "Finance could not reach the approver.");
  const allowCall = f.calls.find((c) => c.url.includes("speech_allowed"));
  assert.deepEqual(JSON.parse(allowCall.opts.body), { p_session_id: SID, p_attendee_id: AID });
  const prov = f.calls.find((c) => c.url.includes("openai"));
  assert.equal(prov.opts.body.get("language"), "en"); assert.equal(prov.opts.body.get("prompt"), "RTO, NCEMA 7000, Finance");
});
test("the facilitator link → the token is forwarded to the database check", async () => {
  const f = fakeFetch();
  const out = await handleTranscribe({ env: ENV, fetchFn: f.fetch, form: form({ attendee: null }), facilitatorToken: "tok" });
  assert.equal(out.status, 200);
  const allowCall = f.calls.find((c) => c.url.includes("speech_allowed"));
  assert.equal(allowCall.opts.headers["x-facilitator-token"], "tok");
  assert.deepEqual(JSON.parse(allowCall.opts.body), { p_session_id: SID, p_attendee_id: null });
});
test("not allowed → 403, the provider is never called", async () => {
  const f = fakeFetch({ allowed: false });
  const out = await handleTranscribe({ env: ENV, fetchFn: f.fetch, form: form() });
  assert.equal(out.status, 403); assert.ok(!f.calls.some((c) => c.url.includes("openai")));
});
test("a bad session id or no clip → refused before anything is called", async () => {
  const f = fakeFetch();
  assert.equal((await handleTranscribe({ env: ENV, fetchFn: f.fetch, form: form({ session: "nope" }) })).status, 403);
  assert.equal((await handleTranscribe({ env: ENV, fetchFn: f.fetch, form: form({ audio: null }) })).status, 400);
  assert.equal(f.calls.length, 0);
});
test("a clip over 4 MB → 413", async () => {
  const f = fakeFetch();
  const big = new FormData(); big.append("audio", new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: "audio/webm" }), "c.webm"); big.append("session", SID); big.append("attendee", AID);
  assert.equal((await handleTranscribe({ env: ENV, fetchFn: f.fetch, form: big })).status, 413);
});
test("the provider failing → 502 with a code, never a crash", async () => {
  for (const [st, code] of [[401, "provider_refused"], [429, "provider_busy"], [500, "provider_failed"]]) {
    const f = fakeFetch({ providerStatus: st });
    const out = await handleTranscribe({ env: ENV, fetchFn: f.fetch, form: form() });
    assert.equal(out.status, 502); assert.equal(out.body.reason, code);
  }
});
test("deepgram and azure adapters build their requests", async () => {
  let f = fakeFetch();
  f.fetch = ((orig) => async (url, opts) => { if (url.includes("deepgram")) { f.calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: "hello" }] }] } }) }; } return orig(url, opts); })(f.fetch);
  let out = await handleTranscribe({ env: { ...ENV, SPEECH_PROVIDER: "deepgram" }, fetchFn: f.fetch, form: form() });
  assert.equal(out.body.text, "hello");
  const dg = f.calls.find((c) => c.url.includes("deepgram")); assert.ok(dg.url.includes("keyterm=RTO")); assert.equal(dg.opts.headers.Authorization, "Token sk");
  f = fakeFetch();
  f.fetch = ((orig) => async (url, opts) => { if (url.includes("cognitive")) { f.calls.push({ url, opts }); return { ok: true, status: 200, json: async () => ({ combinedPhrases: [{ text: "one" }, { text: "two" }] }) }; } return orig(url, opts); })(f.fetch);
  out = await handleTranscribe({ env: { ...ENV, SPEECH_PROVIDER: "azure", SPEECH_REGION: "uaenorth" }, fetchFn: f.fetch, form: form() });
  assert.equal(out.body.text, "one two"); assert.ok(f.calls.find((c) => c.url.startsWith("https://uaenorth.")));
});
test("helpers", () => {
  assert.deepEqual(cleanVocabulary("RTO, NCEMA 7000\n<script>\n\n a".repeat(1)), ["RTO", "NCEMA 7000", "a"]);
  assert.equal(shortLang("ar-AE"), "ar"); assert.equal(shortLang("zz"), "zz"); assert.equal(shortLang(""), "en");
  assert.equal(fullLang("ar-AE"), "ar-AE"); assert.equal(fullLang("bad tag"), "en-US");
});
