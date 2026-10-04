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

// The facilitator secret (see "Role enforcement" in design-notes.md / roadmap
// item 1). Only a link built from the Facilitator QR carries this; the room
// display and the future Participant/Observer join links never do, and never
// need to — they only ever read. Reading it here, rather than hardcoding it
// into facilitator-test.html, keeps the token out of anything that gets
// cached or shared as a plain session link by mistake.
function getFacilitatorToken() {
  const params = new URLSearchParams(window.location.search);
  return params.get("token");
}

// UUIDs are always 36 characters (32 hex digits + 4 hyphens) in this exact
// shape. A session ID that doesn't match this is almost always a link that
// got cut off while being copied or typed, not a real server-side problem —
// catching it here turns a cryptic "HTTP 400" into a message that actually
// tells you what's wrong.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertValidSessionId(sessionId) {
  if (!sessionId || !UUID_RE.test(sessionId)) {
    throw new Error(
      `Session ID "${sessionId}" looks incomplete or malformed — the link may ` +
        `have been cut off when it was copied or typed. Use the full link, ` +
        `exactly as given, including everything after "session=".`
    );
  }
}

async function fetchSession(sessionId) {
  assertValidSessionId(sessionId);
  const res = await fetch(
    // Same URL is requested over and over as the exercise progresses (every
    // page load, every realtime-triggered refresh), which is exactly the
    // shape of request a browser's HTTP cache likes to reuse instead of
    // re-fetching — observed directly as "No inject at index 2" on a
    // session that actually had 17 injects, because the page was reading
    // a response cached from before injects were added. `cache: "no-store"`
    // forces a real network request every time. (Deliberately NOT adding a
    // cache-busting query param here — PostgREST treats any unrecognized
    // query parameter as a column filter, e.g. "?_=123" errors with
    // "column _ does not exist", so cache: "no-store" has to do the job
    // alone.)
    `${SUPABASE_URL}/rest/v1/exercise_sessions?id=eq.${sessionId}&select=*`,
    {
      cache: "no-store",
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

// Retries a failed write a few times (with increasing delay) before giving
// up, so a single dropped packet during a WiFi blip doesn't silently lose a
// facilitator action — or, once observer/participant writes exist, someone's
// typed note or submission. Still throws after exhausting attempts, so a
// caller's existing error handling (e.g. facilitator-test.html's error box)
// keeps working — this only absorbs *transient* failures, not real ones.
async function withRetry(fn, { attempts = 3, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** i));
      }
    }
  }
  throw lastErr;
}

