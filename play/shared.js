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
    throw new Error(T("shared.error.sessionIdMalformed", { id: String(sessionId) }));
  }
}

// Headers for a call to one of the database's checked functions. The
// facilitator token is added only when this page's link carries a
// well-formed one.
function rpcHeaders(facilitatorToken) {
  const headers = {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (facilitatorToken && UUID_RE.test(facilitatorToken)) headers["x-facilitator-token"] = facilitatorToken;
  return headers;
}

// The session, by its exact id (item 6, 11 October 2026). The public key can
// no longer read the exercise_sessions table — listing sessions is closed —
// so every page asks the database function player_session for this one
// session. Without the facilitator token the answer is cut down to what a
// player's screen needs: only injects already played, and only their display
// fields. With the token (the Facilitator page, the backup pack) it is the
// full scenario.
// `cache: "no-store"` stays: a stale cached copy was once mistaken for a real
// bug ("No inject at index 2" on a session that had 17).
async function fetchSession(sessionId) {
  assertValidSessionId(sessionId);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/player_session`, {
    method: "POST",
    cache: "no-store",
    headers: rpcHeaders(getFacilitatorToken()),
    body: JSON.stringify({ p_session_id: sessionId }),
  });
  if (!res.ok) throw new Error(T("shared.error.fetchSessionFailed", { status: res.status }));
  const text = await res.text();
  const row = text ? JSON.parse(text) : null;
  // The exercise's own language (lang.js). English: nothing happens.
  if (row) await PPLang.useSessionLanguage(row.language);
  return row || null;
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
    throw new Error(T("shared.error.noFacilitatorToken"));
  }
  // Only readable columns are asked for in the reply (17 October 2026): the
  // public key has column-level SELECT on this table, so a bare
  // return=representation ("*") fails with "permission denied" the moment
  // the row has a column it may not read (counts_for_stats, since the
  // survey) — which refused every Facilitator action on the live system.
  await withRetry(() =>
    fetch(`${SUPABASE_URL}/rest/v1/exercise_sessions?id=eq.${sessionId}&select=id,status,current_inject_index,updated_at`, {
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
    })
  ).then(async (res) => {
    // withRetry wraps only fetch() itself — a dropped packet or connection
    // reset is worth retrying, but a rejection below (bad token) will fail
    // the exact same way every time, so it's checked outside withRetry and
    // reported once immediately, the same pattern joinSession and
    // fetchSubmissionStatus already use. (Previously this whole check lived
    // inside withRetry, so a rejected action silently retried 3 times with
    // backoff — up to ~1.5s — before finally showing the error; fixed
    // 5 October 2026.)
    if (!res.ok) throw new Error(T("shared.error.updateSessionFailed", { status: res.status }));
    const rows = await res.json();
    if (rows.length === 0) {
      throw new Error(T("shared.error.updateRejected"));
    }
    ringDoorbell(writerDoorbell, "session");
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
// remote (item 9, 16 October 2026): the participant is joining alone, with no
// shared room screen — their own device plays the sounds. Participants only;
// a remote registration never carries a room (the database enforces both).
async function joinSession(sessionId, { id, firstName, familyName, title, department, role, room, remote }) {
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
        room: remote ? null : room ?? null,
        remote: !!remote,
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
      if (body && body.message) detail = PPLang.dbMessage(body.message);
    } catch {
      /* response wasn't JSON — keep the plain HTTP status above */
    }
    throw new Error(T("shared.error.couldntJoin", { detail }));
  }
}

// Saves an answer to one inject through the database's checked function
// save_submission (item 6, 11 October 2026 — the public key can no longer
// read, insert or update the answers table directly). The writer must be a
// registered participant of this session; the department always comes from
// that registration, never from the browser, and nothing about the writer is
// stored on a group answer.
//
// Group vs individual (Ahmed, 4 October 2026): a "group" inject has one
// answer per department (anyone registered in it can write it); an
// "individual" inject has one answer per person. submitted_at/on_time are
// stamped by the database at the moment of Submit. A draft or an automatic
// save can never turn an already-submitted answer back into an unsubmitted
// one — the database refuses it, in plain words.
async function saveSubmission(sessionId, { injectIndex, writerId, individual, answerText, attachments, status }) {
  assertValidSessionId(sessionId);
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/save_submission`, {
      method: "POST",
      cache: "no-store",
      headers: rpcHeaders(null),
      body: JSON.stringify({
        p_session_id: sessionId,
        p_writer_id: writerId,
        p_inject_index: injectIndex,
        p_individual: !!individual,
        p_answer_text: answerText,
        p_attachments: attachments || [],
        p_status: status,
      }),
    });
  } catch {
    throw new Error(T("shared.error.saveAnswerNoConnection"));
  }
  if (!res.ok) {
    throw new Error(T("shared.error.couldntSaveAnswer", { detail: await readErrorDetail(res) }));
  }
}

