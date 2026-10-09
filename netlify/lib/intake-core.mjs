// PlanProof intake: the shared logic behind the website's four request forms.
//
// Why this exists (8 October 2026): the forms used to go through Netlify
// Forms, whose built-in spam filter cannot be switched off. A request it
// flags is never passed on, so a real client request could disappear without
// anyone knowing. The forms now post straight to PlanProof's own functions,
// and this module decides what happens to each request.
//
// Design rules (no request is ever lost silently):
//   1. A request is written to durable storage (Netlify Blobs) BEFORE anything
//      else is attempted, so a failure later on cannot lose it.
//   2. It is then saved to Supabase (admin page) and emailed to the inbox.
//      Each of those is a separate step; whichever fails is retried by the
//      scheduled function (intake-retry) until it succeeds.
//   3. Nothing is ever dropped as spam. A request that looks automated is
//      still delivered, with "Possible spam" in the email subject and notes.
//   4. Plan documents are held only until the email carrying them has been
//      sent, then deleted (privacy policy: materials are not kept here).
//
// The functions in netlify/functions/ are thin wrappers around this module, so
// the logic can be tested without Netlify (see tests/intake.test.mjs).

import crypto from "node:crypto";

export const FORM_NAMES = ["contact-request", "demo-walkthrough", "generic-scenario", "plan-review"];
export const MAX_FILE_BYTES = 8 * 1024 * 1024; // the site tells visitors 8 MB
export const CHUNK_BYTES = 2 * 1024 * 1024; // the browser uploads files in parts of at most 2 MB
export const MAX_PARTS = Math.ceil(MAX_FILE_BYTES / CHUNK_BYTES); // 4
export const MAX_BODY_CHARS = 200 * 1024; // form answers only (no files) — far above any real request
export const MIN_FILL_MS = 3000; // a person cannot complete any of the forms in under 3 seconds
export const RETRY_SLOW_AFTER_MS = 24 * 60 * 60 * 1000; // after a day, retry once an hour (never give up: the health check raises the alarm)
export const SLOW_RETRY_INTERVAL_MS = 60 * 60 * 1000;
export const SPAM_EMAILS_PER_DAY = 5; // after this many "possible spam" emails in a UTC day, the rest go to the daily digest (still saved to Supabase)
export const STATS_KEEP_DAYS = 14;
export const ORPHAN_UPLOAD_MS = 24 * 60 * 60 * 1000; // a file never followed by its form is deleted after a day
export const DONE_MARKER_MS = 2 * 24 * 60 * 60 * 1000;
export const INBOX = "exercises@plan-proof.com";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === "string" && UUID_RE.test(v);

export class IntakeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// Trim a form value to a short clean string (or null). Arrays (several
// checkboxes with the same name) become "a, b, c".
export function clean(v, max = 2000) {
  if (v == null) return null;
  const s = String(Array.isArray(v) ? v.join(", ") : v).trim();
  return s ? s.slice(0, max) : null;
}
function oneOf(v, allowed) {
  const s = clean(v, 40);
  return s && allowed.includes(s) ? s : null;
}
// "Fire (main), Flood, Cyberattack" -> ["Fire", "Flood", "Cyberattack"]
export function parseRiskConcerns(riskStr) {
  if (!riskStr || typeof riskStr !== "string") return [null, null, null];
  const parts = riskStr.split(",").map((s) => s.trim().replace(/\s*\(main\)\s*$/i, "")).filter(Boolean);
  return [parts[0] || null, parts[1] || null, parts[2] || null];
}
function safeFilename(name) {
  const base = String(name || "plan-document").split(/[\\/]/).pop();
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || "plan-document";
}
const uaeTime = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai" });

// ---------------------------------------------------------------------------
// 1. Turning a browser request into a record
// ---------------------------------------------------------------------------