async function patchSession(sessionId, fields) {
  assertValidSessionId(sessionId);
  // Writes now require the session's facilitator token (see
  // getFacilitatorToken above) — the database rejects any update that
  // doesn't present it, per the RLS policy added for roadmap item 1
  // ("Row Level Security on exercise_sessions"). Fail with a clear message
  // rather than letting the request go out and come back as an opaque
  // "HTTP 403" — a missing token is almost always a plain room-display link
  // being used where the Facilitator link (with &token=...) was needed.
  const facilitatorToken = getFacilitatorToken();
  if (!facilitatorToken) {
    throw new Error(
      "No facilitator token in this link. Use the Facilitator link (with " +
        "&token=... after the session ID), not the room-display link."
    );
  }
  await withRetry(async () => {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/exercise_sessions?id=eq.${sessionId}`,
      {
        method: "PATCH",
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          "Content-Type": "application/json",
          // return=minimal would make a wrong/stale token fail *silently*:
          // PostgREST still answers 204 even when the RLS policy filters the
          // row out of the update entirely (zero rows actually touched), so
          // return=representation is needed to tell "updated" apart from
          // "token didn't match, nothing happened" — the response body is
          // the updated row(s), empty when the token was rejected.
          Prefer: "return=representation",
          "x-facilitator-token": facilitatorToken,
        },
        body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
      }
    );
    if (!res.ok) throw new Error(`Update session failed: HTTP ${res.status}`);
    const rows = await res.json();
    if (rows.length === 0) {
      throw new Error(
        "Update rejected: the facilitator token in this link doesn't match " +
          "this session. Use the exact Facilitator link that was issued for it."
      );
    }
  });
}

// Registers one person's attendance (roadmap item 2 — identity/join flow).
// Unlike patchSession, this needs no facilitator token: joining is the one
// write the public Participant/Observer QR is meant to allow. The database
// enforces the real rules (room must fit the session's room_count, session
// must not have ended) via a trigger — this just reports whichever rejection
// came back in plain language instead of a raw HTTP/Postgres error.
//
// The attendee id is generated here in the browser and sent with the insert,
// rather than read back afterwards — the attendee list is readable only by
// the facilitator, so a participant's browser can't look its own row up.
// That id is what ties an individual answer to this person (see
// saveSubmission). Random UUIDs aren't guessable, and nothing public lists
// them.
async function joinSession(sessionId, { id, firstName, familyName, title, department, role, room }) {
  assertValidSessionId(sessionId);
  // withRetry wraps only the network call, not the outcome check below —
  // a dropped packet is worth retrying, but a rejected join (wrong room,
  // session already ended) will fail the exact same way every time, so
  // retrying it 3 times with backoff would just be a 3.5-second wait to
  // show the same error.
  const res = await withRetry(() =>
    fetch(`${SUPABASE_URL}/rest/v1/attendees`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        id,
        session_id: sessionId,
        // name is recomposed server-side from the two parts; sent only
        // because the column is NOT NULL.
        name: `${firstName} ${familyName}`,
        first_name: firstName,
        family_name: familyName,
        job_title: title,
        department,
        role,
        room: room ?? null,
      }),
    })
  );
  if (!res.ok) {
    // PostgREST passes the trigger's RAISE EXCEPTION message straight
    // through as the response body's "message" field — surface that rather
    // than just the HTTP status, since it's already written in plain
    // language ("room must be between 1 and 3 for this session.", "This
    // exercise has already ended — joining is no longer possible.").
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.message) detail = body.message;
    } catch {
      /* response wasn't JSON — keep the plain HTTP status above */
    }
    throw new Error(`Couldn't join: ${detail}`);
  }
}

// Saves a department's answer to one inject (roadmap: participant task
// submission). One row per (session, inject, department) — anyone who
// joined as that department can write it, same self-declared trust model
// the join flow already uses (no login exists to check against, so this
// isn't a new weaker boundary). Deliberately NOT an upsert: PostgREST/
// Postgres's ON CONFLICT DO UPDATE requires full-row SELECT privilege to
// even attempt it, which would mean granting anon read access to every
// department's actual answer text across every session — a much worse
// exposure than the metadata-only reads already accepted elsewhere. Insert
// first; a unique-constraint conflict (this department already has a row
// for this inject) falls back to a plain UPDATE, which only needs SELECT
// on the filter columns (session_id/inject_index/department — granted),
// never on answer_text/attachments/status.
//
// Group vs individual (Ahmed, 4 October 2026): each inject in the scenario
// says whether it needs one answer per department ("group" — attendeeId
// omitted, as before) or one answer per person ("individual" — attendeeId
// set). An individual row is keyed by the attendee instead of the
// department, and the database takes the department from that attendee's
// registration rather than trusting the browser. submitted_at/on_time are
// stamped by the database at the moment of Submit — never sent from here.
async function saveSubmission(sessionId, { injectIndex, department, attendeeId, answerText, attachments, status }) {
  assertValidSessionId(sessionId);
  const commonHeaders = {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=minimal",
  };

  const row = {
    session_id: sessionId,
    inject_index: injectIndex,
    department,
    answer_text: answerText,
    attachments,
    status,
  };
  if (attendeeId) row.attendee_id = attendeeId;

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/exercise_submissions`, {
    method: "POST",
    headers: commonHeaders,
    body: JSON.stringify(row),
  });
  if (insertRes.ok) return;
  if (insertRes.status !== 409) {
    throw new Error(`Couldn't save your answer: ${await readErrorDetail(insertRes)}`);
  }

  // 409 = this answer already has a row (this department's group answer, or
  // this person's individual answer) — expected on every save after the
  // first one for the same inject. The group filter must say attendee_id is
  // null, or it would also overwrite that department's individual answers.
  const filter =
    `session_id=eq.${encodeURIComponent(sessionId)}` +
    `&inject_index=eq.${encodeURIComponent(injectIndex)}` +
    (attendeeId
      ? `&attendee_id=eq.${encodeURIComponent(attendeeId)}`
      : `&department=eq.${encodeURIComponent(department)}&attendee_id=is.null`);
  const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/exercise_submissions?${filter}`, {
    method: "PATCH",
    headers: commonHeaders,
    body: JSON.stringify({ answer_text: answerText, attachments, status }),
  });
  if (!updateRes.ok) {
    throw new Error(`Couldn't save your answer: ${await readErrorDetail(updateRes)}`);
  }
}

