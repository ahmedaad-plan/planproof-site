// Shared helpers for the exercise-player prototype (room-display.html and
// facilitator-test.html). This is a PROTOTYPE: it proves the real-time
// mechanism (facilitator action -> Supabase row update -> room display
// updates instantly) and the audio/video-per-inject mechanism, using
// synthesized placeholder sound effects and placeholder video cards instead
// of a real licensed sound/video library. Swap PLACEHOLDER_SFX for real
// audio files later without changing how injects reference them.

const SUPABASE_URL = "https://qryfayienxrngavhwfgw.supabase.co";
// Using the legacy anon JWT key here, not the newer sb_publishable_... key —
// this project's REST/Realtime gateway returned HTTP 400 for the new format,
// but the legacy key is the one already proven working (it's what the
// Netlify form function uses for inserts).
const SUPABASE_PUBLISHABLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFyeWZheWllbnhybmdhdmh3Zmd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA5NTQ3MTcsImV4cCI6MjEwNjUzMDcxN30.AeLL04BiZwqwjNqEvV9dwCKK07Wf7HUN149L0k0fXGQ";

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

// --- Real sound effects (licensed clips Ahmed sourced from Zapsplat /
// Smartsound), replacing the earlier synthesized placeholders. Every inject
// references its effect by this same short name ("sfx"), so adding a new
// sound later is just: drop the file in play/sfx/ and add one line here.
const SFX_FILES = {
  "siren-firetruck": "sfx/siren-firetruck.mp3",
  "siren-ambulance": "sfx/siren-ambulance.mp3",
  "siren-police": "sfx/siren-police.mp3",
  fire: "sfx/fire.mp3",
  earthquake: "sfx/earthquake.mp3",
  storm: "sfx/storm.mp3",
  flood: "sfx/flood.mp3",
  "news-bed": "sfx/news-bed.mp3",
  explosion: "sfx/explosion.mp3",
  thunder: "sfx/thunder.mp3",
  thunderstorm: "sfx/thunderstorm.mp3",
  "phone-ring": "sfx/phone-ring.mp3",
  "phone-busy": "sfx/phone-busy.mp3",
  "alarm-computer": "sfx/alarm-computer.mp3",
  "roller-coaster": "sfx/roller-coaster.mp3",
  stampede: "sfx/stampede.mp3",
  // Realistic automatic-gunfire burst, for an armed-threat/lockdown inject.
  // IMPORTANT: unlike every other sound here, this one should never be
  // triggered on a live room-display without first telling the room it's
  // coming — a sudden realistic gunshot can be mistaken for a real threat
  // and can alarm people outside the exercise room too. When designing a
  // scenario that uses it, call this out explicitly to the facilitator.
  gunfire: "sfx/gunfire.mp3",
};

// Ambience tracks (long, meant to loop under an inject) vs. one-shot signature
// sounds (sirens, the earthquake rumble, explosion, a single thunder crack)
// that should just play through once per inject and not restart on a loop.
const SFX_LOOP = new Set(["fire", "storm", "flood", "news-bed", "thunderstorm", "roller-coaster"]);
// How long an ambience track plays before fading out, in seconds — long
// enough to register, short enough not to drone under the whole inject.
const AMBIENCE_PLAY_SECONDS = 18;

const sfxAudioCache = {};
let currentSfxAudio = null;

function playSfx(name) {
  if (!name || name === "none") return;
  const path = SFX_FILES[name];
  if (!path) {
    console.warn(`No sound file mapped for sfx "${name}"`);
    return;
  }

  // Stop whatever's currently playing so sounds don't stack on a fast
  // facilitator advance.
  if (currentSfxAudio) {
    currentSfxAudio.pause();
    currentSfxAudio.currentTime = 0;
  }

  if (!sfxAudioCache[name]) {
    sfxAudioCache[name] = new Audio(path);
  }
  const audio = sfxAudioCache[name];
  audio.loop = false;
  audio.volume = 0.8;
  audio.currentTime = 0;
  currentSfxAudio = audio;

  audio.play().catch((err) => {
    // Most common cause: no user gesture has unlocked audio yet (the
    // "Tap to begin" screen handles this on room-display.html).
    console.warn(`Playback blocked for "${name}":`, err.message);
  });

  if (SFX_LOOP.has(name)) {
    audio.loop = true;
    setTimeout(() => {
      if (currentSfxAudio === audio) {
        audio.pause();
        audio.currentTime = 0;
      }
    }, AMBIENCE_PLAY_SECONDS * 1000);
  }
}