// body = what the browser sends to /api/intake (see index.html, submitIntake):
//   { submission_id, form_name, data: {field: value | [values]}, honeypot,
//     elapsed_ms, file: {upload_id, name, type, size, parts} | null,
//     file_upload_failed: {name, size} | null }
export function buildRecord(body, nowMs = Date.now()) {
  if (!body || typeof body !== "object") throw new IntakeError(400, "Request body must be a JSON object");
  const formName = body.form_name;
  if (!FORM_NAMES.includes(formName)) throw new IntakeError(400, "Unknown form");

  const data = {};
  const rawData = body.data && typeof body.data === "object" ? body.data : {};
  const keys = Object.keys(rawData);
  if (keys.length > 100) throw new IntakeError(400, "Too many fields");
  for (const k of keys) {
    if (!/^[\w-]{1,60}$/.test(k)) continue;
    const v = rawData[k];
    if (Array.isArray(v)) data[k] = v.slice(0, 60).map((x) => String(x ?? "").slice(0, 20000));
    else if (v != null) data[k] = String(v).slice(0, 20000);
  }

  const spamReasons = [];
  if (clean(body.honeypot)) spamReasons.push("the hidden anti-bot field was filled in");
  const elapsed = Number(body.elapsed_ms);
  if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < MIN_FILL_MS) spamReasons.push("the form was completed in under 3 seconds");
  if (!Number.isFinite(elapsed)) spamReasons.push("the request did not come through the website's form");

  let file = null;
  if (body.file) {
    const f = body.file;
    const size = Number(f.size);
    const parts = Number(f.parts);
    if (!isUuid(f.upload_id)) throw new IntakeError(400, "Invalid upload id");
    if (!Number.isInteger(size) || size <= 0 || size > MAX_FILE_BYTES) throw new IntakeError(400, "Invalid file size");
    if (!Number.isInteger(parts) || parts !== Math.ceil(size / CHUNK_BYTES)) throw new IntakeError(400, "Invalid file parts");
    file = { uploadId: f.upload_id.toLowerCase(), name: safeFilename(f.name), size, parts };
  }
  let fileUploadFailed = null;
  if (body.file_upload_failed && !file) {
    fileUploadFailed = { name: safeFilename(body.file_upload_failed.name), size: Number(body.file_upload_failed.size) || null };
  }

  const id = isUuid(body.submission_id) ? body.submission_id.toLowerCase() : crypto.randomUUID();
  return {
    id,
    clientId: crypto.randomUUID(),
    receivedAt: new Date(nowMs).toISOString(),
    formName,
    data,
    file,
    fileUploadFailed,
    spamReasons,
    steps: { supabase: false, email: false },
    attempts: 0,
    lastErrors: {},
  };
}

// ---------------------------------------------------------------------------
// 2. Supabase (the admin page reads these rows)
// ---------------------------------------------------------------------------

// Headers for every Supabase call made by the server. When INTAKE_DB_SECRET is
// set (Netlify environment variable, server-only), it is sent as
// x-intake-secret: the database then accepts new requests ONLY from this
// function, not from anyone holding the public key (see the
// intake_hardening migration and private.intake_insert_allowed()).
export function supabaseHeaders(env, extra = {}) {
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  const h = { apikey: key, Authorization: `Bearer ${key}`, ...extra };
  if (env.INTAKE_DB_SECRET) h["x-intake-secret"] = env.INTAKE_DB_SECRET;
  return h;
}