// Plain-language reason from a failed PostgREST response — the database's
// own message when there is one (e.g. "This exercise has already ended"),
// otherwise just the HTTP status.
async function readErrorDetail(res) {
  try {
    const body = await res.json();
    if (body && body.message) return body.message;
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}`;
}

// Facilitator dashboard: who has submitted what, and whether it was on time.
// Metadata only — the database function behind this never returns answer
// text or attachments, and refuses anyone without this session's
// facilitator token.
async function fetchSubmissionStatus(sessionId, facilitatorToken) {
  assertValidSessionId(sessionId);
  if (!facilitatorToken) {
    throw new Error(
      "No facilitator token in this link. Use the Facilitator link (with " +
        "&token=... after the session ID), not the room-display link."
    );
  }
  const res = await withRetry(() =>
    fetch(`${SUPABASE_URL}/rest/v1/rpc/facilitator_submission_status`, {
      method: "POST",
      cache: "no-store",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
        "x-facilitator-token": facilitatorToken,
      },
      body: JSON.stringify({ p_session_id: sessionId }),
    })
  );
  if (!res.ok) throw new Error(`Fetch submission status failed: ${await readErrorDetail(res)}`);
  return res.json();
}

// The inject's output type and responsible departments, with the defaults
// for a scenario written before these fields existed: a group task that
// every department is responsible for.
function injectOutput(inject) {
  return inject && inject.output === "individual" ? "individual" : "group";
}
// Accepts both spellings: "responsible" (a list, used by the player's own
// demo scenario) and "team" (exactly one department or "All" — what the
// planproof-scenario skill's Stage 3 JSON produces).
function injectResponsible(inject) {
  const r = inject && (inject.responsible != null ? inject.responsible : inject.team);
  if (!r || (Array.isArray(r) && r.length === 0)) return ["All"];
  return Array.isArray(r) ? r : [r];
}
// The scenario's department list, under either name: "departments" (the
// player's demo) or "requiredDepartments" (the planproof-scenario skill's
// Stage 3 JSON). Facilitator-added extra departments are merged in by the
// caller.
function scenarioDepartments(session) {
  const sc = (session && session.scenario) || {};
  return sc.departments || sc.requiredDepartments || [];
}

function isDepartmentResponsible(inject, department) {
  const list = injectResponsible(inject).map((d) => String(d).trim().toLowerCase());
  return list.includes("all") || list.includes(String(department || "").trim().toLowerCase());
}

// The moment the current inject's time runs out, as a millisecond timestamp
// — from the server's own start time, so every device (and a device that
// reloads mid-inject) agrees with the database's on-time check. null = no
// deadline (no duration set). Falls back to "now" only for a session row
// from before start times were recorded.
function injectDeadlineMs(row, inject) {
  const minutes = ((inject && inject.durationMinutes) || 0) + ((row && row.inject_extra_minutes) || 0);
  if (!inject || !inject.durationMinutes) return null;
  const start = row && row.inject_started_at ? Date.parse(row.inject_started_at) : Date.now();
  return start + minutes * 60 * 1000;
}

// Uploads one attachment to Supabase Storage ahead of saveSubmission — the
// returned {path, filename, size, contentType} is meant to go straight into
// that submission's `attachments` array. The bucket itself enforces the
// real limits (10MB/file, a fixed set of document/image types) server-side
// regardless of what the browser claims, so a tampered client can't bypass
// them.
async function uploadAttachment(sessionId, injectIndex, department, file) {
  assertValidSessionId(sessionId);
  const safeDept = department.replace(/[^a-zA-Z0-9_-]/g, "_") || "unknown";
  const path = `${sessionId}/${injectIndex}/${safeDept}/${Date.now()}-${file.name}`;
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/submission-attachments/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`,
    {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": file.type || "application/octet-stream",
      },
      body: file,
    }
  );
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body && body.message) detail = body.message;
    } catch {
      /* not JSON — keep the plain status */
    }
    throw new Error(`Couldn't upload "${file.name}": ${detail}`);
  }
  return { path, filename: file.name, size: file.size, contentType: file.type };
}