// Plain-language reason from a failed PostgREST response — the database's
// own message when there is one (e.g. "This exercise has already ended"),
// otherwise just the HTTP status.
async function readErrorDetail(res) {
  try {
    const body = await res.json();
    if (body && body.message) return PPLang.dbMessage(body.message);
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
    throw new Error(T("shared.error.noFacilitatorToken"));
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
  if (!res.ok) throw new Error(T("shared.error.fetchSubmissionStatusFailed", { detail: await readErrorDetail(res) }));
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
  if (!r || (Array.isArray(r) && r.length === 0)) return ["All"]; // i18n-ok: the scenario's own code for "every department" (compared in isDepartmentResponsible), not wording
  return Array.isArray(r) ? r : [r];
}
// The inject's task line for participants. The planproof-scenario skill's
// Stage 3 JSON gives it as an object ({ type: "PRODUCE|LOCATE|DECIDE",
// text, label }); the player's demo uses a plain string. Accept both.
function injectTaskText(inject) {
  const t = inject && inject.task;
  if (!t) return "";
  if (typeof t === "string") return t;
  const text = t.text || t.label || "";
  return t.type ? `${t.type} — ${text}` : text;
}

// The scenario's department list, under either name: "departments" (the
// player's demo) or "requiredDepartments" (the planproof-scenario skill's
// Stage 3 JSON). Facilitator-added extra departments are merged in by the
// caller.
function scenarioDepartments(session) {
  const sc = (session && session.scenario) || {};
  return sc.departments || sc.requiredDepartments || [];
}

// Is this department expected to answer this inject? Since item 5 (11 October
// 2026) the Facilitator can add a department at any time. Rule (Ahmed,
// 11 October 2026): a department added during the exercise is not
// responsible for the injects it MISSED — any inject that started before it
// was added, including the one running at that moment. Injects that start
// after it was added count it exactly like every other department, whether
// they're addressed to all departments or name it. (Going back to an earlier
// inject with Previous restarts it, so it then counts too.) The database
// records when each such department was added (departments_added_late).
function isDepartmentResponsible(inject, department, row, injectIndex) {
  if (departmentMissedInject(row, department, injectIndex)) return false;
  const list = injectResponsible(inject).map((d) => String(d).trim().toLowerCase());
  const key = String(department || "").trim().toLowerCase();
  return list.includes("all") || list.includes(key);
}

// When this department was added during the exercise (ms), or null.
function departmentAddedLateAt(row, department) {
  const late = (row && row.departments_added_late) || {};
  const key = String(department || "").trim().toLowerCase();
  const found = Object.keys(late).find((d) => d.trim().toLowerCase() === key);
  return found ? Date.parse(late[found]) : null;
}

// True when the department was added during the exercise after this inject
// had already started (it missed the inject). An inject that hasn't started
// can't have been missed.
function departmentMissedInject(row, department, injectIndex) {
  const addedAt = departmentAddedLateAt(row, department);
  if (addedAt === null || injectIndex === null || injectIndex === undefined) return false;
  const log = (row && row.inject_started_log) || {};
  const started = log[String(injectIndex)] ? Date.parse(log[String(injectIndex)]) : null;
  return started !== null && started <= addedAt;
}

// The session's own department list: the scenario's plus any the Facilitator
// added, each once (case-insensitive), in that order. This is the only list
// department dropdowns offer — departments are never typed freely.
function sessionDepartments(row) {
  const seen = new Set();
  return [...scenarioDepartments(row), ...((row && row.extra_departments) || [])].filter((d) => {
    const key = String(d || "").trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
      if (body && body.message) detail = PPLang.dbMessage(body.message);
    } catch {
      /* not JSON — keep the plain status */
    }
    throw new Error(T("shared.error.couldntUpload", { name: String(file.name), detail }));
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
    throw new Error(T("shared.error.noFacilitatorToken"));
  }
  const res = await withRetry(() =>
    fetch(
      `${SUPABASE_URL}/rest/v1/attendees?session_id=eq.${sessionId}` +
        `&select=id,name,first_name,family_name,job_title,department,role,room,remote,joined_at&order=joined_at.asc`,
      {
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          "x-facilitator-token": facilitatorToken,
        },
      }
    )
  );
  if (!res.ok) throw new Error(T("shared.error.fetchAttendeesFailed", { status: res.status }));
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
    throw new Error(T("shared.error.noFacilitatorToken"));
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
  if (!res.ok) throw new Error(T("shared.error.removeAttendeeFailed", { status: res.status }));
  const rows = await res.json();
  if (rows.length === 0) {
    throw new Error(T("shared.error.removeRejected"));
  }
}

// The Facilitator's correction of "in a room / joining remotely" (item 9,
// 16 October 2026), in either direction, through the checked database
// function facilitator_set_remote (token). Marking someone "in a room" in a
// multi-room exercise needs the room they are in. The person's device learns
// the change in the reply to its next check-in (within about 20 seconds).
async function setAttendeeRemote(sessionId, attendeeId, remote, room, facilitatorToken) {
  assertValidSessionId(sessionId);
  if (!facilitatorToken) {
    throw new Error(T("shared.error.noFacilitatorToken"));
  }
  const res = await withRetry(() =>
    fetch(`${SUPABASE_URL}/rest/v1/rpc/facilitator_set_remote`, {
      method: "POST",
      cache: "no-store",
      headers: rpcHeaders(facilitatorToken),
      body: JSON.stringify({ p_session_id: sessionId, p_attendee_id: attendeeId, p_remote: !!remote, p_room: room ?? null }),
    })
  );
  if (!res.ok) throw new Error(await readErrorDetail(res));
  return res.json();
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

// ---- The doorbell (item 6, 11 October 2026) --------------------------------
// Live updates no longer carry any data. The database rings a content-free
// "ring" on this session's own channel whenever the session changes or a
// message is added; each page then fetches the latest through the checked
// functions. A false ring (the channel is open to anyone who knows the
// session id) can only cause a re-fetch. onRing(kind): "session", "message"
// (to participants), "inbox" (to the facilitator — from a department or,
// since item 7, from an Observer) or "observer" (to Observers, item 7).
function subscribeToDoorbell(supabaseClient, sessionId, onRing, onStatus) {
  return supabaseClient
    .channel(`pp-${sessionId}`, { config: { broadcast: { self: false } } })
    .on("broadcast", { event: "ring" }, (msg) => {
      const kind = msg && msg.payload && msg.payload.kind;
      onRing(kind === "message" || kind === "inbox" || kind === "observer" || kind === "writer" ? kind : "session");
    })
    .subscribe((status) => onStatus && onStatus(status));
}

// The Facilitator page also rings after each of its own actions — belt and
// braces with the database's ring, so screens react at once either way.
// It registers its channel here; patchSession and sendBroadcast then ring it.
let writerDoorbell = null;
function setWriterDoorbell(channel) {
  writerDoorbell = channel;
}
function ringDoorbell(channel, kind) {
  try {
    if (channel) channel.send({ type: "broadcast", event: "ring", payload: { kind: kind || "session" } });
  } catch {
    /* the database's own ring and the 15-second check still cover it */
  }
}

// ---- Facilitator broadcast messages (added 5 October 2026) ----------------
// One table (session_messages) carries all exercise messaging. Today only
// the Facilitator -> everyone broadcast exists (department null); roadmap
// item 4 adds department-targeted messages and replies on the same table.
// The database checks the facilitator token on every send and stamps the
// time and the inject showing when it was sent; the browser can't set
// either. Messages are operational only and stay out of the report.
//
// Ready-made messages for the facilitator's dropdown. Choosing one only
// fills the text box — the facilitator can edit it or type anything else.
// preset_key is recorded only when a preset is sent unedited.
const BROADCAST_PRESETS = [
  { key: "five_min", text: T("shared.presetBroadcast.fiveMin") },
  { key: "two_min", text: T("shared.presetBroadcast.twoMin") },
  { key: "submit_now", text: T("shared.presetBroadcast.submitNow") },
  { key: "next_soon", text: T("shared.presetBroadcast.nextSoon") },
  { key: "short_break", text: T("shared.presetBroadcast.shortBreak") },
];
const MESSAGE_MAX_LENGTH = 280;

// ---- Facilitator <-> Department messaging (roadmap item 4, 5 Oct 2026) ----
// Ready-made messages for each direction's dropdown. Choosing one only fills
// the text box — either side can edit it or type anything else, same as the
// broadcast presets above. preset_key is recorded only when a preset is sent
// unedited.
const FACILITATOR_TO_DEPARTMENT_PRESETS = [
  { key: "need_more_time", text: T("shared.presetToDepartment.needMoreTime") },
  { key: "submit_when_ready", text: T("shared.presetToDepartment.submitWhenReady") },
  { key: "finalise_soon", text: T("shared.presetToDepartment.finaliseSoon") },
];
const DEPARTMENT_TO_FACILITATOR_PRESETS = [
  { key: "few_more_minutes", text: T("shared.presetFromDepartment.fewMoreMinutes") },
  { key: "submitting_now", text: T("shared.presetFromDepartment.submittingNow") },
  { key: "technical_issue", text: T("shared.presetFromDepartment.technicalIssue") },
];

// Facilitator -> participants: everyone (department omitted/null) or one
// department. Same endpoint and rejection handling either way — the
// database checks the facilitator token and, since item 4, allows either
// target for direction=to_participants.
async function sendBroadcast(sessionId, { body, presetKey, department } = {}) {
  assertValidSessionId(sessionId);
  const facilitatorToken = getFacilitatorToken();
  if (!facilitatorToken) {
    throw new Error(T("shared.error.noFacilitatorToken"));
  }
  // Same pattern as joinSession: retry only the network call; a rejection
  // (wrong token, exercise ended, empty/too-long text) fails once, at once.
  const res = await withRetry(() =>
    fetch(`${SUPABASE_URL}/rest/v1/session_messages`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
        "x-facilitator-token": facilitatorToken,
      },
      body: JSON.stringify({
        session_id: sessionId,
        direction: "to_participants",
        department: department || null,
        body,
        preset_key: presetKey || null,
      }),
    })
  );
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let rawDetail = detail; // the database's own words, for the two checks below
    try {
      const err = await res.json();
      if (err && err.message) {
        rawDetail = err.message;
        detail = PPLang.dbMessage(err.message);
      }
    } catch {
      /* not JSON — keep the HTTP status */
    }
    if (/row-level security/i.test(rawDetail)) {
      throw new Error(T("shared.error.messageNotSentToken"));
    } else if (/check constraint/i.test(rawDetail)) {
      throw new Error(T("shared.error.messageNotSentLength", { max: MESSAGE_MAX_LENGTH }));
    }
    throw new Error(T("shared.error.messageNotSent", { detail }));
  }
  ringDoorbell(writerDoorbell, "message");
}

