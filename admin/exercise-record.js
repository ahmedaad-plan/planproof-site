/* PlanProof — exercise record (W5, 26 October 2026).
 *
 * Turns the database's record of one ended exercise (public.admin_export_record)
 * into the files PlanProof keeps for the report:
 *   exercise-report-<R-number>.txt   what the planproof-report skill reads
 *   exercise-record.json             the same record, exact
 *   attachments/...                  the participants' files
 *   manifest.txt                     every file with its SHA-256 fingerprint
 *
 * Pure functions only (no page, no network), so the same file runs on the admin
 * page and in the Node tests. The rules follow the exercise player:
 *   - only the current run (earlier and trial runs are counted, never included);
 *   - a department added during the exercise is not required for the injects it
 *     missed (it started before the department was added);
 *   - an individual task counts only participants registered before it started;
 *   - late = submitted after the inject's original time; a draft that was never
 *     submitted is "draft captured, not submitted";
 *   - no person's name next to an answer or a note (names only in the
 *     participants list, Section 3 of the report).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PPRecord = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const FORMAT = "planproof-exercise-record/1";
  const TOPIC = { general: "General (to classify)", decision: "Decision-making & escalation", communication: "Communication",
    plan: "Plan adherence", roles: "Roles & responsibility clarity", coordination: "Coordination between teams", other: "Other" };
  const TYPE = { positive: "Positive", improvement: "Needs improvement", critical: "Critical gap" };
  const TYPE_SCORE = { positive: "Performed", improvement: "Some challenges", critical: "Major challenges or Not performed (judge from the evidence)" };

  const same = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
  const pad2 = (n) => String(n).padStart(2, "0");

  // UAE time, written the same way on every computer: "24 Oct 2026, 15:00".
  function uae(iso) {
    if (!iso) return "—";
    const d = new Date(new Date(iso).getTime() + 4 * 3600 * 1000);
    const m = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
    return `${d.getUTCDate()} ${m} ${d.getUTCFullYear()}, ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  }
  function uaeTime(iso) { return iso ? uae(iso).split(", ")[1] : "—"; }
  function minutesBetween(a, b) { return Math.round((Date.parse(b) - Date.parse(a)) / 60000); }
  function duration(mins) {
    if (mins == null || isNaN(mins)) return "—";
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? `${h} h ${pad2(m)} min` : `${m} min`;
  }

  function scenario(rec) { return (rec.session && rec.session.scenario) || {}; }
  function injects(rec) { const i = scenario(rec).injects; return Array.isArray(i) ? i : []; }
  function injectStart(rec, idx) {
    const log = (rec.session && rec.session.inject_started_log) || {};
    return log[String(idx)] || null;
  }
  function playedIndexes(rec) {
    return injects(rec).map((_, i) => i).filter((i) => injectStart(rec, i));
  }
  function participants(rec) { return (rec.attendees || []).filter((a) => a.role === "participant"); }
  function observers(rec) { return (rec.attendees || []).filter((a) => a.role === "observer"); }

  // The exercise's departments: the scenario's, the facilitator's additions,
  // and any a participant registered under. Observers' own departments are not
  // exercise departments.
  function departments(rec) {
    const sc = scenario(rec);
    const list = [...(sc.departments || sc.requiredDepartments || []), ...((rec.session && rec.session.extra_departments) || []),
      ...participants(rec).map((a) => a.department)];
    const seen = new Set();
    return list.filter((d) => {
      const k = String(d || "").trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k); return true;
    });
  }
  function responsibleList(inj) {
    const r = inj && (inj.responsible != null ? inj.responsible : inj.team);
    if (!r || (Array.isArray(r) && !r.length)) return ["All"];
    return Array.isArray(r) ? r : [r];
  }
  function outputType(inj) { return inj && inj.output === "individual" ? "individual" : "group"; }
  function taskText(inj) {
    const t = inj && inj.task;
    if (!t) return "";
    if (typeof t === "string") return t;
    const text = t.text || t.label || "";
    return t.type ? `${t.type} — ${text}` : text;
  }
  function addedLateAt(rec, dept) {
    const late = (rec.session && rec.session.departments_added_late) || {};
    const k = Object.keys(late).find((d) => same(d, dept));
    return k ? late[k] : null;
  }
  // The late-department rule (Ahmed, 11 October 2026).
  function missedInject(rec, dept, idx) {
    const added = addedLateAt(rec, dept), start = injectStart(rec, idx);
    return !!(added && start && Date.parse(start) <= Date.parse(added));
  }
  function isResponsible(rec, inj, dept, idx) {
    if (missedInject(rec, dept, idx)) return false;
    const list = responsibleList(inj).map((d) => String(d).trim().toLowerCase());
    return list.includes("all") || list.includes(String(dept || "").trim().toLowerCase());
  }
  const hasContent = (s) => !!(s && ((s.answer_text && s.answer_text.trim()) || (s.attachments && s.attachments.length)));

  // Status of one department for one inject, as the report reads it.
  function departmentStatus(rec, idx, dept) {
    const inj = injects(rec)[idx] || {};
    const subs = (rec.submissions || []).filter((s) => s.inject_index === idx && same(s.department, dept));
    if (!isResponsible(rec, inj, dept, idx)) {
      const input = subs.some((s) => s.status === "submitted" || hasContent(s));
      const late = missedInject(rec, dept, idx);
      return { code: late ? (input ? "not_required_late_input" : "not_required_late") : (input ? "input_not_required" : "not_required"),
        label: late ? (input ? "Not required (added after this inject started) — input received" : "Not required — added after this inject started")
          : (input ? "Not required — input received" : "Not required"), required: false };
    }
    if (outputType(inj) === "group") {
      const row = subs.find((s) => !s.individual);
      if (row && row.status === "submitted") {
        return row.on_time
          ? { code: "on_time", label: `Submitted on time (${uaeTime(row.submitted_at)})`, required: true }
          : { code: "late", label: `Submitted after the time (${uaeTime(row.submitted_at)})`, required: true };
      }
      return hasContent(row) ? { code: "draft", label: "Draft captured, not submitted", required: true }
        : { code: "none", label: "No response", required: true };
    }
    const start = injectStart(rec, idx);
    const eligible = participants(rec).filter((a) => same(a.department, dept) && (!start || Date.parse(a.joined_at) <= Date.parse(start)));
    const later = participants(rec).filter((a) => same(a.department, dept) && start && Date.parse(a.joined_at) > Date.parse(start)).length;
    const ids = new Set(eligible.map((a) => a.id));
    const mine = subs.filter((s) => s.individual && ids.has(s.attendee_id));
    const onTime = mine.filter((s) => s.status === "submitted" && s.on_time).length;
    const late = mine.filter((s) => s.status === "submitted" && !s.on_time).length;
    const drafts = mine.filter((s) => s.status !== "submitted" && hasContent(s)).length;
    const n = eligible.length;
    if (!n) return { code: "no_participants", label: "No participant registered before this inject started", required: true, n: 0 };
    const parts = [`${onTime} of ${n} submitted on time`];
    if (late) parts.push(`${late} after the time`);
    if (drafts) parts.push(`${drafts} draft${drafts === 1 ? "" : "s"} not submitted`);
    const none = n - onTime - late - drafts;
    if (none > 0) parts.push(`${none} no response`);
    if (later) parts.push(`${later} joined after it started (not counted)`);
    return { code: onTime === n ? "all_on_time" : "individual", label: parts.join("; "), required: true, n, onTime, late, drafts, none };
  }

  function fileBase(rec) {
    const no = rec.request && rec.request.request_no;
    return no ? no : "unlinked-" + String((rec.session && rec.session.id) || "").slice(0, 8);
  }
  function safeName(s) {
    return String(s || "file").normalize("NFKC").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";
  }

  // Where each attachment goes in the zip. Unique names; the storage path is kept for the download.
  function attachmentEntries(rec) {
    const used = new Set(), out = [];
    for (const s of rec.submissions || []) {
      for (const a of s.attachments || []) {
        if (!a || !a.path) continue;
        const folder = `attachments/inject-${pad2(s.inject_index + 1)}/${safeName(s.department)}${s.individual ? "/individual" : ""}`;
        let name = safeName(a.filename || a.path.split("/").pop()), candidate = `${folder}/${name}`, n = 2;
        while (used.has(candidate.toLowerCase())) {
          const dot = name.lastIndexOf(".");
          candidate = `${folder}/${dot > 0 ? name.slice(0, dot) + ` (${n})` + name.slice(dot) : name + ` (${n})`}`; n++;
        }
        used.add(candidate.toLowerCase());
        out.push({ path: a.path, zipName: candidate, size: a.size || null, submission: s });
      }
    }
    return out;
  }

  function line(ch, n) { return ch.repeat(n || 72); }
  function wrapBlock(text, indent) {
    const pre = " ".repeat(indent || 4);
    return String(text || "").replace(/\r\n?/g, "\n").split("\n").map((l) => pre + l).join("\n");
  }
  function pct(part, total) { return total ? Math.round((part * 100) / total) + "%" : "—"; }

  // Warnings that must be read before the report is written.
  function warnings(rec) {
    const w = [], r = rec.readiness || {}, sv = rec.survey || {};
    if (r.notes_open) w.push(`Notes were still open when this was exported (they close ${uae(r.notes_open_until)}). A note written later is NOT in this record.`);
    if (sv.open || r.survey_open) w.push(`The feedback survey was still open (it closes ${uae(r.survey_open_until)}). Later answers are NOT in this record.`);
    if (!rec.request) w.push("This exercise is not linked to a request on the admin page, so the request number and client reference are missing.");
    else if (!(rec.client && rec.client.client_ref)) w.push("The client has no client reference (PP-…) yet — issue it on the admin page before the report is delivered.");
    const notPlayed = injects(rec).length - playedIndexes(rec).length;
    if (notPlayed > 0) w.push(`${notPlayed} inject${notPlayed === 1 ? " was" : "s were"} not played (listed in section 2).`);
    return w;
  }

  function buildText(rec, opts) {
    const o = opts || {};
    const S = rec.session || {}, sc = scenario(rec), req = rec.request || null, cl = rec.client || null;
    const out = [];
    const push = (...l) => out.push(...l);
    const played = playedIndexes(rec);
    const depts = departments(rec);
    const parts = participants(rec), obs = observers(rec);
    const att = attachmentEntries(rec);
    const att2 = new Map(att.map((a) => [a.path, a.zipName]));

    push("PLANPROOF EXERCISE RECORD", FORMAT, line("="));
    push(`Request number:      ${req ? req.request_no : "(not linked to a request)"}`);
    push(`Client reference:    ${cl && cl.client_ref ? cl.client_ref : "(none yet)"}`);
    push(`Organisation:        ${cl ? cl.company_name + (cl.business_unit ? " — " + cl.business_unit : "") : "(not linked)"}`);
    push(`Exercise history:    ${cl ? (cl.history_opt_out ? "client opted OUT — after delivery also delete the scenario files (all -v<N> copies) and section G" : "client opted in — keep the history record") : "(unknown)"}`);
    push(`Exercise:            ${S.label || ""}${sc.label && sc.label !== S.label ? " — scenario: " + sc.label : ""}`);
    push(`Exercise language:   ${S.language === "ar" ? "Arabic" : "English"} (the report is always in English and Arabic)`);
    push(`Started (UAE):       ${uae(S.started_at)}`);
    push(`Ended (UAE):         ${uae(S.ended_at)}`);
    push(`Duration:            ${S.started_at && S.ended_at ? duration(minutesBetween(S.started_at, S.ended_at)) : "—"} (from the first inject to End, including any pause or break)`);
    push(`Rooms:               ${S.room_count || 1}`);
    push(`Run:                 ${S.run_number} (earlier runs and trial runs are left out)`);
    push(`Exported (UAE):      ${uae(o.exportedAt || rec.generated_at)}`);
    push(`Notes:               ${rec.readiness && rec.readiness.notes_complete ? "closed (\"Notes complete\" pressed)" : rec.readiness && rec.readiness.notes_open ? "STILL OPEN" : "closed (48 hours after End)"}`);
    push(`Feedback survey:     ${(rec.survey && rec.survey.open) ? "STILL OPEN" : "closed (48 hours after End)"}`);
    const w = warnings(rec);
    if (w.length) { push("", "WARNINGS"); w.forEach((x) => push("  ! " + x)); }
    push("");

    // 1. Participants (report Section 3). Names appear here and nowhere else.
    push(line("="), "1. PARTICIPANTS (report Section 3 — names and job titles appear ONLY here)", line("="));
    push(`${parts.length} participant${parts.length === 1 ? "" : "s"} (${parts.filter((a) => !a.remote).length} in a room, ${parts.filter((a) => a.remote).length} joining alone, remotely); ${obs.length} Observer${obs.length === 1 ? "" : "s"}.`);
    push("Department | Name | Job title | Room / location");
    for (const d of depts) {
      for (const a of parts.filter((p) => same(p.department, d))) {
        push(`${d} | ${a.first_name || ""} ${a.family_name || ""}`.trim() + ` | ${a.job_title || ""} | ${a.remote ? "Remote" : a.room ? "Room " + a.room : "Main room"}`);
      }
    }
    if (obs.length) {
      push("", "Observers (list them with the facilitation team): Name | Job title | Own department | Room");
      obs.forEach((a) => push(`${a.first_name || ""} ${a.family_name || ""}`.trim() + ` | ${a.job_title || ""} | ${a.department || ""} | ${a.room ? "Room " + a.room : "Main room"}`));
    }
    if (parts.some((a) => a.remote)) push("", "Some participants joined alone, remotely: use the template's hybridLimitationNote in Limitations.");
    const lateDepts = Object.keys((S.departments_added_late) || {});
    if (lateDepts.length) push("", `Added during the exercise: ${lateDepts.map((d) => `${d} (at ${uaeTime(S.departments_added_late[d])})`).join(", ")} — not required for injects that had already started.`);
    push("");

    // 2. Injects and responses.
    push(line("="), "2. INJECTS AND RESPONSES", line("="));
    push("Status words: Submitted on time / Submitted after the time (late = after the inject's ORIGINAL time; extra minutes only kept forms open) /");
    push("Draft captured, not submitted / No response / Not required. Individual tasks: team totals only, never names.", "");
    injects(rec).forEach((inj, idx) => {
      const start = injectStart(rec, idx);
      push(line("-"), `INJECT ${idx + 1} of ${injects(rec).length} — ${inj.title || "(untitled)"}`);
      if (!start) { push("  NOT PLAYED (the exercise ended before it)."); return; }
      const resp = responsibleList(inj);
      push(`  Started ${uaeTime(start)} · ${inj.durationMinutes ? inj.durationMinutes + " min" : "no time limit"} · ${outputType(inj) === "group" ? "group answer (one per department)" : "individual answers (awareness check)"} · responsible: ${resp.some((x) => String(x).toLowerCase() === "all") ? "all departments" : resp.join(", ")}${inj.phase ? " · phase: " + inj.phase : ""}`);
      if (inj.desc) push("  Inject:", wrapBlock(inj.desc, 4));
      const t = taskText(inj);
      if (t) push("  Task: " + t);
      push("  Status:");
      depts.forEach((d) => push(`    - ${d}: ${departmentStatus(rec, idx, d).label}`));
      const subs = (rec.submissions || []).filter((s) => s.inject_index === idx && hasContent(s));
      if (subs.length) push("  Answers:");
      depts.forEach((d) => {
        const st = departmentStatus(rec, idx, d);
        const mine = subs.filter((s) => same(s.department, d));
        if (outputType(inj) === "group") {
          const row = mine.find((s) => !s.individual);
          if (!row) return;
          push(`    [${d} — ${st.label}]`);
          push(wrapBlock(row.answer_text || "(no text)", 6));
          (row.attachments || []).forEach((a) => push(`      Attachment: ${att2.get(a.path) || a.filename}`));
        } else {
          mine.filter((s) => s.individual).forEach((row, k) => {
            const who = participants(rec).find((a) => a.id === row.attendee_id);
            const counted = who && (!start || Date.parse(who.joined_at) <= Date.parse(start));
            const when = (row.status === "submitted" ? (row.on_time ? "on time" : "after the time") : "draft, not submitted") + (counted ? "" : "; joined after it started — not counted");
            push(`    [${d} — individual answer ${k + 1} (${when})]`);
            push(wrapBlock(row.answer_text || "(no text)", 6));
            (row.attachments || []).forEach((a) => push(`      Attachment: ${att2.get(a.path) || a.filename}`));
          });
        }
      });
      const reqs = (rec.more_time_requests || []).filter((m) => m.inject_index === idx);
      if (reqs.length) push("  More time asked: " + reqs.map((m) => `${m.from === "observer" ? "Room " + m.room + " Observers" : m.department} at ${uaeTime(m.at)}`).join("; "));
      const n = (rec.notes || []).filter((x) => x.inject_index === idx).length;
      if (n) push(`  Notes on this inject: ${n} (section 3)`);
    });
    push("");

    // 3. Notes.
    const notes = rec.notes || [];
    push(line("="), "3. OBSERVER AND FACILITATOR NOTES (raw evidence for findings — never name a person)", line("="));
    push("Note type → scoring level: Positive → Performed · Needs improvement → Some challenges · Critical gap → Major challenges or Not performed.");
    push('Topic "General (to classify)": the writer left the topic open; classify it when writing the report.');
    const lo = rec.left_out || {};
    push(`Left out: ${lo.withdrawn_notes || 0} withdrawn note(s); ${lo.earlier_run_notes || 0} note(s) from earlier or trial runs.`);
    const counts = { positive: 0, improvement: 0, critical: 0 };
    notes.forEach((n) => { if (counts[n.note_type] != null) counts[n.note_type]++; });
    push(`Totals: ${notes.length} note(s) — ${counts.critical} Critical gap, ${counts.improvement} Needs improvement, ${counts.positive} Positive.`, "");
    const groups = [...played.map((i) => [i, notes.filter((n) => n.inject_index === i)]), [null, notes.filter((n) => n.inject_index == null)]];
    groups.forEach(([i, list]) => {
      if (!list.length) return;
      push(i == null ? "Whole exercise" : `Inject ${i + 1} — ${(injects(rec)[i] || {}).title || ""}`);
      list.forEach((n) => {
        const about = n.department_scope === "external" ? `external party: ${n.external_party || ""}` : (n.departments || []).join(", ") || "—";
        const topic = n.topic === "other" ? `Other: ${n.topic_other || ""}` : (TOPIC[n.topic] || n.topic);
        push(`  [${TYPE[n.note_type] || n.note_type}] ${topic} · about: ${about} · by: ${n.author_role === "facilitator" ? "Facilitator" : n.room ? "Observer, Room " + n.room : "Observer"} · ${uaeTime(n.updated_at || n.created_at)}`);
        push(wrapBlock(n.body, 6));
      });
      push("");
    });
    if (!notes.length) push("No notes.", "");

    // 4. More time.
    push(line("="), "4. REQUESTS FOR MORE TIME (recorded, not scored; extra time was always for everyone)", line("="));
    const mt = rec.more_time_requests || [];
    if (!mt.length) push("None.");
    mt.forEach((m) => push(`- ${m.from === "observer" ? "Room " + m.room + " Observers" : m.department} asked for more time on inject ${m.inject_index + 1} at ${uaeTime(m.at)}`));
    push("");

    // 5. Survey.
    const sv = rec.survey || {};
    const R = sv.responses || 0, reg = sv.registered || 0;
    push(line("="), "5. FEEDBACK SURVEY (anonymous — role only)", line("="));
    push(`Answered: ${R} of ${reg} registered (${pct(R, reg)}) — participants ${(sv.by_role || {}).participant || 0} of ${sv.registered_participants || 0}, Observers ${(sv.by_role || {}).observer || 0} of ${sv.registered_observers || 0}.`);
    if (sv.open) push("! The survey was still open at export.");
    push("", 'A. FOR THE REPORT — "How participants experienced the exercise" box (exercise-conduct section; option A):');
    if (!R) push("   No answers — leave the box out and say so in one line.");
    else {
      const d = sv.duration || {}, tp = sv.tech_problem || {};
      push(`   Realistic: ${(sv.realistic || {}).agree_pct ?? "—"}% agree`);
      push(`   Felt the pressure of a real incident: ${(sv.pressure || {}).agree_pct ?? "—"}% agree`);
      push(`   Understood their role in the plan: ${(sv.role_understanding || {}).agree_pct ?? "—"}% agree`);
      push(`   Length: about right ${pct(d.about_right || 0, R)}, too short ${pct(d.too_short || 0, R)}, too long ${pct(d.too_long || 0, R)}`);
      push(`   Screens easy to use: ${(sv.screens_easy || {}).agree_pct ?? "—"}% agree`);
      push(`   Technical problems: ${(tp.small || 0) + (tp.in_the_way || 0)} of ${R} (${tp.small || 0} small, ${tp.in_the_way || 0} got in the way)`);
    }
    push("", "B. INTERNAL — PlanProof only. NEVER in the report, never quoted:");
    if (R) {
      const ov = sv.overall || {}, rc = sv.recommend || {};
      push(`   Overall rating: ${ov.avg ?? "—"} of 5 (5★ ${(ov.distribution || {})["5"] || 0}, 4★ ${(ov.distribution || {})["4"] || 0}, 3★ ${(ov.distribution || {})["3"] || 0}, 2★ ${(ov.distribution || {})["2"] || 0}, 1★ ${(ov.distribution || {})["1"] || 0})`);
      push(`   Would recommend (0–10): average ${rc.avg ?? "—"}; NPS ${rc.nps ?? "—"} (${rc.promoters || 0} promoters, ${rc.passives || 0} passives, ${rc.detractors || 0} detractors)`);
      const cm = sv.comments || [];
      push(`   Comments (${cm.length}, shuffled):`);
      cm.forEach((c) => push(`   - (${c.role}) ${String(c.text || "").replace(/\s+/g, " ")}`));
    }
    push("");

    // 6. Attachments and what was left out.
    push(line("="), "6. ATTACHMENTS IN THIS ZIP", line("="));
    if (!att.length) push("None.");
    att.forEach((a) => push(`- ${a.zipName}${a.size ? " (" + Math.round(a.size / 1024) + " KB)" : ""} — inject ${a.submission.inject_index + 1}, ${a.submission.department}`));
    push("");
    push(line("="), "7. NOT IN THIS RECORD, ON PURPOSE", line("="));
    push(`- Answers from earlier runs and trial runs (${lo.earlier_run_answers || 0}, of which ${lo.trial_run_answers || 0} trial).`);
    push("- Withdrawn notes; notes from earlier runs; who wrote each note (by name).");
    push("- Messages (operational traffic), except the requests for more time in section 4.");
    push("- \"Who is writing\" names, expected attendance, online status.");
    push("", "After the report is delivered: mark the request \"Delivered\" on the admin page. The player data is removed 7 days later.");
    push("Delete this zip (and any copy) once the report is final. Never save it in OneDrive.");
    return out.join("\n") + "\n";
  }

  function manifestText(rec, files, exportedAt) {
    const lines = ["PLANPROOF EXERCISE RECORD — MANIFEST", FORMAT,
      `Request: ${(rec.request && rec.request.request_no) || "(not linked)"}`,
      `Exercise: ${(rec.session && rec.session.label) || ""} (session ${(rec.session && rec.session.id) || ""}, run ${(rec.session && rec.session.run_number) || ""})`,
      `Exported (UAE): ${uae(exportedAt || rec.generated_at)}`, "",
      "SHA-256  bytes  file"];
    files.forEach((f) => lines.push(`${f.sha256}  ${f.size}  ${f.name}`));
    lines.push("", `${files.length} file(s). Each fingerprint was checked by reopening the zip before it was saved.`);
    return lines.join("\n") + "\n";
  }

  // Counts kept in the export log (no names, no answers).
  function counts(rec) {
    return {
      participants: participants(rec).length, observers: observers(rec).length,
      injects_played: playedIndexes(rec).length, injects_total: injects(rec).length,
      answers: (rec.submissions || []).length, notes: (rec.notes || []).length,
      attachments: attachmentEntries(rec).length, survey_responses: (rec.survey && rec.survey.responses) || 0,
      run: rec.session && rec.session.run_number,
    };
  }

  return { FORMAT, uae, departments, departmentStatus, isResponsible, missedInject, playedIndexes, attachmentEntries,
    buildText, manifestText, counts, warnings, fileBase, safeName, TYPE_SCORE };
});