// Reads the attendee roster for the Facilitator dashboard (roadmap: letting
// the facilitator reconcile registrations against the real headcount and
// fix a mis-registered department). Gated by the same facilitator-token RLS
// pattern as patchSession — a plain room-display/participant link can't
// read this, and the database checks the token via a function that reads
// the real facilitator_token column with its own elevated privilege, so
// anon never needs (and never gets) SELECT on that column directly.
async function fetchAttendees(sessionId, facilitatorToken) {
  assertValidSessionId(sessionId);
  if (!facilitatorToken) {
    throw new Error(
      "No facilitator token in this link. Use the Facilitator link (with " +
        "&token=... after the session ID), not the room-display link."
    );
  }
  const res = await withRetry(() =>
    fetch(
      `${SUPABASE_URL}/rest/v1/attendees?session_id=eq.${sessionId}` +
        `&select=id,name,first_name,family_name,job_title,department,role,room,joined_at&order=joined_at.asc`,
      {
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          "x-facilitator-token": facilitatorToken,
        },
      }
    )
  );
  if (!res.ok) throw new Error(`Fetch attendees failed: HTTP ${res.status}`);
  return res.json();
}

// Removes one mis-registered attendee (e.g. joined under the wrong
// department) so they can rejoin correctly. This is deliberately "delete
// and ask them to rejoin" rather than editing their department in place —
// simpler to build, and the roster is only ever corrected before the
// exercise starts (per Ahmed), so there's no mid-exercise disruption to
// worry about. Same facilitator-token gating as everything else here.
async function deleteAttendee(attendeeId, facilitatorToken) {
  if (!facilitatorToken) {
    throw new Error(
      "No facilitator token in this link. Use the Facilitator link (with " +
        "&token=... after the session ID), not the room-display link."
    );
  }
  const res = await withRetry(() =>
    fetch(`${SUPABASE_URL}/rest/v1/attendees?id=eq.${attendeeId}`, {
      method: "DELETE",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        Prefer: "return=representation",
        "x-facilitator-token": facilitatorToken,
      },
    })
  );
  if (!res.ok) throw new Error(`Remove attendee failed: HTTP ${res.status}`);
  const rows = await res.json();
  if (rows.length === 0) {
    throw new Error(
      "Remove rejected: the facilitator token in this link doesn't match this session."
    );
  }
}