// Department -> facilitator. No facilitator token exists for a participant,
// so — like a group answer — anyone who joined under this department can
// send on its behalf; no individual is recorded, not even hidden. The
// database refuses this direction without a department (see migration
// item4_on_time_rule_department_messaging).
async function sendDepartmentRequest(sessionId, { body, presetKey, department }) {
  assertValidSessionId(sessionId);
  if (!department) {
    throw new Error(T("shared.error.noDepartment"));
  }
  const res = await withRetry(() =>
    fetch(`${SUPABASE_URL}/rest/v1/session_messages`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        session_id: sessionId,
        direction: "to_facilitator",
        department,
        body,
        preset_key: presetKey || null,
      }),
    })
  );
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    let rawDetail = detail; // the database's own words, for the check below
    try {
      const err = await res.json();
      if (err && err.message) {
        rawDetail = err.message;
        detail = PPLang.dbMessage(err.message);
      }
    } catch {
      /* not JSON — keep the HTTP status */
    }
    if (/check constraint/i.test(rawDetail)) {
      throw new Error(T("shared.error.messageNotSentLength", { max: MESSAGE_MAX_LENGTH }));
    }
    throw new Error(T("shared.error.messageNotSent", { detail }));
  }
}

// Messages addressed to participants, oldest first, through the checked
// function player_messages (item 6 — the public key can no longer read the
// messages table): messages for everyone, plus those for `department` when
// one is given (a participant's own department).
async function fetchMessages(sessionId, department) {
  assertValidSessionId(sessionId);
  const res = await withRetry(() =>
    fetch(`${SUPABASE_URL}/rest/v1/rpc/player_messages`, {
      method: "POST",
      cache: "no-store",
      headers: rpcHeaders(null),
      body: JSON.stringify({ p_session_id: sessionId, p_department: department || null }),
    })
  );
  if (!res.ok) throw new Error(T("shared.error.fetchMessagesFailed", { detail: await readErrorDetail(res) }));
  return res.json();
}

// Every message of the session, every direction — facilitator token only
// (item 6: department requests are no longer readable without it). Since
// item 7 this is the function facilitator_message_log, which also gives each
// message's room and run (Observer messages are room-level).
async function fetchAllMessages(sessionId) {
  assertValidSessionId(sessionId);
  const res = await withRetry(() =>
    fetch(`${SUPABASE_URL}/rest/v1/rpc/facilitator_message_log`, {
      method: "POST",
      cache: "no-store",
      headers: rpcHeaders(getFacilitatorToken()),
      body: JSON.stringify({ p_session_id: sessionId }),
    })
  );
  if (!res.ok) throw new Error(T("shared.error.fetchMessagesFailed", { detail: await readErrorDetail(res) }));
  return res.json();
}

// Messages addressed to the facilitator — from departments and (item 7) from
// Observers — oldest first.
async function fetchFacilitatorMessages(sessionId) {
  return (await fetchAllMessages(sessionId)).filter(
    (m) => m.direction === "to_facilitator" || m.direction === "from_observer"
  );
}

// What the facilitator has sent to Observers (item 7), oldest first.
async function fetchSentObserverMessages(sessionId) {
  return (await fetchAllMessages(sessionId)).filter((m) => m.direction === "to_observers");
}

// What the facilitator has sent (to everyone and to departments), oldest first.
async function fetchSentMessages(sessionId) {
  return (await fetchAllMessages(sessionId)).filter((m) => m.direction === "to_participants");
}

// ---- Observer <-> Facilitator messaging (roadmap item 7, 11 October 2026) --
// Full design: design-notes.md → "Observer ↔ Facilitator — design". Two rules
// (Ahmed, 11 October 2026):
//   1. Room-level, never a person: an Observer's message is recorded as
//      "the Observer(s) in Room 2". The writer's attendee id is sent only so
//      the database can check the Observer registration; it is not stored on
//      the message.
//   2. This channel stays open after End until the Observers' notes window
//      closes (one hour after End, or "Notes complete"). Every other message
//      channel still stops at End.
// The public key cannot read or write these messages in the table: every
// call goes through a checked database function. Operational traffic only —
// it stays out of the report; anything evaluative belongs in a note.
const OBSERVER_TO_FACILITATOR_PRESETS = [
  { key: "obs_need_more_time", text: T("shared.presetFromObserver.needMoreTime") },
  { key: "obs_ready", text: T("shared.presetFromObserver.ready") },
  { key: "obs_technical_issue", text: T("shared.presetFromObserver.technicalIssue") },
  { key: "obs_question", text: T("shared.presetFromObserver.question") },
];
const FACILITATOR_TO_OBSERVER_PRESETS = [
  { key: "obs_advancing_1min", text: T("shared.presetToObserver.advancingOneMin") },
  { key: "obs_noted_hold", text: T("shared.presetToObserver.notedHold") },
  { key: "obs_please_proceed", text: T("shared.presetToObserver.pleaseProceed") },
];