async function supabaseInsert(table, rows, { fetchFn, env, timeoutMs }) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase env vars not set");
  const res = await fetchFn(`${url}/rest/v1/${table}`, {
    method: "POST",
    headers: supabaseHeaders(env, { "Content-Type": "application/json", Prefer: "return=minimal" }),
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(timeoutMs),
  });
  // 409 = this row already exists (an earlier attempt got through) — that is success.
  if (res.ok || res.status === 409) return;
  throw new Error(`Supabase insert into ${table} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
}

export async function saveToSupabase(record, deps) {
  const { data, formName } = record;
  const opts = { fetchFn: deps.fetchFn, env: deps.env, timeoutMs: deps.timeoutMs ?? 4000 };
  const [riskMain, risk2, risk3] = parseRiskConcerns(data.risk);
  const industry = data.industry === "__other__" || /^other$/i.test(data.industry || "") ? data.industry_other || data.industry : data.industry;
  await supabaseInsert("clients", [{
    id: record.clientId,
    company_name: clean(data.organization, 300) || "(not given)",
    contact_name: clean(data.name, 200),
    email: clean(data.email, 320),
    phone: clean(data.mobile, 60),
    sector: clean(industry, 200),
    size_band: clean(data.size, 100),
    location: clean(data.location, 200),
  }], opts);
  const usedBefore = oneOf(data.used_before, ["yes", "no", "not_sure"]);
  const returning = usedBefore === "yes"; // returning-client answers only count when "Yes" was chosen
  const label = record.spamReasons.length ? `POSSIBLE SPAM (${record.spamReasons.join("; ")}) — check before acting.\n\n` : "";
  const fileNote = record.file
    ? `\n\nPlan document: ${record.file.name} — sent to the inbox as an email attachment (not stored here).`
    : record.fileUploadFailed
      ? `\n\nPlan document: "${record.fileUploadFailed.name}" did NOT upload. Ask the client to email it.`
      : "";
  await supabaseInsert("submissions", [{
    id: record.id,
    client_id: record.clientId,
    form_name: clean(formName, 60),
    service_type: clean(data.service_type, 200),
    risk_concern_1: riskMain,
    risk_concern_2: risk2,
    risk_concern_3: risk3,
    key_operations: clean(data.operations, 4000),
    org_unit: clean(data.org_unit, 300),
    used_before: usedBefore,
    reference_given: returning ? clean(data.client_ref, 40) : null,
    last_exercise_when: returning ? clean(data.last_exercise_when, 100) : null,
    retest_or_new: returning ? oneOf(data.retest_or_new, ["retest", "new", "unsure"]) : null,
    what_changed: returning ? clean(data.what_changed, 4000) : null,
    actions_done: returning ? clean(data.actions_done, 4000) : null,
    plan_updated: returning ? clean(data.plan_updated, 300) : null,
    history_opt_out: !!clean(data.history_opt_out, 10),
    notes: `${label}Form: ${formName}\n\n${data.formatted_summary || "(No summary available)"}${fileNote}`,
  }], opts);
}

// ---------------------------------------------------------------------------
// 3. Email (Resend)
// ---------------------------------------------------------------------------

// Returns { buffer } when every part is present, { missing: true } otherwise.
export async function assembleFile(file, uploads) {
  const buffers = [];
  for (let i = 0; i < file.parts; i++) {
    const part = await uploads.get(`${file.uploadId}/${i}`, { type: "arrayBuffer" });
    if (!part) return { missing: true };
    buffers.push(Buffer.from(part));
  }
  const buffer = Buffer.concat(buffers);
  if (buffer.length !== file.size) return { missing: true };
  return { buffer };
}

export function buildEmail(record, fileResult) {
  const { data, formName } = record;
  const org = clean(data.organization, 200) || "PlanProof";
  const usedBeforeText = { yes: "Yes", no: "No", not_sure: "Not sure" }[String(data.used_before || "").trim()];
  const delayed = record.attempts > 0 ? " [delayed delivery]" : "";
  const subject = (record.spamReasons.length ? "⚠ Possible spam — " : "")
    + `New ${formName} submission — ${org}`
    + (usedBeforeText ? ` (exercised before: ${usedBeforeText})` : "")
    + delayed;

  const lines = [];
  if (record.spamReasons.length) {
    lines.push("POSSIBLE SPAM — this was still delivered so nothing real is lost.");
    lines.push(`Why it was flagged: ${record.spamReasons.join("; ")}.`);
    lines.push("If it is junk, ignore it and erase it on the admin page.", "");
  }
  lines.push(`New submission: ${formName}`, `Received: ${uaeTime(record.receivedAt)} (UAE time)`);
  if (record.attempts > 0) lines.push("(This email was delayed: the first attempt to send it failed and it was retried automatically.)");
  lines.push("", data.formatted_summary || "(No summary available)");

  const attachments = [];
  if (record.file) {
    lines.push("");
    if (fileResult && fileResult.buffer) {
      attachments.push({ filename: record.file.name, content: fileResult.buffer.toString("base64") });
      lines.push(`Attached plan document: ${record.file.name} (see attachment)`);
    } else {
      lines.push(`The plan document "${record.file.name}" could not be found in temporary storage. Ask the client to email it.`);
    }
  } else if (record.fileUploadFailed) {
    lines.push("", `The plan document "${record.fileUploadFailed.name}" did not upload from the client's browser. The client was asked to email it to ${INBOX}.`);
  } else if (formName === "plan-review") {
    lines.push("", "No plan document was received with this submission.");
  }

  const text = lines.join("\n");
  attachments.push({ filename: `${formName}-submission.txt`, content: Buffer.from(text).toString("base64") });
  return { subject, text, attachments };
}

