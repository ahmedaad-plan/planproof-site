// Observer notes form (roadmap item 5, built 11 October 2026).
// One form, used in two places:
//   - room-display.html in Observer mode (an Observer's phone), and
//   - facilitator-test.html (the Facilitator's own notes, same options).
// Design: design-notes.md → "Observer notes". Needs shared.js first.
//
// What it guarantees on the device (the database checks everything again):
//   - the note keeps the inject the writer was watching when they STARTED it,
//     even if the Facilitator presses Next while they type;
//   - an unfinished note is kept on the device (reload, flat battery, WiFi
//     drop) and comes back when the page is reopened;
//   - the note's id is made on the device when the note is started, so Log
//     pressed twice or a retried send saves it once;
//   - departments come only from the session's list (never typed); the only
//     free typing is "External party" (who) and the topic "Other".

(function () {
  const CSS = `
  .ppn { background:#fff; color:#0b1f3a; border-radius:12px; padding:14px 16px; text-align:left;
    font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; font-size:15px; line-height:1.4; }
  .ppn [hidden] { display:none !important; }
  .ppn fieldset { border:0; margin:0; padding:0; min-width:0; }
  .ppn fieldset:disabled .ppn-field, .ppn fieldset:disabled .ppn-row { opacity:.5; }
  .ppn-window { font-size:.9rem; background:#fff3d6; border:1px solid #e8a33d; border-radius:8px; padding:8px 10px; }
  .ppn-window.closed { background:#f1f1f1; border-color:#c9ced6; }
  .ppn-field { margin-top:12px; }
  .ppn-label { font-weight:700; font-size:.85rem; margin:0 0 6px; display:block; }
  .ppn-inject { font-size:.95rem; }
  .ppn-inject small { opacity:.65; }
  .ppn-moved { font-size:.82rem; color:#7a4f00; margin-top:4px; }
  .ppn-chips { display:flex; flex-wrap:wrap; gap:6px; }
  .ppn-chip { font:inherit; font-size:.88rem; padding:8px 12px; min-height:40px; border-radius:999px;
    border:1px solid #9aa6b5; background:#fff; color:#0b1f3a; cursor:pointer; }
  .ppn-chip[aria-checked="true"] { background:#0b1f3a; color:#fff; border-color:#0b1f3a; }
  .ppn-type-positive[aria-checked="true"] { background:#1e7a3c; border-color:#1e7a3c; }
  .ppn-type-improvement[aria-checked="true"] { background:#a8650a; border-color:#a8650a; }
  .ppn-type-critical[aria-checked="true"] { background:#b0261b; border-color:#b0261b; }
  .ppn select, .ppn input[type=text], .ppn textarea { width:100%; box-sizing:border-box; padding:10px;
    border-radius:8px; border:1px solid #b9c0ca; font:inherit; font-size:16px; background:#fff; color:#0b1f3a; }
  .ppn input[type=text] { margin-top:8px; }
  .ppn textarea { min-height:84px; resize:vertical; }
  .ppn-checks { margin-top:8px; border:1px solid #e1e4e8; border-radius:8px; padding:4px 10px; }
  .ppn-checks label { display:flex; gap:10px; align-items:center; padding:7px 0; font-size:.95rem; }
  .ppn-checks input { width:20px; height:20px; }
  .ppn-hint { font-size:.8rem; opacity:.72; margin-top:4px; }
  .ppn-row { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-top:10px; }
  .ppn-count { font-size:.8rem; opacity:.6; }
  .ppn-log { background:#0b1f3a; color:#fff; border:0; border-radius:8px; padding:12px 22px; font-weight:700;
    font-size:1rem; cursor:pointer; min-height:44px; }
  .ppn-log:disabled { opacity:.45; cursor:not-allowed; }
  .ppn-feedback { min-height:1.2em; font-size:.88rem; margin-top:8px; }
  .ppn-feedback.ok { color:#1e5c28; }
  .ppn-feedback.err { color:#b00020; }
  .ppn-editing { background:#e8f0fb; border-radius:8px; padding:8px 10px; font-size:.88rem; margin-top:10px; }
  .ppn-link { background:none; border:0; color:#0b4a9e; text-decoration:underline; cursor:pointer; font:inherit; padding:0; }
  .ppn-item { border-top:1px solid #eceef1; padding:9px 0; font-size:.92rem; overflow-wrap:anywhere; }
  .ppn-item:first-child { border-top:none; }
  .ppn-item .meta { font-size:.8rem; opacity:.7; display:block; }
  .ppn-pill { display:inline-block; padding:1px 8px; border-radius:999px; font-size:.75rem; font-weight:700; color:#fff; margin-right:6px; }
  .ppn-pill.positive { background:#1e7a3c; } .ppn-pill.improvement { background:#a8650a; } .ppn-pill.critical { background:#b0261b; }
  .ppn-pill.earlier { background:#6b7380; }
  .ppn-actions { margin-top:4px; display:flex; gap:12px; flex-wrap:wrap; }
  .ppn-actions button { font:inherit; font-size:.82rem; background:none; border:0; padding:4px 0; cursor:pointer; text-decoration:underline; color:#0b4a9e; }
  .ppn-actions button.danger { color:#b00020; }
  `;

  function injectCss() {
    if (document.getElementById("ppn-css")) return;
    const style = document.createElement("style");
    style.id = "ppn-css";
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function esc(str) {
    return String(str === null || str === undefined ? "" : str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  function injectTitle(row, idx) {
    const injects = (row && row.scenario && row.scenario.injects) || [];
    const inj = injects[idx];
    return inj ? inj.title : "";
  }

  function injectLabel(row, idx) {
    if (idx === null) return "Whole exercise";
    const t = injectTitle(row, idx);
    return t ? `Inject ${idx} — ${t}` : `Inject ${idx}`;
  }

  function formatTime(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function formatDateTime(ms) {
    const d = new Date(ms);
    return d.toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  const SEVERAL = "__several__";
  const EXTERNAL = "__external__";

  // opts: { role: "observer"|"facilitator", draftKey, getRow(), save(payload) -> Promise,
  //         onSaved(result, payload, wasEditing)? }
  function createNoteForm(root, opts) {
    injectCss();
    const uid = Math.random().toString(36).slice(2, 8);
    root.classList.add("ppn");
    root.innerHTML = `
      <div class="ppn-window" data-el="window" hidden></div>
      <fieldset data-el="fields">
        <div class="ppn-editing" data-el="editing" hidden>
          Editing a note you logged earlier ·
          <button type="button" class="ppn-link" data-el="cancelEdit">Cancel editing</button>
        </div>
        <div class="ppn-field">
          <span class="ppn-label" id="ppn-inj-${uid}">Inject</span>
          <div class="ppn-inject" data-el="injectFixed"></div>
          <select data-el="injectSelect" aria-labelledby="ppn-inj-${uid}" hidden></select>
          <div class="ppn-moved" data-el="moved" hidden>
            The facilitator has moved on — this note stays with the inject you started it on.
          </div>
        </div>
        <div class="ppn-field">
          <span class="ppn-label" id="ppn-topic-${uid}">Topic</span>
          <div class="ppn-chips" role="radiogroup" aria-labelledby="ppn-topic-${uid}" data-el="topics">
            ${NOTE_TOPICS.map((t) => `<button type="button" role="radio" aria-checked="false" class="ppn-chip" data-topic="${t.key}">${esc(t.label)}</button>`).join("")}
          </div>
          <input type="text" data-el="topicOther" maxlength="${NOTE_TOPIC_OTHER_MAX}" placeholder="Type the topic" aria-label="Topic (other)" hidden />
        </div>
        <div class="ppn-field">
          <span class="ppn-label" id="ppn-type-${uid}">Type</span>
          <div class="ppn-chips" role="radiogroup" aria-labelledby="ppn-type-${uid}" data-el="types">
            ${NOTE_TYPES.map((t) => `<button type="button" role="radio" aria-checked="false" class="ppn-chip ppn-type-${t.key}" data-type="${t.key}">${esc(t.label)}</button>`).join("")}
          </div>
        </div>
        <div class="ppn-field">
          <label class="ppn-label" for="ppn-dept-${uid}">Department the note is about</label>
          <select id="ppn-dept-${uid}" data-el="dept"></select>
          <div class="ppn-checks" data-el="checks" hidden></div>
          <input type="text" data-el="external" maxlength="${NOTE_EXTERNAL_MAX}" placeholder="Who? For example Civil Defence or Police" aria-label="External party" hidden />
        </div>
        <div class="ppn-field">
          <label class="ppn-label" for="ppn-body-${uid}">Note</label>
          <textarea id="ppn-body-${uid}" data-el="body" maxlength="${NOTE_MAX_LENGTH}" placeholder="What did the team do, and what does the plan say?"></textarea>
          <div class="ppn-hint">Describe what the team did and what the plan says, not individuals.</div>
        </div>
        <div class="ppn-row">
          <span class="ppn-count" data-el="count">0 / ${NOTE_MAX_LENGTH}</span>
          <button type="button" class="ppn-log" data-el="log">Log note</button>
        </div>
      </fieldset>
      <div class="ppn-feedback" role="status" aria-live="polite" data-el="feedback"></div>`;

    const el = (name) => root.querySelector(`[data-el="${name}"]`);
    const E = {
      window: el("window"), fields: el("fields"), editing: el("editing"), cancelEdit: el("cancelEdit"),
      injectFixed: el("injectFixed"), injectSelect: el("injectSelect"), moved: el("moved"),
      topics: el("topics"), topicOther: el("topicOther"), types: el("types"),
      dept: el("dept"), checks: el("checks"), external: el("external"),
      body: el("body"), count: el("count"), log: el("log"), feedback: el("feedback"),
    };

    function blank() {
      return {
        id: crypto.randomUUID(),
        editing: false,
        // undefined = not chosen yet (follows what's showing); null = whole exercise
        injectIndex: undefined,
        topic: null, topicOther: "", noteType: null,
        scope: "", dept: "", depts: [], externalParty: "",
        body: "", touched: false, runNumber: null,
      };
    }

    let state = blank();
    try {
      const saved = JSON.parse(localStorage.getItem(opts.draftKey) || "null");
      if (saved && saved.id) state = Object.assign(blank(), saved);
    } catch { /* storage unavailable — start blank */ }
    let saving = false;
    let lastRow = null;
    let deptSignature = "";

    function persist() {
      try {
        if (state.touched) localStorage.setItem(opts.draftKey, JSON.stringify(state));
        else localStorage.removeItem(opts.draftKey);
      } catch { /* storage blocked — the form still works for this page */ }
    }

    // First real input on a fresh note: lock in the inject being watched now.
    function touch() {
      const row = opts.getRow();
      if (!state.touched) {
        state.touched = true;
        state.runNumber = row ? row.run_number : null;
      }
      if (state.injectIndex === undefined && row && row.status === "running") {
        state.injectIndex = row.current_inject_index;
      }
      E.feedback.textContent = "";
      E.feedback.className = "ppn-feedback";
    }

    function departments() {
      return sessionDepartments(opts.getRow());
    }

    function rebuildDeptOptions(force) {
      const depts = departments();
      const sig = depts.join("\u0001");
      if (!force && sig === deptSignature) return;
      deptSignature = sig;
      E.dept.innerHTML =
        `<option value="">— Choose —</option>` +
        depts.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join("") +
        `<option disabled>──────────</option>` +
        `<option value="${SEVERAL}">Several departments</option>` +
        `<option value="${EXTERNAL}">External party</option>`;
      E.checks.innerHTML = depts
        .map((d) => `<label><input type="checkbox" value="${esc(d)}" /> ${esc(d)}</label>`)
        .join("");
      syncDept();
    }

    function syncDept() {
      if (state.scope === "several") E.dept.value = SEVERAL;
      else if (state.scope === "external") E.dept.value = EXTERNAL;
      else if (state.scope === "one" && departments().includes(state.dept)) E.dept.value = state.dept;
      else E.dept.value = "";
      E.checks.hidden = state.scope !== "several";
      E.checks.querySelectorAll("input").forEach((cb) => (cb.checked = state.depts.includes(cb.value)));
      E.external.hidden = state.scope !== "external";
      if (E.external.value !== state.externalParty) E.external.value = state.externalParty;
    }

    // A fresh (untouched) note pre-selects the department when the inject
    // names exactly one responsible department.
    function applyDefaultDept(row) {
      if (state.touched || !row || row.status !== "running") return;
      const injects = (row.scenario && row.scenario.injects) || [];
      const inj = injects[row.current_inject_index];
      const resp = injResponsibleList(inj);
      const depts = departments();
      if (resp.length === 1 && depts.includes(resp[0])) {
        state.scope = "one";
        state.dept = resp[0];
      } else {
        state.scope = "";
        state.dept = "";
      }
      syncDept();
    }

    function injResponsibleList(inj) {
      if (!inj) return [];
      const list = injectResponsible(inj);
      return list.some((d) => String(d).toLowerCase() === "all") ? [] : list;
    }

    function renderFields() {
      E.topics.querySelectorAll("[data-topic]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.topic === state.topic)));
      E.topicOther.hidden = state.topic !== "other";
      if (E.topicOther.value !== state.topicOther) E.topicOther.value = state.topicOther;
      E.types.querySelectorAll("[data-type]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.type === state.noteType)));
      syncDept();
      if (E.body.value !== state.body) E.body.value = state.body;
      E.count.textContent = `${E.body.value.length} / ${NOTE_MAX_LENGTH}`;
      E.editing.hidden = !state.editing;
      E.log.textContent = saving ? "Saving…" : state.editing ? "Save changes" : "Log note";
    }

    function refresh() {
      const row = opts.getRow();
      if (!row) return;
      // A new run (after Reset): old "logged ✓" / error messages no longer apply.
      if (lastRow && lastRow.run_number !== row.run_number) {
        E.feedback.textContent = "";
        E.feedback.className = "ppn-feedback";
      }
      lastRow = row;
      // A draft from before a Reset belongs to an earlier run — it can't be saved any more.
      if (state.touched && state.runNumber !== null && row.run_number && state.runNumber !== row.run_number) {
        state = blank();
        persist();
        renderFields();
      }
      rebuildDeptOptions(false);

      const win = notesWindow(row, opts.role);
      E.fields.disabled = !win.open || saving;
      E.log.disabled = !win.open || saving;
      if (!win.open) {
        E.window.hidden = false;
        E.window.className = "ppn-window closed";
        E.window.textContent = win.reason;
      } else if (row.status === "ended") {
        E.window.hidden = false;
        E.window.className = "ppn-window";
        E.window.textContent = opts.role === "facilitator"
          ? `The exercise has ended. You can add notes until ${formatDateTime(win.closesAt)}, or until you press "Notes complete". Choose an inject or "Whole exercise".`
          : `The exercise has ended. You can add or edit notes until ${formatTime(win.closesAt)} (one hour after the end). Choose an inject or "Whole exercise".`;
      } else {
        E.window.hidden = true;
        E.window.textContent = "";
      }

      // The inject the note is about.
      if (row.status === "ended") {
        const played = playedInjects(row);
        const opts2 = [`<option value="whole">Whole exercise</option>`]
          .concat(played.map((i) => `<option value="${i}">${esc(injectLabel(row, i))}</option>`));
        const html = opts2.join("");
        if (E.injectSelect.dataset.sig !== html) {
          E.injectSelect.innerHTML = html;
          E.injectSelect.dataset.sig = html;
        }
        E.injectSelect.value = state.injectIndex === undefined || state.injectIndex === null
          ? "whole"
          : String(state.injectIndex);
        E.injectSelect.hidden = false;
        E.injectFixed.hidden = true;
        E.moved.hidden = true;
      } else if (row.status === "running") {
        E.injectSelect.hidden = true;
        E.injectFixed.hidden = false;
        const idx = state.injectIndex === undefined ? row.current_inject_index : state.injectIndex;
        E.injectFixed.innerHTML = `${esc(injectLabel(row, idx))} <small>· set automatically</small>`;
        E.moved.hidden = !(state.injectIndex !== undefined && state.injectIndex !== null
          && state.injectIndex !== row.current_inject_index);
        applyDefaultDept(row);
      } else {
        E.injectSelect.hidden = true;
        E.injectFixed.hidden = false;
        E.injectFixed.textContent = "—";
        E.moved.hidden = true;
      }
    }

    // ---- input handlers -------------------------------------------------
    E.topics.addEventListener("click", (e) => {
      const b = e.target.closest("[data-topic]");
      if (!b) return;
      touch();
      state.topic = b.dataset.topic;
      persist();
      renderFields();
      if (state.topic === "other") E.topicOther.focus();
    });
    E.topicOther.addEventListener("input", () => { touch(); state.topicOther = E.topicOther.value; persist(); });
    E.types.addEventListener("click", (e) => {
      const b = e.target.closest("[data-type]");
      if (!b) return;
      touch();
      state.noteType = b.dataset.type;
      persist();
      renderFields();
    });
    E.dept.addEventListener("change", () => {
      touch();
      const v = E.dept.value;
      if (v === SEVERAL) state.scope = "several";
      else if (v === EXTERNAL) state.scope = "external";
      else if (v) { state.scope = "one"; state.dept = v; }
      else { state.scope = ""; state.dept = ""; }
      persist();
      syncDept();
      if (state.scope === "external") E.external.focus();
    });
    E.checks.addEventListener("change", () => {
      touch();
      state.depts = Array.from(E.checks.querySelectorAll("input:checked")).map((cb) => cb.value);
      persist();
    });
    E.external.addEventListener("input", () => { touch(); state.externalParty = E.external.value; persist(); });
    E.body.addEventListener("input", () => {
      touch();
      state.body = E.body.value;
      E.count.textContent = `${E.body.value.length} / ${NOTE_MAX_LENGTH}`;
      persist();
    });
    E.injectSelect.addEventListener("change", () => {
      touch();
      state.injectIndex = E.injectSelect.value === "whole" ? null : Number(E.injectSelect.value);
      persist();
    });
    E.cancelEdit.addEventListener("click", () => {
      state = blank();
      persist();
      renderFields();
      refresh();
      E.feedback.textContent = "";
    });

    function fail(msg) {
      E.feedback.className = "ppn-feedback err";
      E.feedback.textContent = msg;
      return false;
    }

    function validate() {
      if (!state.topic) return fail("Please choose a topic.");
      if (state.topic === "other" && !state.topicOther.trim()) return fail("Please type the topic.");
      if (!state.noteType) return fail("Please choose a type: Positive, Needs improvement or Critical gap.");
      if (!state.scope) return fail("Please choose the department the note is about.");
      if (state.scope === "one" && !state.dept) return fail("Please choose the department the note is about.");
      if (state.scope === "several" && state.depts.length < 2) return fail("Please tick at least two departments.");
      if (state.scope === "external" && !state.externalParty.trim()) return fail("Please type who the external party is (for example Civil Defence or Police).");
      if (!state.body.trim()) return fail("Please write the note.");
      return true;
    }

    E.log.addEventListener("click", async () => {
      if (saving) return;
      const row = opts.getRow();
      if (!validate()) return;
      let injectIndex = state.injectIndex;
      if (injectIndex === undefined) {
        injectIndex = row && row.status === "running" ? row.current_inject_index : null;
      }
      const payload = {
        id: state.id,
        injectIndex,
        topic: state.topic,
        topicOther: state.topic === "other" ? state.topicOther.trim() : "",
        noteType: state.noteType,
        scope: state.scope,
        departments: state.scope === "one" ? [state.dept] : state.scope === "several" ? state.depts.slice() : [],
        externalParty: state.scope === "external" ? state.externalParty.trim() : "",
        body: state.body.trim(),
      };
      const wasEditing = state.editing;
      saving = true;
      renderFields();
      refresh();
      E.feedback.className = "ppn-feedback";
      E.feedback.textContent = "Saving…";
      try {
        const result = await opts.save(payload);
        state = blank();
        persist();
        E.feedback.className = "ppn-feedback ok";
        E.feedback.textContent = wasEditing ? "Changes saved ✓" : "Note logged ✓";
        if (opts.onSaved) opts.onSaved(result, payload, wasEditing);
      } catch (err) {
        // Keep everything typed, so nothing is lost; pressing again is safe
        // (same note id).
        E.feedback.className = "ppn-feedback err";
        E.feedback.textContent = err.message;
      } finally {
        saving = false;
        renderFields();
        refresh();
      }
    });

    renderFields();
    refresh();

    return {
      refresh,
      // Load one of the writer's own notes back into the form to change it.
      edit(note) {
        state = Object.assign(blank(), {
          id: note.id,
          editing: true,
          injectIndex: note.injectIndex === undefined ? null : note.injectIndex,
          topic: note.topic,
          topicOther: note.topicOther || "",
          noteType: note.noteType,
          scope: note.scope,
          dept: note.scope === "one" ? (note.departments || [])[0] || "" : "",
          depts: note.scope === "several" ? (note.departments || []).slice() : [],
          externalParty: note.externalParty || "",
          body: note.body || "",
          touched: true,
          runNumber: note.runNumber === undefined ? null : note.runNumber,
        });
        persist();
        renderFields();
        refresh();
        E.feedback.textContent = "";
        root.scrollIntoView({ behavior: "smooth", block: "start" });
        E.body.focus();
      },
      get editingId() { return state.editing ? state.id : null; },
      cancelEditIf(id) {
        if (state.editing && state.id === id) {
          state = blank();
          persist();
          renderFields();
          refresh();
        }
      },
    };
  }

  // One note as a list item. note uses the database's field names
  // (topic, topic_other, note_type, department_scope, departments,
  // external_party, body, inject_index, run_number, author_*, created_at).
  function noteItemHtml(note, { row, showAuthor, actionsHtml, unread } = {}) {
    const earlier = row && note.run_number && row.run_number && note.run_number !== row.run_number;
    const time = note.created_at ? formatTime(Date.parse(note.created_at)) : "";
    const edited = note.updated_at && note.created_at && Date.parse(note.updated_at) - Date.parse(note.created_at) > 2000;
    const author = showAuthor
      ? note.author_role === "facilitator"
        ? "Facilitator"
        : `${note.author_name}${note.author_department ? ` (${note.author_department})` : ""}${note.room ? ` · Room ${note.room}` : ""}`
      : "";
    return `
      <div class="ppn-item${unread ? " unread" : ""}${note.note_type === "critical" ? " critical" : ""}" data-note-id="${esc(note.id)}">
        <div>
          ${earlier ? `<span class="ppn-pill earlier">Earlier run</span>` : ""}
          <span class="ppn-pill ${esc(note.note_type)}">${esc(noteTypeLabel(note.note_type))}</span>
          <strong>${esc(noteTopicLabel(note))}</strong> · ${esc(noteAboutLabel(note))}
        </div>
        <div>${esc(note.body)}</div>
        <span class="meta">${esc(injectLabel(row, note.inject_index === undefined ? null : note.inject_index))} · ${esc(time)}${edited ? " · edited" : ""}${author ? ` · ${esc(author)}` : ""}</span>
        ${actionsHtml ? `<div class="ppn-actions">${actionsHtml}</div>` : ""}
      </div>`;
  }

  window.createNoteForm = createNoteForm;
  window.noteItemHtml = noteItemHtml;
  window.ppnEscape = esc;
  window.ppnInjectLabel = injectLabel;
})();