// Mirrors the database's own rule (private.observer_channel_closed_reason),
// so a screen can say when the channel closes. The database still decides.
function observerChannel(row, nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs;
  if (!row) return { open: false, reason: T("shared.status.loading"), closesAt: null };
  if (row.status !== "ended") return { open: true, reason: null, closesAt: null };
  if (row.notes_closed_at) {
    return { open: false, reason: T("shared.observerChannel.closedNotesComplete"), closesAt: null };
  }
  const ended = row.ended_at ? Date.parse(row.ended_at) : -Infinity;
  const closesAt = ended + OBSERVER_NOTES_WINDOW_MS;
  if (now > closesAt) {
    return {
      open: false,
      reason: T("shared.observerChannel.closedAfterHour"),
      closesAt,
    };
  }
  return { open: true, reason: null, closesAt };
}

// "Room 2 Observer" — or just "Observer" in a one-room exercise. Never a name.
function observerRoomLabel(room) {
  return room ? T("shared.observer.roomLabel", { room }) : T("shared.observer.label");
}
// Who a facilitator's message to Observers was for.
function observerTargetLabel(room) {
  return room ? T("shared.observer.roomTarget", { room }) : T("shared.observer.allTarget");
}

// Observer -> facilitator. message.id is created on the phone when the
// message is started, so sending it twice (Send pressed twice, or a retry
// after a dropped connection) saves it once.
function sendObserverMessage(sessionId, { id, body, presetKey, attendeeId }) {
  assertValidSessionId(sessionId);
  return callNotesRpc("send_observer_message", {
    p_id: id,
    p_session_id: sessionId,
    p_attendee_id: attendeeId,
    p_body: body,
    p_preset_key: presetKey || null,
  });
}

// Facilitator -> Observers: all of them (room null) or one room's.
async function sendToObservers(sessionId, { id, body, presetKey, room }) {
  assertValidSessionId(sessionId);
  const facilitatorToken = getFacilitatorToken();
  if (!facilitatorToken) {
    throw new Error(T("shared.error.noFacilitatorToken"));
  }
  const result = await callNotesRpc(
    "facilitator_message_observers",
    { p_id: id, p_session_id: sessionId, p_room: room || null, p_body: body, p_preset_key: presetKey || null },
    facilitatorToken
  );
  ringDoorbell(writerDoorbell, "observer");
  return result;
}

// What this Observer may read: this run's messages to all Observers or to
// their room, and what their own room's Observers sent. Oldest first.
async function fetchObserverMessages(sessionId, attendeeId) {
  assertValidSessionId(sessionId);
  return (await callNotesRpc("observer_messages", { p_session_id: sessionId, p_attendee_id: attendeeId })) || [];
}

function formatMessageTime(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString(PPLang.locales(), { hour: "2-digit", minute: "2-digit" });
}

// A short two-note chime for a new broadcast on the room display. Made with
// the Web Audio API rather than a sound file, and kept separate from
// playSfx so it never stops an inject's own sound effect. Needs
// unlockChime() to have run inside a user gesture ("Tap to begin").
let chimeCtx = null;
function unlockChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    chimeCtx = chimeCtx || new Ctx();
    if (chimeCtx.state === "suspended") chimeCtx.resume();
  } catch {
    chimeCtx = null;
  }
}
function playChime() {
  if (!chimeCtx) return false;
  try {
    const now = chimeCtx.currentTime;
    [
      [880, 0],
      [1318.5, 0.18],
    ].forEach(([freq, offset]) => {
      const osc = chimeCtx.createOscillator();
      const gain = chimeCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.3, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.6);
      osc.connect(gain).connect(chimeCtx.destination);
      osc.start(now + offset);
      osc.stop(now + offset + 0.65);
    });
    return true;
  } catch {
    return false;
  }
}

// ---- Observer notes (roadmap item 5, built 11 October 2026) ---------------
// Full design: design-notes.md → "Observer notes". The public key has no
// access to the observer_notes table at all — every write and read goes
// through a database function that checks who is asking (a registered
// Observer's attendee id, or the facilitator token), the time window, the
// inject and the department list. These helpers just call those functions.

// Topic is optional since 17 October 2026: a note not classified by the
// Observer is "General" (the report classifies it afterwards).
const NOTE_TOPICS = [
  { key: "general", label: T("shared.noteTopic.general") },
  { key: "decision", label: T("shared.noteTopic.decision") },
  { key: "communication", label: T("shared.noteTopic.communication") },
  { key: "plan", label: T("shared.noteTopic.plan") },
  { key: "roles", label: T("shared.noteTopic.roles") },
  { key: "coordination", label: T("shared.noteTopic.coordination") },
  { key: "other", label: T("shared.noteTopic.other") },
];
// Three levels, not five (Ahmed, 11 October 2026).
const NOTE_TYPES = [
  { key: "positive", label: T("shared.noteType.positive") },
  { key: "improvement", label: T("shared.noteType.improvement") },
  { key: "critical", label: T("shared.noteType.critical") },
];
const NOTE_MAX_LENGTH = 500;
const NOTE_TOPIC_OTHER_MAX = 60;
const NOTE_EXTERNAL_MAX = 80;
// Observers: one hour after End (Ahmed). Facilitator: 48 hours after End,
// or until "Notes complete", whichever comes first.
const OBSERVER_NOTES_WINDOW_MS = 60 * 60 * 1000;
const FACILITATOR_NOTES_WINDOW_MS = 48 * 60 * 60 * 1000;

function noteTopicLabel(note) {
  if (note.topic === "other") return note.topic_other ? T("shared.noteTopic.otherWith", { text: note.topic_other }) : T("shared.noteTopic.other");
  const t = NOTE_TOPICS.find((x) => x.key === note.topic);
  return t ? t.label : note.topic;
}
function noteTypeLabel(key) {
  const t = NOTE_TYPES.find((x) => x.key === key);
  return t ? t.label : key;
}
function noteAboutLabel(note) {
  if (note.department_scope === "external") return T("shared.noteAbout.external", { name: String(note.external_party) });
  return (note.departments || []).join(", ");
}

// Mirrors the database's own rule (private.notes_closed_reason) so a screen
// can say when notes open and close. The database still decides: a note
// sent a moment too late is refused there with the same reason.
function notesWindow(row, role, nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs;
  if (!row) return { open: false, reason: T("shared.status.loading"), closesAt: null };
  if (row.notes_closed_at) return { open: false, reason: T("shared.notesWindow.closed"), closesAt: null };
  if (row.status === "lobby") return { open: false, reason: T("shared.notesWindow.opensAtStart"), closesAt: null };
  if (row.status !== "ended") return { open: true, reason: null, closesAt: null };
  const ended = row.ended_at ? Date.parse(row.ended_at) : -Infinity;
  const span = role === "facilitator" ? FACILITATOR_NOTES_WINDOW_MS : OBSERVER_NOTES_WINDOW_MS;
  const closesAt = ended + span;
  if (now > closesAt) {
    return {
      open: false,
      reason: role === "facilitator"
        ? T("shared.notesWindow.closedFacilitator")
        : T("shared.notesWindow.closedObserver"),
      closesAt,
    };
  }
  return { open: true, reason: null, closesAt };
}

