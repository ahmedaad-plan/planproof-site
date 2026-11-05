/* PlanProof exercise player — the Answers page (W6e, 5 November 2026).
   One full-screen page, opened from the Answers button on the Exercise tab of
   the Facilitator page and of the Observer's screen: every submitted answer to
   an inject, grouped by department, live. Design: w6e-design.md.

   The answers come only from two checked database routes:
     facilitator_answers(session, inject)            — the facilitator link; names
     observer_answers(session, attendee, inject)     — a registered Observer of
                                                       this exercise: own room only,
                                                       no names, the notes window
   A browser can never read the answers table itself. Everything shown here is
   plain text (escaped), never HTML. Nothing on this page writes anything.

   Needs shared.js (callNotesRpc, injectOutput, injectResponsible,
   isDepartmentResponsible, sessionDepartments, formatMessageTime, ppEscape)
   and lang.js (T). */
(function () {
  "use strict"; // i18n-ok: a script directive, not wording
  const esc = (s) => ppEscape(s);
  const sameKey = (s) => String(s || "").trim().toLowerCase();
  const FOLD_CHARS = 600;
  const FOLD_LINES = 8;

  /* i18n-off: the page's style sheet, not wording */
  const CSS = `
.pp-ans { position: fixed; inset: 0; z-index: 1200; background: var(--bg, #0b0f14); color: var(--text, #e7eaee);
  overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
.pp-ans[hidden] { display: none !important; }
.pp-ans-bar { position: sticky; top: 0; z-index: 2; background: var(--bg, #0b0f14); border-bottom: 1px solid var(--border, #2b3642);
  padding: 10px 16px; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.pp-ans-bar h2 { margin: 0 6px 0 0; font-size: 1.35rem; }
.pp-ans-bar select { flex: 1 1 220px; min-width: 0; max-width: 100%; min-height: 44px; font: inherit; font-size: 15px;
  background: var(--field, #070a0e); color: var(--text, #e7eaee); border: 1px solid var(--border-strong, #46566a); border-radius: 8px; padding: 8px 10px; }
.pp-ans-bar .pp-btn { min-height: 44px; padding: 9px 16px; }
@media (max-width: 699px) {
  .pp-ans-bar h2 { flex: 1 1 auto; }
  .pp-ans-bar select { order: 3; flex: 1 1 100%; }
}
.pp-ans-sub { padding: 10px 16px 0; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.pp-ans-tag { display: inline-block; border: 1px solid var(--border-strong, #46566a); border-radius: 999px; padding: 2px 10px; font-size: 13px; color: #c9d1d9; }
.pp-ans-muted { color: var(--text-muted, #9aa5b1); font-size: 14px; }
.pp-ans-moved { margin: 10px 16px 0; border: 1px solid var(--attn, #e8812f); border-radius: 10px; padding: 8px 12px;
  display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.pp-ans-moved button, .pp-ans-more { background: none; border: 0; color: var(--accent, #f2f4f7); text-decoration: underline;
  font: inherit; font-size: 14px; font-weight: 600; padding: 8px 0; min-height: 44px; cursor: pointer; }
.pp-ans-grid { padding: 14px 16px 28px; display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); align-items: start; }
@media (min-width: 1000px) { .pp-ans-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; } }
@media (min-width: 1366px) { .pp-ans-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (min-width: 1800px) { .pp-ans-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
.pp-ans-card { border: 1px solid var(--border, #2b3642); border-radius: 10px; padding: 14px 16px; min-width: 0;
  transition: border-color 0.6s, box-shadow 0.6s; }
.pp-ans-card.fresh, .pp-ans-item.fresh { border-color: var(--accent, #f2f4f7); box-shadow: 0 0 0 1px var(--accent, #f2f4f7); }
.pp-ans-head { display: flex; justify-content: space-between; gap: 6px 10px; align-items: baseline; flex-wrap: wrap; margin-bottom: 8px; }
.pp-ans-dept { font-family: var(--font-display); font-weight: 600; font-size: 1.05rem; overflow-wrap: anywhere; }
.pp-ans-st { font-weight: 600; font-size: 14px; }
.pp-ans-st.ok { color: var(--teal-soft, #8fd0b8); }
.pp-ans-st.wait { color: var(--attn, #e8812f); }
.pp-ans-ed { color: var(--text-muted, #9aa5b1); font-size: 13px; margin: -4px 0 8px; }
.pp-ans-text { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
.pp-ans-text.folded { max-height: 12em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
.pp-ans-files { color: var(--text-muted, #9aa5b1); font-size: 13px; margin-top: 6px; overflow-wrap: anywhere; }
.pp-ans-item { border-top: 1px solid var(--border, #2b3642); padding: 10px 0 2px; border-radius: 6px; }
.pp-ans-item:first-of-type { border-top: 0; padding-top: 0; }
.pp-ans-who { color: var(--text-muted, #9aa5b1); font-size: 13px; margin-bottom: 2px; overflow-wrap: anywhere; }
.pp-ans-empty { padding: 28px 16px; color: var(--text-muted, #9aa5b1); }
.pp-ans-status { padding: 0 16px; min-height: 0; }
`;
  /* i18n-on */
  let cssDone = false;
  function addCss() {
    if (cssDone) return;
    cssDone = true;
    const st = document.createElement("style");
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  // opts: { role: "facilitator"|"observer", sessionId, token, attendeeId, getRow, onClosed }
  function create(opts) {
    addCss();
    const fac = opts.role === "facilitator";
    const root = document.createElement("div");
    root.className = "pp-ans";
    root.id = "ppAnswers";
    root.hidden = true;
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "ppAnsTitle");
    root.innerHTML = `
      <div class="pp-ans-bar">
        <h2 id="ppAnsTitle">${esc(T("ans.title"))}</h2>
        <select id="ppAnsInject" aria-label="${esc(T("ans.chooseInject"))}"></select>
        <button type="button" class="pp-btn ghost" id="ppAnsClose">${esc(T("ans.close"))}</button>
      </div>
      <div class="pp-ans-sub" id="ppAnsSub"></div>
      <div id="ppAnsMoved"></div>
      <div class="pp-ans-status pp-ans-muted" id="ppAnsStatus" role="status"></div>
      <div id="ppAnsBody"></div>`;
    document.body.appendChild(root);
    const selEl = root.querySelector("#ppAnsInject");
    const subEl = root.querySelector("#ppAnsSub");
    const movedEl = root.querySelector("#ppAnsMoved");
    const statusEl = root.querySelector("#ppAnsStatus");
    const bodyEl = root.querySelector("#ppAnsBody");

    let open = false;
    let viewIdx = null;     // null = follow the inject on screen
    let data = null;        // the last good reply
    let busy = false;
    let again = false;
    let lastOkAt = 0;
    let failed = false;
    let seen = null;        // answer key -> signature, to highlight new or changed answers
    let opener = null;
    let lastCurrent = null;
    const expanded = new Set();
    let timer = null;
    const periodMs = fac ? 5000 : 8000;

    function row() { return (opts.getRow && opts.getRow()) || null; }

    async function fetchData() {
      if (busy) { again = true; return; }
      busy = true;
      try {
        const idx = viewIdx;
        const r = fac
          ? await callNotesRpc("facilitator_answers", { p_session_id: opts.sessionId, p_inject_index: idx }, opts.token)
          : await callNotesRpc("observer_answers", { p_session_id: opts.sessionId, p_attendee_id: opts.attendeeId, p_inject_index: idx });
        failed = false;
        lastOkAt = Date.now();
        if (r && r.closed) {
          data = null;
          if (r.closed === "lobby") { close(); return; }
          renderClosed(r.closed);
          if (opts.onClosed) opts.onClosed(r.closed);
          return;
        }
        data = r;
        render();
      } catch (err) {
        failed = true;
        renderStatus();
      } finally {
        busy = false;
        if (again && open) { again = false; fetchData(); }
      }
    }

    function renderClosed(kind) {
      selEl.innerHTML = "";
      subEl.innerHTML = "";
      movedEl.innerHTML = "";
      statusEl.textContent = "";
      bodyEl.innerHTML = `<div class="pp-ans-empty">${esc(T(kind === "window" ? "ans.closedWindow" : "ans.closedData"))}</div>`;
    }

    function renderStatus() {
      if (failed) {
        statusEl.textContent = lastOkAt
          ? T("ans.reconnecting", { time: formatMessageTime(new Date(lastOkAt).toISOString()) })
          : T("ans.reconnectingFirst");
      } else statusEl.textContent = "";
      if (failed && !data) bodyEl.innerHTML = "";
    }

    function injectTitle(inj, i) {
      const t = (inj && (inj.title || inj.name)) || "";
      return t ? T("ans.injectOption", { n: i + 1, total: totalInjects(), title: t }) : T("ans.injectOptionPlain", { n: i + 1, total: totalInjects() });
    }
    function totalInjects() { const r = row(); return ((r && r.scenario && r.scenario.injects) || []).length; }

    function cardsFor(idx, inject, answers) {
      const r = row();
      const resp = injectResponsible(inject);
      let depts = resp.some((d) => sameKey(d) === "all") ? sessionDepartments(r) : resp.slice();
      depts = depts.filter((d) => isDepartmentResponsible(inject, d, r, idx));
      if (!fac && data && Array.isArray(data.departments)) {
        const mine = new Set(data.departments.map(sameKey));
        depts = depts.filter((d) => mine.has(sameKey(d)));
      }
      const keys = new Set(depts.map(sameKey));
      for (const a of answers) {
        if (!keys.has(sameKey(a.department))) { keys.add(sameKey(a.department)); depts.push(a.department); }
      }
      return depts;
    }

    function timeOf(iso) { return iso ? formatMessageTime(iso) : ""; }

    function textBlock(a) {
      const text = String(a.text || "");
      const long = text.length > FOLD_CHARS || text.split("\n").length > FOLD_LINES;
      const isOpen = expanded.has(a.key);
      let h = text.trim() ? `<div class="pp-ans-text${long && !isOpen ? " folded" : ""}" dir="auto">${esc(text)}</div>` : "";
      if (long) h += `<button type="button" class="pp-ans-more" data-more="${esc(a.key)}" aria-expanded="${isOpen}">${esc(T(isOpen ? "ans.showLess" : "ans.showMore"))}</button>`;
      const files = Array.isArray(a.files) ? a.files : [];
      if (files.length) h += `<div class="pp-ans-files">${esc(T(files.length === 1 ? "ans.fileOne" : "ans.files", { n: files.length }))} · <span dir="auto">${esc(files.join(", "))}</span></div>`;
      return h;
    }

    function sig(a) { return `${a.submitted_at}|${(a.text || "").length}|${(a.text || "").slice(0, 80)}|${(a.files || []).length}`; }

    function render() {
      const r = row();
      if (!data || data.inject_index == null || !r) {
        selEl.innerHTML = "";
        subEl.innerHTML = "";
        movedEl.innerHTML = "";
        renderStatus();
        bodyEl.innerHTML = `<div class="pp-ans-empty">${esc(T("ans.noneYet"))}</div>`;
        return;
      }
      const injects = (r.scenario && r.scenario.injects) || [];
      const idx = data.inject_index;
      const inject = injects[idx] || {};
      // the inject choice: every inject played in this run, the newest first
      const played = (data.played || []).slice().sort((a, b) => b - a);
      const selSig = played.join(",") + "|" + idx;
      if (selEl.dataset.sig !== selSig) {
        selEl.innerHTML = played.map((i) => `<option value="${i}"${i === idx ? " selected" : ""}>${esc(injectTitle(injects[i], i))}</option>`).join("");
        selEl.dataset.sig = selSig;
      }
      const individual = injectOutput(inject) === "individual";
      subEl.innerHTML = `<span class="pp-ans-tag">${esc(T(individual ? "ans.taskIndividual" : "ans.taskGroup"))}</span>` +
        (!fac && data.multi_room && data.my_room ? `<span class="pp-ans-muted">${esc(T("ans.myRoom", { room: data.my_room }))}</span>` : "");
      // the exercise moved on while looking back
      const cur = data.current_index;
      const live = r.status === "running";
      movedEl.innerHTML = viewIdx !== null && live && cur != null && cur !== idx
        ? `<div class="pp-ans-moved"><span>${esc(T("ans.moved", { n: cur + 1 }))}</span><button type="button" id="ppAnsGoCurrent">${esc(T("ans.goCurrent"))}</button></div>`
        : "";
      renderStatus();

      const answers = (data.answers || []).filter((a) => a && a.department);
      const depts = cardsFor(idx, inject, answers);
      if (!depts.length) {
        bodyEl.innerHTML = `<div class="pp-ans-empty">${esc(T("ans.noWritten"))}</div>`;
        return;
      }
      const eligible = {};
      for (const e of data.eligible || []) eligible[sameKey(e.department)] = e.n || 0;
      const first = seen === null;
      const nextSeen = new Map();
      const fresh = (a) => { const s = sig(a); nextSeen.set(a.key, s); return !first && seen.get(a.key) !== s; };

      const cards = depts.map((d) => {
        const mine = answers.filter((a) => sameKey(a.department) === sameKey(d));
        const group = mine.find((a) => !a.individual);
        const people = mine.filter((a) => a.individual);
        let head, body = "", isFresh = false, edited = "";
        if (!individual) {
          if (group) {
            const t = timeOf(group.submitted_at);
            head = group.on_time === false
              ? `<span class="pp-ans-st wait">${esc(T("ans.late", { time: t }))}</span>`
              : `<span class="pp-ans-st ok">${esc(T("ans.answered", { time: t }))}</span>`;
            if (group.edited) edited = `<div class="pp-ans-ed">${esc(T("ans.edited", { first: timeOf(group.first_submitted_at), time: t }))}</div>`;
            body = textBlock(group);
            isFresh = fresh(group);
          } else head = `<span class="pp-ans-st wait">${esc(T("ans.waiting"))}</span>`;
        }
        if (individual || people.length) {
          const counted = people.filter((a) => !a.removed);
          const total = eligible[sameKey(d)] || 0;
          if (individual) {
            const all = total > 0 && counted.length >= total;
            head = counted.length || total
              ? `<span class="pp-ans-st ${all ? "ok" : "wait"}">${esc(T("ans.someOf", { done: counted.length, total: Math.max(total, counted.length) }))}</span>`
              : `<span class="pp-ans-st wait">${esc(T("ans.waiting"))}</span>`;
          }
          body += people.map((a, i) => {
            const t = timeOf(a.submitted_at);
            let who;
            if (fac) {
              who = a.removed ? T("ans.removed") : (a.name || T("ans.answerN", { n: i + 1 }));
              if (a.remote) who += " · " + T("ans.remote");
              else if (data.room_count > 1 && a.room) who += " · " + T("ans.room", { room: a.room });
            } else who = T("ans.answerN", { n: i + 1 });
            let meta = `${esc(who)} · ${esc(t)}`;
            if (a.on_time === false) meta += ` · <span class="pp-ans-st wait">${esc(T("ans.afterTime"))}</span>`;
            if (a.edited) meta += ` · ${esc(T("ans.editedShort", { first: timeOf(a.first_submitted_at) }))}`;
            const f = fresh(a);
            return `<div class="pp-ans-item${f ? " fresh" : ""}" data-key="${esc(a.key)}"><div class="pp-ans-who" dir="auto">${meta}</div>${textBlock(a)}</div>`;
          }).join("");
        }
        return `<section class="pp-ans-card${isFresh ? " fresh" : ""}" aria-label="${esc(d)}"><div class="pp-ans-head"><span class="pp-ans-dept" dir="auto">${esc(d)}</span>${head}</div>${edited}${body}</section>`;
      });
      bodyEl.innerHTML = `<div class="pp-ans-grid">${cards.join("")}</div>`;
      seen = nextSeen;
      if (!first) setTimeout(() => { bodyEl.querySelectorAll(".fresh").forEach((el) => el.classList.remove("fresh")); }, 4000);
    }

    selEl.addEventListener("change", () => {
      const v = parseInt(selEl.value, 10);
      const r = row();
      const followCurrent = r && r.status === "running" && r.current_inject_index === v;
      viewIdx = followCurrent ? null : v;
      seen = null;
      fetchData();
    });
    root.addEventListener("click", (e) => {
      const more = e.target.closest("[data-more]");
      if (more) {
        const k = more.getAttribute("data-more");
        if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
        render();
        return;
      }
      if (e.target.closest("#ppAnsGoCurrent")) { viewIdx = null; seen = null; fetchData(); }
    });
    root.querySelector("#ppAnsClose").addEventListener("click", () => close());
    document.addEventListener("keydown", (e) => { if (open && e.key === "Escape") close(); });
    document.addEventListener("visibilitychange", () => { if (open && !document.hidden) fetchData(); });

    function tick() { if (open && !document.hidden) fetchData(); }

    function show() {
      opener = document.activeElement;
      open = true;
      viewIdx = null;
      seen = null;
      data = null;
      failed = false;
      expanded.clear();
      bodyEl.innerHTML = `<div class="pp-ans-empty">${esc(T("ans.loading"))}</div>`;
      subEl.innerHTML = "";
      movedEl.innerHTML = "";
      statusEl.textContent = "";
      root.hidden = false;
      document.documentElement.style.overflow = "hidden";
      root.scrollTop = 0;
      root.querySelector("#ppAnsClose").focus();
      clearInterval(timer);
      timer = setInterval(tick, periodMs);
      fetchData();
    }
    function close() {
      if (!open) return;
      open = false;
      root.hidden = true;
      document.documentElement.style.overflow = "";
      clearInterval(timer);
      timer = null;
      if (opener && typeof opener.focus === "function" && document.contains(opener)) opener.focus();
    }
    // Called whenever the page learns the exercise row has changed.
    function onRow(r) {
      if (!open || !r) return;
      if (r.status === "lobby") { close(); return; }
      if (r.current_inject_index !== lastCurrent) {
        lastCurrent = r.current_inject_index;
        if (viewIdx === null) seen = null;
        fetchData();
      }
    }
    return { open: show, close, isOpen: () => open, onRow, refresh: () => { if (open) fetchData(); } };
  }

  window.PPAnswers = { create };
})();