// Sends one email through Resend to `to` (array). PlanProof's verified
// sending domain first; Resend's shared address as a fallback.
export async function sendViaResend({ to, subject, text, attachments }, deps) {
  const { fetchFn, env } = deps;
  const timeoutMs = deps.timeoutMs ?? 6000;
  if (!env.RESEND_API_KEY) throw new Error("Email not sent: RESEND_API_KEY not set");
  const senders = [env.RESEND_FROM_ADDRESS, "PlanProof <alerts@notify.plan-proof.com>", "onboarding@resend.dev"]
    .filter((v, i, arr) => v && arr.indexOf(v) === i);
  let lastError = "";
  for (const from of senders) {
    try {
      const res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to, subject, text, ...(attachments && attachments.length ? { attachments } : {}) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return;
      lastError = `HTTP ${res.status} from ${from}: ${(await res.text()).slice(0, 300)}`;
      // Only a sender problem (4xx other than rate-limit) is worth trying the next sender for.
      if (!(res.status >= 400 && res.status < 500 && res.status !== 429)) break;
    } catch (err) {
      lastError = err.message;
      break; // network trouble: leave it to the scheduled retry
    }
  }
  throw new Error(`Email not sent: ${lastError}`);
}

export async function sendEmail(record, fileResult, deps) {
  const { subject, text, attachments } = buildEmail(record, fileResult);
  await sendViaResend({ to: [INBOX], subject, text, attachments }, deps);
}

// ---------------------------------------------------------------------------
// Daily counters (for the spam cap, the daily digest and the weekly heartbeat).
// Kept in the intake-pending store under stats/YYYY-MM-DD; best effort only —
// a counter that fails to save never blocks a request.
// ---------------------------------------------------------------------------