// The injects actually played in this run (keys of inject_started_log), in
// order — the only injects a note can be about.
function playedInjects(row) {
  const injects = (row && row.scenario && row.scenario.injects) || [];
  return Object.keys((row && row.inject_started_log) || {})
    .map(Number)
    .filter((i) => Number.isInteger(i) && injects[i])
    .sort((a, b) => a - b);
}

// One RPC call: the network part is retried (a dropped packet), a refusal
// from the database is reported once, at once, in its own words.
async function callNotesRpc(name, body, facilitatorToken) {
  const headers = {
    apikey: SUPABASE_PUBLISHABLE_KEY,
    Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
    "Content-Type": "application/json",
  };
  if (facilitatorToken) headers["x-facilitator-token"] = facilitatorToken;
  let res;
  try {
    res = await withRetry(() =>
      fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: "POST",
        cache: "no-store",
        headers,
        body: JSON.stringify(body),
      })
    );
  } catch {
    const err = new Error(T("shared.error.serverUnreachable"));
    err.network = true;
    throw err;
  }
  if (!res.ok) throw new Error(await readErrorDetail(res));
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Log a new note or save changes to one's own. note.id is created on the
// device when the note is started, so sending it twice (Log pressed twice,
// or a retry after a dropped connection) saves it once.
// attendeeId null + facilitatorToken = a Facilitator note.
function saveObserverNote(sessionId, note, { attendeeId, facilitatorToken } = {}) {
  assertValidSessionId(sessionId);
  return callNotesRpc(
    "save_observer_note",
    {
      p_id: note.id,
      p_session_id: sessionId,
      p_attendee_id: attendeeId || null,
      p_inject_index: note.injectIndex === null || note.injectIndex === undefined ? null : note.injectIndex,
      p_topic: note.topic,
      p_topic_other: note.topic === "other" ? note.topicOther || null : null,
      p_note_type: note.noteType,
      p_department_scope: note.scope,
      p_departments: note.scope === "external" ? [] : note.departments || [],
      p_external_party: note.scope === "external" ? note.externalParty || null : null,
      p_body: note.body,
    },
    attendeeId ? null : facilitatorToken
  );
}

function withdrawObserverNote(sessionId, noteId, { attendeeId, facilitatorToken } = {}) {
  assertValidSessionId(sessionId);
  return callNotesRpc(
    "withdraw_observer_note",
    { p_id: noteId, p_session_id: sessionId, p_attendee_id: attendeeId || null },
    attendeeId ? null : facilitatorToken
  );
}

// Every note in the session, for the Facilitator's panel (token only).
async function fetchObserverNotes(sessionId, facilitatorToken) {
  assertValidSessionId(sessionId);
  return (await callNotesRpc("facilitator_observer_notes", { p_session_id: sessionId }, facilitatorToken)) || [];
}

// "Notes complete": closes notes for everyone, for good (after End only).
function closeObserverNotes(sessionId, facilitatorToken) {
  assertValidSessionId(sessionId);
  return callNotesRpc("facilitator_close_notes", { p_session_id: sessionId }, facilitatorToken);
}

// --- Real sound effects (licensed clips Ahmed sourced from Zapsplat /
// Smartsound), replacing the earlier synthesized placeholders. Every inject
// references its effect by this same short name ("sfx"), so adding a new
// sound later is just: drop the file in play/sfx/ and add one line here.
// A short silent clip used only to unlock sound inside a tap (17 October
// 2026). It used to be a real siren at volume 0 — but an iPhone ignores the
// volume setting, so the siren was heard for a moment on every "turn sound
// on" tap and after a reload, even with no inject sound due.
const SFX_SILENT = "sfx/silence.wav";

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

// Stops whatever inject sound is playing (the end of the exercise: a looping
// siren must not carry on over the thank-you screen).
function stopSfx() {
  currentSfxAudios.forEach((audio) => {
    try { audio.pause(); audio.currentTime = 0; } catch { /* nothing to stop */ }
  });
  currentSfxAudios = [];
}

