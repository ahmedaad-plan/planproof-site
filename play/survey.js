// Post-exercise feedback survey (exercise-player roadmap item, built
// 16 October 2026). One short, anonymous survey answered on the person's own
// device straight after the exercise ends, in two places:
//   - participant.html (a participant's phone or laptop), under the thank-you;
//   - room-display.html in Observer mode, under the compact thank-you card and
//     ABOVE the notes area — never covering it.
// Design: design-notes.md → "Post-exercise feedback survey". Needs lang.js and
// shared.js first.
//
// What it guarantees on the device (the database checks everything again):
//   - every tap is kept on the device as it happens, so a reload, a flat
//     battery or a dropped connection loses nothing;
//   - the answer's id is made on the device, so Send pressed twice, or a send
//     retried after a lost reply, is saved once;
//   - nothing identifying is sent but the registration id the database needs
//     to refuse outsiders and double answers; the answer itself is stored
//     without it (see the database notes);
//   - a new run (Reset) starts a fresh survey; "Resume at inject N" simply
//     hides it with the thank-you, and it comes back at the next End.

(function () {
  const CSS = /* i18n-ok: the survey's CSS, not wording */ `
  .ppsv { width:100%; max-width:620px; margin:0 auto 20px; padding:22px 20px 20px; box-sizing:border-box; text-align:start;
    background:var(--panel); color:var(--text); border:1px solid var(--border); border-top:4px solid var(--accent); border-radius:14px;
    box-shadow:0 12px 40px var(--shadow); font-family:var(--font-body); font-size:15px; line-height:1.4; overflow-wrap:anywhere; }
  .ppsv.compact { max-width:720px; margin:0 auto 10px; padding:16px 16px 14px; }
  .ppsv [hidden] { display:none !important; }
  .ppsv-title { font-family:var(--font-display); font-weight:700; font-size:clamp(1.15rem, 3.6vw, 1.4rem); margin:0 0 4px; line-height:1.2; text-wrap:balance; }
  .ppsv-lead { margin:0 0 6px; color:var(--text-muted); font-size:.95rem; text-wrap:pretty; }
  .ppsv-later { display:inline-block; margin:2px 0 6px; font-size:.9rem; color:var(--accent); background:none; border:0; padding:4px 0; cursor:pointer; font:inherit; text-decoration:underline; }
  .ppsv-bar { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; background:var(--panel); border:1px solid var(--accent); border-radius:12px; max-width:720px; margin:0 auto 10px; box-sizing:border-box; }
  .ppsv-bar b { font-weight:600; }
  .ppsv-group { margin:14px 0 0; padding:12px 0 0; border-top:1px solid var(--border); }
  .ppsv-group-title { font-size:.8rem; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:var(--text-muted); margin:0 0 6px; }
  .ppsv-q { margin:10px 0 0; padding:8px 8px 10px; border-radius:10px; border:1.5px solid transparent; }
  .ppsv-q.missing { border-color:var(--red); background:rgba(194,81,63,.08); }
  .ppsv-qtext { font-weight:500; margin:0 0 8px; }
  .ppsv-q.missing .ppsv-qtext::after { content:" *"; color:var(--red); }
  .ppsv-scale { display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:6px; }
  .ppsv-scale.three { grid-template-columns:repeat(3, minmax(0,1fr)); }
  .ppsv-chip { font:inherit; font-size:.86rem; line-height:1.2; padding:9px 8px; min-height:42px; border-radius:10px; text-align:center;
    border:1.5px solid var(--border-strong); background:var(--field); color:var(--text); cursor:pointer; -webkit-tap-highlight-color:transparent; }
  .ppsv-chip[aria-checked="true"] { background:var(--text); color:var(--bg); border-color:var(--text); font-weight:600; }
  .ppsv-chip:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .ppsv-stars { display:flex; gap:4px; align-items:center; flex-wrap:wrap; }
  .ppsv-star { font:inherit; font-size:1.9rem; line-height:1; width:46px; height:46px; border-radius:10px; border:1.5px solid var(--border-strong);
    background:var(--field); color:var(--text-muted); cursor:pointer; -webkit-tap-highlight-color:transparent; }
  .ppsv-star.lit { color:var(--accent); border-color:var(--accent); }
  .ppsv-star[aria-checked="true"] { background:transparent; }
  .ppsv-star:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .ppsv-ends { display:flex; justify-content:space-between; gap:8px; font-size:.78rem; color:var(--text-muted); margin-top:5px; }
  .ppsv-nps { display:grid; grid-template-columns:repeat(11, minmax(0,1fr)); gap:4px; direction:ltr; }
  .ppsv-nps .ppsv-chip { padding:9px 2px; font-variant-numeric:tabular-nums; font-family:var(--font-mono); }
  .ppsv-nps-ends { direction:ltr; }
  .ppsv textarea { width:100%; box-sizing:border-box; padding:10px; min-height:84px; resize:vertical; font:inherit; font-size:.95rem; border-radius:10px;
    border:2px solid var(--border-strong); background:var(--field); color:var(--text); }
  .ppsv textarea:focus { outline:none; border-color:var(--accent); }
  .ppsv-hint { font-size:.8rem; color:var(--text-muted); margin:4px 0 0; display:flex; justify-content:space-between; gap:8px; }
  .ppsv-quote { display:flex; gap:8px; align-items:flex-start; margin:10px 0 0; font-size:.88rem; cursor:pointer; }
  .ppsv-quote input { margin:3px 0 0; width:18px; height:18px; flex:none; }
  .ppsv-send { margin-top:14px; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .ppsv-send button { font:inherit; font-weight:600; font-size:1rem; padding:12px 22px; min-height:46px; border-radius:10px; border:0;
    background:var(--accent); color:var(--accent-ink); cursor:pointer; }
  .ppsv-send button:disabled { opacity:.6; cursor:default; }
  .ppsv-status { font-size:.9rem; color:var(--text-muted); }
  .ppsv-status.err { color:var(--red); }
  .ppsv-done { text-align:center; }
  .ppsv-done .ppsv-title { margin-bottom:6px; }
  .ppsv-done p { margin:0; color:var(--text-muted); }
  @media (max-width: 600px) {
    .ppsv-scale, .ppsv-scale.three { grid-template-columns:1fr; }
    .ppsv-chip { text-align:start; padding:10px 12px; }
    .ppsv-nps { grid-template-columns:repeat(6, minmax(0,1fr)); }
    .ppsv-nps .ppsv-chip { text-align:center; padding:9px 2px; }
  }`;

  // Shown from "Strongly agree" down (Ahmed, 18 October 2026); the saved
  // number is unchanged (5 = strongly agree).
  const AGREE = [
    [5, "survey.scale.stronglyAgree"], [4, "survey.scale.agree"], [3, "survey.scale.neutral"],
    [2, "survey.scale.disagree"], [1, "survey.scale.stronglyDisagree"],
  ];
  // The questions, in the order shown. What is SAVED is the key and a code or
  // number; only what is shown comes from the language file.
  const GROUPS = [
    { title: "survey.group.exercise", questions: [
      { key: "realistic", text: "survey.q.realistic", kind: "agree" },
      { key: "pressure", text: "survey.q.pressure", kind: "agree" },
      { key: "role_understanding", text: "survey.q.role", observerText: "survey.q.roleObserver", kind: "agree" },
      { key: "duration", text: "survey.q.duration", kind: "choice", options: [["too_short", "survey.duration.tooShort"], ["about_right", "survey.duration.aboutRight"], ["too_long", "survey.duration.tooLong"]] },
    ] },
    { title: "survey.group.technology", questions: [
      { key: "screens_easy", text: "survey.q.screens", kind: "agree" },
      { key: "tech_problem", text: "survey.q.tech", kind: "choice", options: [["none", "survey.tech.none"], ["small", "survey.tech.small"], ["in_the_way", "survey.tech.inTheWay"]] },
    ] },
    { title: "survey.group.planproof", questions: [
      { key: "overall", text: "survey.q.overall", kind: "stars" },
      { key: "recommend", text: "survey.q.recommend", kind: "nps" },
    ] },
  ];
  const REQUIRED = GROUPS.flatMap((g) => g.questions.map((q) => q.key));
  const COMMENT_MAX = 500;
  const WINDOW_MS = 48 * 60 * 60 * 1000; // open until 48 hours after End (the database decides)

  let cssDone = false;
  function ensureCss() {
    if (cssDone) return;
    cssDone = true;
    const s = document.createElement("style");
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  const esc = (t) => String(t === null || t === undefined ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  // The answers kept on the device: one record per exercise, keyed by run.
  function storeKey(sessionId) { return `pp_survey_${sessionId}`; }
  function readState(sessionId) {
    try { return JSON.parse(localStorage.getItem(storeKey(sessionId)) || "null"); } catch { return null; }
  }
  function writeState(sessionId, state) {
    try { localStorage.setItem(storeKey(sessionId), JSON.stringify(state)); } catch { /* private mode: still works for this page view */ }
  }
  function freshState(run) {
    return { id: crypto.randomUUID(), run, answers: {}, comment: "", quoteOk: false, done: false, collapsed: false };
  }

  // root: the element the survey draws itself into.
  // opts: { sessionId, attendeeId, observer (true on an Observer's device) }
  // Returns { refresh(row) } — call it with every session row the page gets.
  function createSurvey(root, opts) {
    ensureCss();
    const { sessionId, attendeeId } = opts;
    const observer = !!opts.observer;
    let state = readState(sessionId);
    let latestRow = null;
    let drawnFor = null; // "form:<run>" / "done:<run>" / "closed:<run>" / "bar:<run>"
    let sending = false;

    function windowOpen(row) {
      if (!row || row.status !== "ended" || !row.ended_at) return false;
      return Date.now() <= Date.parse(row.ended_at) + WINDOW_MS;
    }
    function save() { writeState(sessionId, state); }

    function refresh(row) {
      if (row) latestRow = row;
      row = latestRow;
      if (!row || row.status !== "ended") {
        // not ended (or resumed): nothing to show; the answers stay on the device
        root.hidden = true;
        root.innerHTML = "";
        drawnFor = null;
        return;
      }
      const run = row.run_number || 1;
      if (!state || state.run !== run) { state = freshState(run); save(); }
      root.hidden = false;
      let want;
      if (state.done) want = `done:${run}`;
      else if (!windowOpen(row)) want = `closed:${run}`;
      else if (observer && state.collapsed) want = `bar:${run}`;
      else want = `form:${run}`;
      if (want === drawnFor) return;
      drawnFor = want;
      if (want.startsWith("done")) drawDone();
      else if (want.startsWith("closed")) drawClosed();
      else if (want.startsWith("bar")) drawBar();
      else drawForm();
    }

    function card(inner, extraClass) {
      return `<section class="ppsv${observer ? " compact" : ""}${extraClass ? " " + extraClass : ""}" aria-live="polite">${inner}</section>`;
    }
    function drawDone() {
      root.innerHTML = card(
        `<h2 class="ppsv-title">${esc(T("survey.done.title"))}</h2>` +
        (observer ? "" : `<p>${esc(T("survey.done.closePage"))}</p>`),
        "ppsv-done"
      );
    }
    function drawClosed() {
      root.innerHTML = card(
        `<p class="ppsv-lead">${esc(T("survey.closed"))}</p>` +
        (observer ? "" : `<p class="ppsv-lead">${esc(T("shared.end.closePage"))}</p>`),
        "ppsv-done"
      );
    }
    function drawBar() {
      root.innerHTML = `<div class="ppsv-bar"><b>${esc(T("survey.bar.label"))}</b><button type="button" class="ppsv-later" id="ppsvOpen">${esc(T("survey.bar.open"))}</button></div>`;
      root.querySelector("#ppsvOpen").addEventListener("click", () => { state.collapsed = false; save(); drawnFor = null; refresh(); });
    }

    function chipRow(q) {
      const opts = q.kind === "agree" ? AGREE : q.options;
      const cls = `ppsv-scale${opts.length === 3 ? " three" : ""}`;
      return `<div class="${cls}" role="radiogroup" aria-label="${esc(T(q.observerText && observer ? q.observerText : q.text))}">` +
        opts.map(([v, k]) => `<button type="button" class="ppsv-chip" role="radio" data-q="${q.key}" data-v="${esc(v)}" aria-checked="${String(state.answers[q.key]) === String(v)}">${esc(T(k))}</button>`).join("") +
        `</div>`;
    }
    function starsRow(q) {
      const cur = Number(state.answers[q.key]) || 0;
      return `<div class="ppsv-stars" role="radiogroup" aria-label="${esc(T(q.text))}">` +
        [1, 2, 3, 4, 5].map((n) => `<button type="button" class="ppsv-star${n <= cur ? " lit" : ""}" role="radio" data-q="${q.key}" data-v="${n}" aria-checked="${cur === n}" aria-label="${esc(T("survey.stars.aria", { n }))}">★</button>`).join("") +
        `</div><div class="ppsv-ends"><span>${esc(T("survey.stars.low"))}</span><span>${esc(T("survey.stars.high"))}</span></div>`;
    }
    function npsRow(q) {
      const cur = state.answers[q.key];
      return `<div class="ppsv-nps" role="radiogroup" aria-label="${esc(T(q.text))}">` +
        Array.from({ length: 11 }, (_, n) => `<button type="button" class="ppsv-chip" role="radio" data-q="${q.key}" data-v="${n}" aria-checked="${Number(cur) === n && cur !== undefined}">${n}</button>`).join("") +
        `</div><div class="ppsv-ends ppsv-nps-ends"><span>${esc(T("survey.nps.low"))}</span><span>${esc(T("survey.nps.high"))}</span></div>`;
    }
    function drawForm() {
      const groups = GROUPS.map((g) =>
        `<div class="ppsv-group"><p class="ppsv-group-title">${esc(T(g.title))}</p>` +
        g.questions.map((q) =>
          `<div class="ppsv-q" data-qbox="${q.key}"><p class="ppsv-qtext">${esc(T(q.observerText && observer ? q.observerText : q.text))}</p>` +
          (q.kind === "stars" ? starsRow(q) : q.kind === "nps" ? npsRow(q) : chipRow(q)) + `</div>`
        ).join("") + `</div>`
      ).join("");
      root.innerHTML = card(
        `<h2 class="ppsv-title">${esc(T("survey.title"))}</h2>` +
        `<p class="ppsv-lead">${esc(T("survey.lead"))}</p>` +
        (observer ? `<button type="button" class="ppsv-later" id="ppsvLater">${esc(T("survey.later"))}</button>` : "") +
        groups +
        `<div class="ppsv-group"><p class="ppsv-group-title">${esc(T("survey.group.more"))}</p>` +
        `<div class="ppsv-q"><label class="ppsv-qtext" for="ppsvComment">${esc(T("survey.q.comment"))}</label>` +
        `<textarea id="ppsvComment" maxlength="${COMMENT_MAX}" placeholder="${esc(T("survey.comment.placeholder"))}">${esc(state.comment)}</textarea>` +
        `<p class="ppsv-hint"><span>${esc(T("survey.comment.noNames"))}</span><span id="ppsvCount">${esc(T("survey.comment.count", { n: state.comment.length, max: COMMENT_MAX }))}</span></p>` +
        `<label class="ppsv-quote"><input type="checkbox" id="ppsvQuote"${state.quoteOk ? " checked" : ""}><span>${esc(T("survey.comment.quoteOk"))}</span></label></div></div>` +
        `<div class="ppsv-send"><button type="button" id="ppsvSend">${esc(T("survey.send"))}</button><span class="ppsv-status" id="ppsvStatus" role="status"></span></div>`
      );
      wire();
    }

    function wire() {
      root.querySelectorAll("[role=radio]").forEach((b) => {
        b.addEventListener("click", () => {
          const q = b.getAttribute("data-q");
          const v = b.getAttribute("data-v");
          state.answers[q] = /^\d+$/.test(v) ? Number(v) : v;
          save();
          const box = root.querySelector(`[data-qbox="${q}"]`);
          box.classList.remove("missing");
          box.querySelectorAll("[role=radio]").forEach((o) => {
            const on = o.getAttribute("data-v") === v;
            o.setAttribute("aria-checked", String(on));
            if (o.classList.contains("ppsv-star")) o.classList.toggle("lit", Number(o.getAttribute("data-v")) <= Number(v));
          });
          setStatus("");
        });
      });
      const ta = root.querySelector("#ppsvComment");
      const count = root.querySelector("#ppsvCount");
      ta.addEventListener("input", () => {
        if (ta.value.length > COMMENT_MAX) ta.value = ta.value.slice(0, COMMENT_MAX);
        state.comment = ta.value; save();
        count.textContent = T("survey.comment.count", { n: ta.value.length, max: COMMENT_MAX });
      });
      root.querySelector("#ppsvQuote").addEventListener("change", (e) => { state.quoteOk = !!e.target.checked; save(); });
      const later = root.querySelector("#ppsvLater");
      if (later) later.addEventListener("click", () => { state.collapsed = true; save(); drawnFor = null; refresh(); });
      root.querySelector("#ppsvSend").addEventListener("click", send);
    }
    function setStatus(text, err) {
      const el = root.querySelector("#ppsvStatus");
      if (!el) return;
      el.textContent = text || "";
      el.classList.toggle("err", !!err);
    }

    async function send() {
      if (sending) return;
      // Every tap question is needed; the comment is optional. A missing one
      // is highlighted and scrolled to — nothing is thrown away.
      root.querySelectorAll(".ppsv-q.missing").forEach((b) => b.classList.remove("missing"));
      const missing = REQUIRED.filter((k) => state.answers[k] === undefined || state.answers[k] === null || state.answers[k] === "");
      if (missing.length) {
        missing.forEach((k) => { const box = root.querySelector(`[data-qbox="${k}"]`); if (box) box.classList.add("missing"); });
        const first = root.querySelector(`[data-qbox="${missing[0]}"]`);
        if (first && first.scrollIntoView) first.scrollIntoView({ behavior: "smooth", block: "center" });
        setStatus(T("survey.missing", { count: missing.length }), true);
        return;
      }
      const btn = root.querySelector("#ppsvSend");
      sending = true; btn.disabled = true; setStatus(T("survey.sending"));
      const answers = Object.assign({}, state.answers, { comment: state.comment.trim(), quote_ok: !!state.quoteOk && !!state.comment.trim() });
      try {
        const result = await callNotesRpc("submit_feedback", {
          p_id: state.id, p_session_id: sessionId, p_attendee_id: attendeeId, p_answers: answers,
        });
        // sent, duplicate (a retry) and already (answered from another device) all mean: done
        state.done = true; save();
        drawnFor = null; refresh();
        // back to the top, where the thank-you is (18 October 2026)
        try { window.scrollTo({ top: 0 }); } catch { window.scrollTo(0, 0); }
        if (result && result.status === "already") showToast(T("survey.already"), 6000);
      } catch (e) {
        const msg = e && e.network ? T("survey.notSentOffline") : T("survey.notSent", { detail: PPLang.dbMessage((e && e.message) || "") });
        setStatus(msg, true);
      } finally {
        sending = false;
        if (btn.isConnected) btn.disabled = false;
      }
    }

    return { refresh };
  }

  window.createSurvey = createSurvey;
})();
