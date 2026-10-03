// Shared helpers for the exercise-player prototype (room-display.html and
// facilitator-test.html). This is a PROTOTYPE: it proves the real-time
// mechanism (facilitator action -> Supabase row update -> room display
// updates instantly) and the audio/video-per-inject mechanism, using
// synthesized placeholder sound effects and placeholder video cards instead
// of a real licensed sound/video library. Swap PLACEHOLDER_SFX for real
// audio files later without changing how injects reference them.

const SUPABASE_URL = "https://qryfayienxrngavhwfgw.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_7jiMcaR_m87y9Avu5bZs9g_KdLij01H";

function getSessionId() {
  const params = new URLSearchParams(window.location.search);
  return params.get("session");
}

async function fetchSession(sessionId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/exercise_sessions?id=eq.${sessionId}&select=*`,
    {
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      },
    }
  );
  if (!res.ok) throw new Error(`Fetch session failed: HTTP ${res.status}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function patchSession(sessionId, fields) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/exercise_sessions?id=eq.${sessionId}`,
    {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
    }
  );
  if (!res.ok) throw new Error(`Update session failed: HTTP ${res.status}`);
}

// Subscribes to live changes on one session row. Calls onChange(newRow) every
// time it changes (facilitator action, or anyone else's update). Uses the
// Supabase Realtime client, loaded from CDN by the page.
function subscribeToSession(supabaseClient, sessionId, onChange) {
  return supabaseClient
    .channel(`session-${sessionId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "exercise_sessions",
        filter: `id=eq.${sessionId}`,
      },
      (payload) => onChange(payload.new)
    )
    .subscribe();
}

// --- Placeholder sound effects, synthesized with the Web Audio API so the
// prototype needs no external audio files. Real licensed clips (siren, fire
// crackle, alarm, phone, crowd...) replace this function later; every inject
// already references its effect by name ("sfx"), so the swap is local to
// this one function.
let audioCtx = null;
function playPlaceholderSfx(name) {
  if (!name || name === "none") return;
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = audioCtx;
  const now = ctx.currentTime;

  function tone(freq, start, duration, type = "sine", gainPeak = 0.15) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, now + start);
    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(gainPeak, now + start + 0.05);
    gain.gain.linearRampToValueAtTime(0, now + start + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + duration + 0.05);
    return osc;
  }

  if (name === "siren") {
    // Rising/falling sweep, twice - stands in for a civil-defense siren.
    for (let rep = 0; rep < 2; rep++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sawtooth";
      gain.gain.setValueAtTime(0.1, now + rep * 1.6);
      osc.frequency.setValueAtTime(400, now + rep * 1.6);
      osc.frequency.linearRampToValueAtTime(900, now + rep * 1.6 + 0.8);
      osc.frequency.linearRampToValueAtTime(400, now + rep * 1.6 + 1.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + rep * 1.6);
      osc.stop(now + rep * 1.6 + 1.6);
    }
  } else if (name === "alarm") {
    // Three short urgent beeps - stands in for a notification/alarm.
    for (let i = 0; i < 3; i++) tone(880, i * 0.35, 0.2, "square", 0.08);
  } else if (name === "fire") {
    // Low rumbling noise burst - stands in for a fire/crackle ambience.
    const bufferSize = ctx.sampleRate * 1.2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = (Math.random() * 2 - 1) * 0.3;
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 500;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.2, now);
    gain.gain.linearRampToValueAtTime(0, now + 1.2);
    noise.connect(filter).connect(gain).connect(ctx.destination);
    noise.start(now);
  } else if (name === "phone") {
    for (let i = 0; i < 4; i++) tone(1000, i * 0.4, 0.3, "sine", 0.08);
  } else {
    tone(600, 0, 0.3, "sine", 0.08);
  }
}