function playSfxLayer(name) {
  const path = SFX_FILES[name];
  if (!path) {
    console.warn(`No sound file mapped for sfx "${name}"`);
    onSfxStatus(T("shared.sfx.noFile", { name }));
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

  onSfxStatus(T("shared.sfx.attempting", { name }));
  audio
    .play()
    .then(() => onSfxStatus(T("shared.sfx.playing", { name })))
    .catch((err) => {
      // Most common cause: no user gesture has unlocked audio yet (the
      // "Tap to begin" screen handles this on room-display.html).
      console.warn(`Playback blocked for "${name}":`, err.message);
      onSfxStatus(T("shared.sfx.blocked", { name, reason: String(err.message) }));
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


// ---- Live-connection safety net (added 9 October 2026) --------------------
// System review item 5: a live (Realtime) connection can drop silently —
// a corporate proxy, an idle timeout, a server hiccup — while the browser
// still says "online" and the tab stays visible, so onReconnect() never
// fires and a room screen would sit on an old inject with no error. Three
// layers now prevent that:
//   1. every live channel reports its status; an error, timeout or close
//      triggers an immediate refetch, and so does the channel coming back;
//   2. a light refetch every 15 seconds regardless (only re-renders when
//      the session row actually changed, so typing is never disturbed);
//   3. a small status pill in the corner: green "Live", amber
//      "Reconnecting…", red "Offline" — so a problem is visible at once.

function rowSignature(row) {
  if (!row) return "";
  return [row.status, row.current_inject_index, row.updated_at, row.inject_started_at,
    row.inject_extra_minutes, row.inject_force_unlocked, row.room_count,
    JSON.stringify(row.extra_departments || []), row.ended_at, row.notes_closed_at,
    row.run_number].join("|");
}

function createLiveStatus() {
  const el = document.createElement("div");
  el.id = "liveStatus";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.style.cssText = "position:fixed;inset-inline-end:10px;bottom:10px;z-index:9999;padding:4px 10px;" +
    "border-radius:999px;font:600 12px/1.4 'IBM Plex Sans',system-ui,-apple-system,sans-serif;color:#fff;" +
    "pointer-events:none;box-shadow:0 1px 4px rgba(0,0,0,.25);transition:background .2s";
  document.body.appendChild(el);
  const channels = new Map(); // name -> last status
  let fetchFailures = 0;
  const DOWN = new Set(["CHANNEL_ERROR", "TIMED_OUT", "CLOSED"]);
  function state() {
    if (!navigator.onLine) return "offline";
    if (fetchFailures >= 2) return "offline";
    for (const st of channels.values()) if (DOWN.has(st)) return "reconnecting";
    if (fetchFailures === 1) return "reconnecting";
    for (const st of channels.values()) if (st !== "SUBSCRIBED") return "connecting";
    return "live";
  }
  function draw() {
    const st = state();
    el.dataset.state = st;
    if (st === "live") { el.textContent = T("shared.live.live"); el.style.background = "rgba(34,139,84,.85)"; }
    else if (st === "connecting") { el.textContent = T("shared.live.connecting"); el.style.background = "rgba(120,120,120,.85)"; }
    else if (st === "reconnecting") { el.textContent = T("shared.live.reconnecting"); el.style.background = "rgba(200,140,20,.95)"; }
    else { el.textContent = T("shared.live.offline"); el.style.background = "rgba(200,50,40,.95)"; }
  }
  window.addEventListener("online", draw);
  window.addEventListener("offline", draw);
  draw();
  return {
    el,
    isDown: (name) => DOWN.has(channels.get(name)),
    // Register a channel before it reports, so the pill never says "Live"
    // until every expected channel has actually joined.
    expect(name) { if (!channels.has(name)) { channels.set(name, "JOINING"); draw(); } },
    channel(name, status) { channels.set(name, status); draw(); },
    fetchResult(ok) { fetchFailures = ok ? 0 : fetchFailures + 1; draw(); },
  };
}

// opts: { sessionId, supabaseClient?, onRow(row), onRecovered(row)?, onRing(kind)?, intervalMs? }
// Returns { deliver, channelStatus(name), resync(reason, {force}), softRefresh(), live, doorbell(), liveState() }.
// With supabaseClient it joins the session's doorbell channel itself: a
// "session" ring fetches the session (at most once a second); every ring is
// also passed to opts.onRing so the page can reload its messages.
function keepSessionInSync(opts) {
  const live = createLiveStatus();
  let lastSig = null;
  function deliver(row, force) {
    if (!row) return;
    const sig = rowSignature(row);
    if (sig === lastSig && !force) return;
    lastSig = sig;
    opts.onRow(row);
  }
  let inFlight = false;
  let again = null;
  async function resync(reason, o) {
    const force = !!(o && o.force);
    if (inFlight) {
      // Never drop a request made while a fetch is running: run once more after it.
      again = { reason, force: force || !!(again && again.force) };
      return;
    }
    inFlight = true;
    try {
      const row = await fetchSession(opts.sessionId);
      live.fetchResult(true);
      deliver(row, force);
      if (reason !== "poll" && reason !== "ring" && opts.onRecovered) opts.onRecovered(row);
    } catch (err) {
      live.fetchResult(false);
      console.warn(`Resync (${reason}) failed:`, err.message);
    } finally {
      inFlight = false;
      if (again) {
        const next = again;
        again = null;
        resync(next.reason, { force: next.force });
      }
    }
  }
  function channelStatus(name) {
    live.expect(name);
    return (status) => {
      const wasDown = live.isDown(name);
      live.channel(name, status);
      if (status === "SUBSCRIBED" && wasDown) resync("recovered");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") resync(`channel ${status}`);
    };
  }

  // The doorbell: at most one session fetch a second, however often it rings.
  let lastRingFetch = 0;
  let ringTimer = null;
  function onRing(kind) {
    if (kind === "session") {
      const wait = 1000 - (Date.now() - lastRingFetch);
      if (wait <= 0) {
        lastRingFetch = Date.now();
        resync("ring");
      } else if (!ringTimer) {
        ringTimer = setTimeout(() => {
          ringTimer = null;
          lastRingFetch = Date.now();
          resync("ring");
        }, wait);
      }
    }
    if (opts.onRing) opts.onRing(kind);
  }
  let channel = null;
  function joinDoorbell() {
    if (!opts.supabaseClient) return;
    channel = subscribeToDoorbell(opts.supabaseClient, opts.sessionId, onRing, channelStatus("doorbell"));
  }
  joinDoorbell();

  // "Refresh this screen" from the control tower: throw away what is shown,
  // rejoin the live channel, fetch everything and redraw — without reloading
  // the page, so sound that was switched on stays on.
  async function softRefresh() {
    try {
      if (channel && opts.supabaseClient) {
        const old = channel;
        channel = null;
        await opts.supabaseClient.removeChannel(old);
        live.channel("doorbell", "JOINING");
        joinDoorbell();
      }
    } catch (err) {
      console.warn("Rejoining the live channel failed:", err.message);
    }
    await resync("soft", { force: true });
  }

  setInterval(() => resync("poll"), opts.intervalMs || 15000);
  onReconnect(() => resync("reconnect"));
  return {
    deliver, channelStatus, resync, softRefresh, live,
    doorbell: () => channel,
    liveState: () => (live.el.dataset.state === "live" ? "live" : "poll"),
  };
}

// ---- Check-ins (item 6, 11 October 2026) -----------------------------------
// Every 20 seconds each device tells the database it is still here — over
// plain HTTP, so it works on networks that block live connections — and
// reports what it is showing. Only the Facilitator's link can read them (the
// control tower). The reply carries the exercise's real position, so a screen
// that is behind corrects itself, and any command the Facilitator queued for
// this screen ("soft" refresh or full "reload").
// opts: { sessionId, kind: "person"|"room_screen", attendeeId?, deviceId?,
//         getState() -> { room, page, shownStatus, shownInject, sound, awake, live },
//         onReply(reply)?, onRefused(message)?, intervalMs? }
const CHECKIN_INTERVAL_MS = 20000;
function startCheckins(opts) {
  let inFlight = false;
  async function beat() {
    // A page that is not in front is not "here": it stops checking in, and
    // checks in again the moment it is back.
    if (inFlight || document.hidden) return;
    inFlight = true;
    const ctl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 10000) : null;
    try {
      const st = (opts.getState && opts.getState()) || {};
      const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/player_checkin`, {
        method: "POST",
        cache: "no-store",
        headers: rpcHeaders(null),
        signal: ctl ? ctl.signal : undefined,
        body: JSON.stringify({
          p_session_id: opts.sessionId,
          p_kind: opts.kind,
          p_attendee_id: opts.attendeeId || null,
          p_device_id: opts.deviceId || null,
          p_room: st.room === undefined ? null : st.room,
          p_page: st.page || null,
          p_shown_status: st.shownStatus || null,
          p_shown_inject: Number.isInteger(st.shownInject) ? st.shownInject : null,
          p_sound: st.sound || null,
          p_awake: st.awake || null,
          p_live: st.live || null,
        }),
      });
      if (res.ok) {
        const reply = await res.json();
        if (opts.onReply) opts.onReply(reply || {});
      } else if (res.status === 401 || res.status === 403) {
        if (opts.onRefused) opts.onRefused(await readErrorDetail(res));
      }
    } catch {
      /* offline or timed out — the next beat tries again */
    } finally {
      if (timer) clearTimeout(timer);
      inFlight = false;
    }
  }
  // After the screen changes what it shows, report it shortly (not on every
  // redraw), so the control tower is never 20 seconds behind the screen.
  let soonTimer = null;
  function beatSoon() {
    if (soonTimer) return;
    soonTimer = setTimeout(() => {
      soonTimer = null;
      beat();
    }, 1500);
  }
  beat();
  setInterval(beat, opts.intervalMs || CHECKIN_INTERVAL_MS);
  onReconnect(beat);
  return { beat, beatSoon };
}

// ---- The control tower's own calls (facilitator token only) ----------------
async function fetchPresence(sessionId, facilitatorToken) {
  assertValidSessionId(sessionId);
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/facilitator_presence`, {
    method: "POST",
    cache: "no-store",
    headers: rpcHeaders(facilitatorToken),
    body: JSON.stringify({ p_session_id: sessionId }),
  });
  if (!res.ok) throw new Error(await readErrorDetail(res));
  return res.json();
}

// command: "soft" (refresh without reloading — sound stays on) or "reload".
async function sendScreenCommand(sessionId, deviceKey, command, facilitatorToken) {
  assertValidSessionId(sessionId);
  const res = await withRetry(() =>
    fetch(`${SUPABASE_URL}/rest/v1/rpc/facilitator_screen_command`, {
      method: "POST",
      cache: "no-store",
      headers: rpcHeaders(facilitatorToken),
      body: JSON.stringify({ p_session_id: sessionId, p_device_key: deviceKey, p_command: command }),
    })
  );
  if (!res.ok) throw new Error(await readErrorDetail(res));
  return res.json();
}

// How fresh a check-in is, against the server's own clock.
const PRESENCE_GREEN_MS = 45000;
const PRESENCE_AMBER_MS = 120000;
function presenceState(lastSeenIso, serverNowMs) {
  if (!lastSeenIso) return "never";
  const age = serverNowMs - Date.parse(lastSeenIso);
  if (age <= PRESENCE_GREEN_MS) return "green";
  if (age <= PRESENCE_AMBER_MS) return "amber";
  return "grey";
}

// The usual reaction to a check-in reply: obey a queued command, and if the
// reply shows the exercise is somewhere else than this screen, fetch it now.
function handleCheckinReply(reply, { sync, getRow, onSoft }) {
  if (reply.command === "reload") {
    try { sessionStorage.setItem("pp_reloaded_by_facilitator", "1"); } catch { /* ignore */ }
    location.reload();
    return;
  }
  if (reply.command === "soft") {
    sync.softRefresh().then(() => { if (onSoft) onSoft(); });
    return;
  }
  const row = getRow();
  const sameTime = row && Date.parse(row.updated_at) === Date.parse(reply.updated_at);
  if (!row || row.status !== reply.status || row.current_inject_index !== reply.current_inject_index || !sameTime) {
    sync.resync("checkin");
  }
}

// A stable id for a shared room screen (it has no registration), kept in
// this browser. { deviceId, room }.
function loadScreenIdentity(sessionId) {
  const key = `pp_screen_${sessionId}`;
  let me = null;
  try { me = JSON.parse(localStorage.getItem(key) || "null"); } catch { me = null; }
  if (!me || !UUID_RE.test(me.deviceId || "")) me = { deviceId: crypto.randomUUID(), room: null, started: false };
  const store = () => { try { localStorage.setItem(key, JSON.stringify(me)); } catch { /* kept in memory only */ } };
  store();
  return { me, store };
}

// ---- Keep the device awake (item 6, 11 October 2026) -----------------------
// Asks the browser to keep the screen on while this page is in front (the
// way a video player does), whenever wanted() is true. state(): "on", "off"
// (wanted but the device refused or can't — battery saver, old browser) or
// "na" (not wanted now). The browser drops the request whenever the page
// leaves the front; it is asked again the moment the page is back.
function keepAwake({ wanted, onChange }) {
  const supported = !!(navigator.wakeLock && navigator.wakeLock.request);
  let lock = null;
  let state = "na";
  let requesting = false;
  let letGo = false; // true while this code is releasing it on purpose
  function set(next) {
    if (next === state) return;
    state = next;
    if (onChange) onChange(state);
  }
  async function update() {
    let want = false;
    try { want = !!wanted(); } catch { want = false; }
    if (!want) {
      if (lock) {
        const held = lock;
        lock = null;
        letGo = true;
        try { await held.release(); } catch { /* already gone */ }
        letGo = false;
      }
      set("na");
      return;
    }
    if (!supported) { set("off"); return; }
    if (lock) { set("on"); return; }
    if (document.hidden || requesting) return;
    requesting = true;
    try {
      const got = await navigator.wakeLock.request("screen");
      lock = got;
      got.addEventListener("release", () => {
        if (lock === got) lock = null;
        if (letGo) return;
        // Dropped while in front (for example battery saver switching on):
        // say so, and try again shortly.
        if (!document.hidden) { set("off"); setTimeout(update, 3000); }
      });
      set("on");
    } catch {
      lock = null;
      set("off");
    } finally {
      requesting = false;
    }
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) update(); });
  // Some browsers only grant it after the person has touched the page.
  ["click", "touchend", "keydown"].forEach((ev) =>
    document.addEventListener(ev, () => { if (state === "off") update(); }, { passive: true })
  );
  setInterval(update, 30000);
  update();
  return { state: () => state, update };
}

// A small fixed notice (one per id). text null/"" hides it.
function setNotice(id, text, { tone } = {}) {
  let el = document.getElementById(id);
  if (!text) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    el.className = "pp-notice-fixed";
    el.setAttribute("role", "status");
    el.style.cssText = "position:fixed;inset-inline-start:10px;bottom:36px;z-index:9998;max-width:min(420px,calc(100vw - 150px));" +
      "padding:6px 10px;border-radius:8px;font:500 12px/1.35 'IBM Plex Sans',system-ui,-apple-system,sans-serif;color:#fff;" +
      "box-shadow:0 1px 4px rgba(0,0,0,.25)";
    document.body.appendChild(el);
  }
  el.style.background = tone === "info" ? "rgba(33,43,54,.96)" : "rgba(150,95,10,.95)";
  el.textContent = text;
}
const AWAKE_NOTICE = T("shared.notice.awake");

// A message across the top that the person dismisses (or that goes after
// `ms`). Used for "welcome back" and "refreshed by the facilitator".
function showToast(text, ms) {
  let el = document.getElementById("ppToast");
  if (!el) {
    el = document.createElement("div");
    el.id = "ppToast";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.style.cssText = "position:fixed;left:10px;right:10px;top:10px;margin:0 auto;width:fit-content;z-index:10000;" +
      "max-width:min(560px,calc(100vw - 20px));padding:10px 14px;border-radius:10px;cursor:pointer;" +
      "font:600 14px/1.4 'IBM Plex Sans',system-ui,-apple-system,sans-serif;color:#201404;background:#e2a63b;" +
      "box-shadow:0 2px 10px rgba(0,0,0,.35)";
    el.title = T("shared.toast.dismissTitle");
    el.addEventListener("click", () => el.remove());
    document.body.appendChild(el);
  }
  el.textContent = text;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { if (el.parentNode) el.remove(); }, ms || 15000);
}