// Fires `callback` whenever this device looks like it just came back —
// either the browser's own "online" event, or the tab becoming visible
// again (mobile browsers suspend/throttle background tabs, which can drop
// the realtime socket without ever firing an "offline" event). A page
// should treat this as "don't trust whatever you were showing — go fetch
// the real current state," because a realtime subscription can silently
// miss updates that happened while it was disconnected; the push stream is
// a notification to refresh, not a guaranteed log of everything that
// happened.
function onReconnect(callback) {
  window.addEventListener("online", callback);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) callback();
  });
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
  "crowd-panic": "sfx/crowd-panic.mp3",
  // Happy park-ambience crowd noise — not an incident sound. Meant as a
  // "calm before the incident" opening ambience for a Miral-venue scenario
  // (Ferrari World, Yas Waterworld, etc.), playing under an early inject
  // before anything goes wrong.
  "crowd-cheer": "sfx/crowd-cheer.mp3",
  // Built by overlaying two separate clips: a continuous alarm siren with a
  // "Warning, evacuate" voice announcement cutting in partway through (the
  // siren ducks briefly so the voice is clearly audible, then continues
  // alone) — for a building fire-alarm/evacuation-trigger inject, distinct
  // from the "fire" ambience (crackling flames) already in the library.
  "fire-alarm-evacuate": "sfx/fire-alarm-evacuate.mp3",
  // A short bell-style fire/burglar alarm with its own natural ending —
  // a different alarm character from the siren-based "fire-alarm-evacuate"
  // above, for variety across scenarios.
  "fire-alarm-bell": "sfx/fire-alarm-bell.mp3",
  // Strong desert wind — a UAE/GCC-specific hazard (sandstorm) distinct
  // from the general "storm" ambience (rain/wind), which doesn't read as
  // regionally specific.
  sandstorm: "sfx/sandstorm.mp3",
  // A backup generator starting up — for a power-outage scenario.
  generator: "sfx/generator.mp3",
  // Realistic automatic-gunfire burst, for an armed-threat/lockdown inject.
  // IMPORTANT: unlike every other sound here, this one should never be
  // triggered on a live room-display without first telling the room it's
  // coming — a sudden realistic gunshot can be mistaken for a real threat
  // and can alarm people outside the exercise room too. When designing a
  // scenario that uses it, call this out explicitly to the facilitator.
  gunfire: "sfx/gunfire.mp3",
};

// Some injects are really two clips playing at once rather than one file —
// e.g. a stampede reads as one immersive moment of footsteps *and* people
// shouting for help together, not two sounds back to back. Referencing
// "stampede" plays every clip listed here simultaneously.
const SFX_OVERLAY = {
  stampede: ["stampede", "crowd-panic"],
};

// Ambience tracks (long, meant to loop under an inject) vs. one-shot signature
// sounds (sirens, the earthquake rumble, explosion, a single thunder crack)
// that should just play through once per inject and not restart on a loop.
const SFX_LOOP = new Set(["fire", "storm", "flood", "news-bed", "thunderstorm", "roller-coaster", "crowd-cheer", "sandstorm"]);
// How long an ambience track plays before fading out, in seconds — long
// enough to register, short enough not to drone under the whole inject.
const AMBIENCE_PLAY_SECONDS = 18;

const sfxAudioCache = {};
let currentSfxAudios = [];

// Lets a page (room-display.html) show what's happening with sound
// on-screen, without needing the browser's dev tools open — useful for
// diagnosing playback issues on a real exercise room's laptop, not just in
// development. No-op until a page calls setSfxStatusHandler.
let onSfxStatus = () => {};
function setSfxStatusHandler(fn) {
  onSfxStatus = fn;
}

function playSfx(name) {
  if (!name || name === "none") return;

  // Stop whatever's currently playing so sounds don't stack on a fast
  // facilitator advance.
  currentSfxAudios.forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });
  currentSfxAudios = [];

  const layerNames = SFX_OVERLAY[name] || [name];
  layerNames.forEach((layerName) => playSfxLayer(layerName));
}

function playSfxLayer(name) {
  const path = SFX_FILES[name];
  if (!path) {
    console.warn(`No sound file mapped for sfx "${name}"`);
    onSfxStatus(`⚠ no file mapped for "${name}"`);
    return;
  }

  if (!sfxAudioCache[name]) {
    sfxAudioCache[name] = new Audio(path);
  }
  const audio = sfxAudioCache[name];
  audio.loop = false;
  audio.volume = 0.8;
  audio.currentTime = 0;
  currentSfxAudios.push(audio);

  onSfxStatus(`▶ attempting: ${name}`);
  audio
    .play()
    .then(() => onSfxStatus(`✓ playing: ${name}`))
    .catch((err) => {
      // Most common cause: no user gesture has unlocked audio yet (the
      // "Tap to begin" screen handles this on room-display.html).
      console.warn(`Playback blocked for "${name}":`, err.message);
      onSfxStatus(`✗ blocked: ${name} — ${err.message}`);
    });

  if (SFX_LOOP.has(name)) {
    audio.loop = true;
    setTimeout(() => {
      if (currentSfxAudios.includes(audio)) {
        audio.pause();
        audio.currentTime = 0;
      }
    }, AMBIENCE_PLAY_SECONDS * 1000);
  }
}