export const dayKey = (ms) => `stats/${new Date(ms).toISOString().slice(0, 10)}`;
export async function readStats(store, ms) {
  try { return (await store.get(dayKey(ms), { type: "json" })) || {}; } catch { return {}; }
}
export async function bumpStats(store, ms, field, by = 1) {
  try {
    const st = await readStats(store, ms);
    st[field] = (st[field] || 0) + by;
    await store.setJSON(dayKey(ms), st);
    return st;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// 4. Processing a record (first attempt and every retry)
// ---------------------------------------------------------------------------

// deps: { pending, uploads, fetchFn, env, log }
//   pending  — Blobs store holding records until both steps are done
//   uploads  — Blobs store holding plan-document parts
export async function processRecord(record, deps) {
  const log = deps.log || console;
  if (!record.steps.supabase) {
    try {
      await saveToSupabase(record, deps);
      record.steps.supabase = true;
      delete record.lastErrors.supabase;
    } catch (err) {
      record.lastErrors.supabase = err.message;
      log.error(`[intake ${record.id}] Supabase save failed:`, err.message);
    }
  }
  if (!record.steps.email) {
    try {
      let fileResult = null;
      if (record.file) {
        fileResult = await assembleFile(record.file, deps.uploads);
        // A missing file on the first try may just be slow storage; retry later.
        // After the first hour, send without it rather than hold the request back.
        const ageMs = (deps.nowMs ?? Date.now()) - Date.parse(record.receivedAt);
        if (fileResult.missing && ageMs < 60 * 60 * 1000) throw new Error("Plan document parts not all available yet");
      }
      // Flood protection: once SPAM_EMAILS_PER_DAY "possible spam" emails have
      // gone out today, further ones are not emailed one by one — they are
      // already on the admin page (Supabase step done) and the next morning's
      // digest email counts them. A request whose Supabase save failed is
      // always emailed, so nothing can disappear.
      const nowMs = deps.nowMs ?? Date.now();
      if (record.spamReasons.length && record.steps.supabase && deps.pending) {
        const st = await readStats(deps.pending, nowMs);
        if ((st.spamEmailed || 0) >= SPAM_EMAILS_PER_DAY) {
          record.emailSuppressed = true;
          record.steps.email = true;
          delete record.lastErrors.email;
          await bumpStats(deps.pending, nowMs, "spamSuppressed");
          return record;
        }
      }
      await sendEmail(record, fileResult, deps);
      record.steps.email = true;
      delete record.lastErrors.email;
      if (record.spamReasons.length && deps.pending) await bumpStats(deps.pending, nowMs, "spamEmailed");
    } catch (err) {
      record.lastErrors.email = err.message;
      log.error(`[intake ${record.id}] Email failed:`, err.message);
    }
  }
  return record;
}

// Store the outcome: finished records are removed (and their file deleted);
// unfinished ones stay in `pending` for intake-retry.
export async function settleRecord(record, deps) {
  const done = record.steps.supabase && record.steps.email;
  if (done) {
    await deps.pending.setJSON(`done/${record.id}`, { at: deps.nowMs ?? Date.now() });
    await deps.pending.delete(`rec/${record.id}`);
    if (record.file) await deleteUpload(record.file, deps.uploads);
  } else {
    await deps.pending.setJSON(`rec/${record.id}`, record);
  }
  return done;
}

export async function deleteUpload(file, uploads) {
  for (let i = 0; i < file.parts; i++) {
    try { await uploads.delete(`${file.uploadId}/${i}`); } catch { /* best effort; the daily clean-up catches leftovers */ }
  }
}

// The whole first attempt, as run by the intake function. Returns
// { ok: boolean } — ok means the request is safe (stored or delivered).
export async function handleIntake(body, deps) {
  const log = deps.log || console;
  const record = buildRecord(body, deps.nowMs);

  // The browser may retry if our reply was slow. Same submission id = same request.
  try {
    if (await deps.pending.get(`done/${record.id}`)) return { ok: true, duplicate: true };
    const existing = await deps.pending.get(`rec/${record.id}`, { type: "json" });
    if (existing) return { ok: true, duplicate: true }; // already stored; intake-retry will finish it
  } catch (err) {
    log.error(`[intake ${record.id}] Could not check for duplicates:`, err.message);
  }

  let stored = false;
  try {
    await deps.pending.setJSON(`rec/${record.id}`, record); // rule 1: durable first
    await bumpStats(deps.pending, deps.nowMs ?? Date.now(), record.spamReasons.length ? "receivedSpam" : "received");
    stored = true;
  } catch (err) {
    log.error(`[intake ${record.id}] Could not store the request:`, err.message);
  }

  await processRecord(record, deps);
  try {
    await settleRecord(record, deps);
    stored = true;
  } catch (err) {
    log.error(`[intake ${record.id}] Could not settle the request:`, err.message);
  }
  const ok = stored || record.steps.supabase || record.steps.email;
  if (!ok) log.error(`[intake ${record.id}] LOST: not stored, not saved, not emailed. Visitor was shown the email fallback.`);
  return { ok, steps: record.steps };
}

// ---------------------------------------------------------------------------
// 5. Scheduled retry and clean-up (intake-retry, every 5 minutes)
// ---------------------------------------------------------------------------

export async function retryPending(deps) {
  const log = deps.log || console;
  const nowMs = deps.nowMs ?? Date.now();
  const summary = { retried: 0, finished: 0, stillPending: 0, slow: 0, waiting: 0, uploadsDeleted: 0, markersDeleted: 0 };

  const { blobs: pendingBlobs } = await deps.pending.list();
  const referencedUploads = new Set();
  for (const { key } of pendingBlobs) {
    if (key.startsWith("done/")) {
      const marker = await deps.pending.get(key, { type: "json" });
      if (!marker || nowMs - marker.at > DONE_MARKER_MS) {
        await deps.pending.delete(key);
        summary.markersDeleted++;
      }
      continue;
    }
    if (key.startsWith("stats/")) {
      const day = Date.parse(key.slice(6));
      if (Number.isFinite(day) && nowMs - day > STATS_KEEP_DAYS * 24 * 60 * 60 * 1000) await deps.pending.delete(key);
      continue;
    }
    if (!key.startsWith("rec/")) continue;
    const record = await deps.pending.get(key, { type: "json" });
    if (!record) continue;
    if (record.file) referencedUploads.add(record.file.uploadId);
    // Never give up. After a day, retry once an hour; the health check
    // (system-check, /api/health, admin page banner) is already alarming.
    if (nowMs - Date.parse(record.receivedAt) > RETRY_SLOW_AFTER_MS) {
      summary.slow++;
      if (record.lastAttemptAt && nowMs - record.lastAttemptAt < SLOW_RETRY_INTERVAL_MS) { summary.waiting++; continue; }
    }
    record.attempts += 1;
    record.lastAttemptAt = nowMs;
    summary.retried++;
    await processRecord(record, { ...deps, nowMs });
    const done = await settleRecord(record, { ...deps, nowMs });
    if (done) summary.finished++;
    else {
      summary.stillPending++;
      log.error(`[intake ${record.id}] still undelivered after ${record.attempts} retries. Last errors:`, JSON.stringify(record.lastErrors));
    }
  }

  // Plan-document parts whose form was never sent (visitor gave up) — delete after a day.
  const { blobs: uploadBlobs } = await deps.uploads.list();
  for (const { key } of uploadBlobs) {
    const uploadId = key.split("/")[0];
    if (referencedUploads.has(uploadId)) continue;
    const meta = await deps.uploads.getMetadata(key);
    const at = meta && meta.metadata ? Number(meta.metadata.uploadedAt) : 0;
    if (!at || nowMs - at > ORPHAN_UPLOAD_MS) {
      await deps.uploads.delete(key);
      summary.uploadsDeleted++;
    }
  }

  // Proof of life for the health check: if this stops being updated, the
  // scheduled retry is not running and /api/health reports it.
  try { await deps.pending.setJSON("meta/last-retry-run", { at: nowMs, summary }); } catch (err) { log.error("Could not record the retry run:", err.message); }
  return summary;
}

// ---------------------------------------------------------------------------
// 6. Plan-document parts (intake-upload)
// ---------------------------------------------------------------------------

export function checkUploadParams(params, byteLength) {
  const id = params.get("id");
  const part = Number(params.get("part"));
  const parts = Number(params.get("parts"));
  if (!isUuid(id)) throw new IntakeError(400, "Invalid upload id");
  if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) throw new IntakeError(400, "Invalid number of parts");
  if (!Number.isInteger(part) || part < 0 || part >= parts) throw new IntakeError(400, "Invalid part");
  if (!byteLength) throw new IntakeError(400, "Empty part");
  if (byteLength > CHUNK_BYTES) throw new IntakeError(413, "Part too large");
  return { key: `${id.toLowerCase()}/${part}`, parts };
}