// ---- Coming back after being away (item 6, 11 October 2026) ----------------
// A phone call, a locked screen or another app pauses the page. onBack(ms)
// fires when it has been away for at least minMs — either the page was not
// in front, or its clock stopped (the device slept).
function watchAway({ minMs, onBack }) {
  const min = minMs || 60000;
  let hiddenAt = document.hidden ? Date.now() : null;
  let lastTick = Date.now();
  let lastFired = 0;
  function fire(ms) {
    if (Date.now() - lastFired < 10000) return;
    lastFired = Date.now();
    onBack(ms);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = null;
    lastTick = Date.now();
    if (away >= min) fire(away);
  });
  setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (!document.hidden && gap >= min + 5000) fire(gap);
  }, 5000);
}

function awayText(ms, row) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (!row) return T("shared.away.only", { count: mins });
  if (row.status === "ended") return T("shared.away.ended", { count: mins });
  if (row.status === "lobby") return T("shared.away.lobby", { count: mins });
  const total = ((row.scenario && row.scenario.injects) || []).length;
  const inject = row.current_inject_index + 1;
  return total
    ? T("shared.away.onInjectOf", { count: mins, inject, total })
    : T("shared.away.onInject", { count: mins, inject });
}


// ---- Welcome and thank-you screens (roadmap item 8, 11 October 2026) ------
// Before the exercise the wording is in the present ("tests the plan"); at
// the end it is in the past ("tested the plan") — Ahmed, 11 October 2026.
// The first name comes from the registration kept on the person's own
// device (join.html). It is never fetched, and never shown on a shared
// room screen. One layout for phones and laptops.
const ANSWERS_KEEP_AFTER_END_MS = 60 * 60 * 1000; // a phone keeps its copy of the answers this long after End

function ppEscape(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// The first name to greet someone by, or "" when the device has none (then
// the screens simply say "Thank you"). An older registration that only has
// the full name gives its first word. Kept to a sensible length.
function greetingName(identity) {
  if (!identity) return "";
  let n = typeof identity.firstName === "string" ? identity.firstName : "";
  if (!n.trim() && typeof identity.name === "string") n = identity.name.trim().split(/\s+/)[0] || "";
  n = n.replace(/\s+/g, " ").trim();
  if (n.length > 40) n = n.slice(0, 40).trim() + "…";
  return n;
}

// "Thank you, Ahmed" — the name in its own direction-isolated span, so an
// Arabic name sits correctly inside the English line.
function thanksLine(name) {
  return name ? T("shared.thanks.named_html", { name: ppEscape(name) }) : ppEscape(T("shared.thanks.plain"));
}

// After registering, while waiting for the start.
//   observer: true  -> "registered as an Observer"
function welcomeScreenHtml({ name, observer } = {}) {
  return `
    <section class="pp-thanks pp-thanks-welcome" aria-live="polite">
      <h1 class="pp-thanks-title">${thanksLine(name)}</h1>
      <p class="pp-thanks-lead">${ppEscape(observer ? T("shared.welcome.registeredObserver") : T("shared.welcome.registered"))}</p>
      <p class="pp-thanks-nofault">${ppEscape(T("shared.welcome.noFault"))}</p>
      <p class="pp-thanks-phone">${ppEscape(T("shared.welcome.phone"))}</p>
      <p class="pp-thanks-wait">${ppEscape(T("shared.welcome.waiting"))}</p>
    </section>`;
}

// At the end.
//   everyone: true -> the shared room screen ("Thank you, everyone"), never a name
//   compact: true  -> a card that leaves room for what stays usable under it (Observers)
//   label          -> the exercise's name (room screen)
//   extraHtml      -> an extra block inside the card (the Observer's time line)
//   close: false   -> leave out "You can now close this page."
function endScreenHtml({ name, everyone, compact, label, extraHtml, close } = {}) {
  const title = everyone ? ppEscape(T("shared.thanks.everyone")) : thanksLine(name);
  return `
    <section class="pp-thanks pp-thanks-end${compact ? " compact" : ""}${everyone ? " everyone" : ""}" aria-live="polite">
      <h1 class="pp-thanks-title">${title}</h1>
      <p class="pp-thanks-lead">${ppEscape(T("shared.end.ended"))}</p>
      ${label ? `<p class="pp-thanks-label">${ppEscape(label)}</p>` : ""}
      <p class="pp-thanks-nofault">${ppEscape(T("shared.end.noFault"))}</p>
      ${extraHtml || ""}
      ${close === false ? "" : `<p class="pp-thanks-close">${ppEscape(T("shared.end.closePage"))}</p>`}
    </section>`;
}

// True when the inject on screen came back through "Resume at inject N"
// (the exercise was ended and carried on): the database then moves the
// inject's clock forward, so it no longer matches the inject's first start
// in the log. A resumed inject returns silently — its sound belongs to the
// moment it first appeared (Ahmed, 12 October 2026). A fresh inject, and one
// restarted with "Previous inject", have the two times equal.
function injectWasResumed(row, idx) {
  if (!row || !row.inject_started_at) return false;
  const first = (row.inject_started_log || {})[String(idx)];
  if (!first) return false;
  return Math.abs(Date.parse(row.inject_started_at) - Date.parse(first)) > 1500;
}

// "52 minutes left" / "1 minute left" / "less than a minute left".
function minutesLeftText(ms) {
  if (ms < 60000) return T("shared.time.lessThanMinuteLeft");
  const m = Math.floor(ms / 60000);
  return T("shared.time.minutesLeft", { count: m });
}
function clockTimeText(ms) {
  return new Date(ms).toLocaleTimeString(PPLang.locales(), { hour: "2-digit", minute: "2-digit" });
}

// The Observer's line under the thank-you: how long the notes area and the
// message box stay usable. Follows the same two rules as the pages
// themselves (notesWindow, observerChannel); the database still decides.
function observerAfterEndLine(row, nowMs) {
  const now = nowMs === undefined ? Date.now() : nowMs;
  const notes = notesWindow(row, "observer", now);
  const chan = observerChannel(row, now);
  if (notes.open && notes.closesAt) {
    // One whole sentence per case (with or without messages; under a minute
    // or a count of minutes) — the same split as minutesLeftText.
    const time = clockTimeText(notes.closesAt);
    const left = notes.closesAt - now;
    const count = Math.floor(left / 60000);
    let text;
    if (chan.open) {
      text = left < 60000
        ? T("shared.observerEnd.notesAndMessagesUntilSoon", { time })
        : T("shared.observerEnd.notesAndMessagesUntil", { time, count });
    } else {
      text = left < 60000
        ? T("shared.observerEnd.notesUntilSoon", { time })
        : T("shared.observerEnd.notesUntil", { time, count });
    }
    return { open: true, text };
  }
  return { open: false, text: T("shared.observerEnd.closed") };
}

