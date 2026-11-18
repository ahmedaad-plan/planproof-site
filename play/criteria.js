// W8 build 3 (18 November 2026) — two facilitator-only pieces of the Facilitator page.
// Design: planproof-reference/w8-design.md Part F.
//
//   PPCriteria.dayPanel(el, opts)  — "Before the day" (F.1): one checklist at the top of
//     the Exercise tab while the exercise is in the lobby. Automatic lines read the
//     database (facilitator_before_day); only two lines are manual ticks (the backup pack
//     printed, the connection-check result received), each kept per session with its
//     date. When both manual ticks are done the panel folds to one line; at Start it is gone.
//
//   PPCriteria.tab(el, opts)  — the Criteria tab (F.2): the scenario's readiness criteria,
//     the current inject's first, five choices and a one-line note each. Ratings are kept
//     per run (facilitator_rate_criterion); a trial run's ratings are dropped at End trial.
//     Open from Start until the facilitator's notes close.
//
// Needs lang.js (T) and shared.js (callNotesRpc). Every word comes from lang.js.
(function () {
  "use strict"; // i18n-ok: directive
  var RATINGS = ["performed", "some_challenges", "major_challenges", "not_performed", "not_tested"];
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function day(iso) {
    try { return new Date(iso).toLocaleString(PPLang.locales(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; }
  }
  // "Inject 3 answer; facilitator timing" → [3]
  function injectsOf(testedBy) {
    var out = [], m, re = /inject\s*(\d+)/gi;
    while ((m = re.exec(String(testedBy || "")))) out.push(Number(m[1]));
    return out;
  }

  // ---------------- Before the day ----------------
  function dayPanel(el, opts) {
    var facts = null, busy = false, lastAt = 0, err = null;
    function row() { return (opts.getRow && opts.getRow()) || null; }
    async function load(force) {
      if (busy || (!force && Date.now() - lastAt < 20000)) return;
      busy = true;
      try { facts = await callNotesRpc("facilitator_before_day", { p_session_id: opts.sessionId }, opts.token); err = null; lastAt = Date.now(); }
      catch (e) { err = e.message || String(e); lastAt = Date.now(); } // a failed load waits its normal interval too
      finally { busy = false; render(); }
    }
    async function tick(which, on) {
      try { await callNotesRpc("facilitator_day_tick", { p_session_id: opts.sessionId, p_tick: which, p_on: on }, opts.token); }
      catch (e) { err = e.message || String(e); }
      await load(true);
    }
    function line(done, label, status, buttons, key) {
      return '<li class="day-line ' + (done ? "done" : "todo") + '" data-day="' + key + '"><span class="day-tick" aria-hidden="true">' + (done ? "✓" : "") + "</span>" +
        '<span class="day-what"><strong>' + esc(label) + '</strong> <span class="day-status">' + esc(status) + "</span></span>" +
        '<span class="day-btns">' + buttons + "</span></li>";
    }
    function btn(act, label, primary) { return '<button type="button" class="' + (primary ? "primary " : "") + 'day-btn" data-act="' + act + '">' + esc(label) + "</button>"; }
    function render() {
      var r = row();
      if (!r || r.status !== "lobby" || r.purpose === "play") { el.hidden = true; el.__ppDayHtml = null; el.innerHTML = ""; return; }
      el.hidden = false;
      if (!facts) { el.__ppDayHtml = null; el.innerHTML = '<h2>' + esc(T("fac.day.heading")) + '</h2><p class="pp-hint">' + esc(err ? T("fac.day.loadFailed", { error: err }) : T("fac.common.loading")) + "</p>"; return; }
      var t = facts.ticks || {};
      var lines = [];
      lines.push(line(true, T("fac.day.links"), T("fac.day.linksReady"), btn("links", T("fac.day.linksBtn")), "links"));
      var sentBoth = facts.confirmation_sent_at && facts.invitation_sent_at;
      var mailStatus = !facts.linked ? T("fac.day.mailNotLinked")
        : sentBoth ? T("fac.day.mailSent", { confirmation: day(facts.confirmation_sent_at), invitation: day(facts.invitation_sent_at) })
        : facts.confirmation_sent_at ? T("fac.day.mailOnlyConfirmation", { when: day(facts.confirmation_sent_at) })
        : facts.invitation_sent_at ? T("fac.day.mailOnlyInvitation", { when: day(facts.invitation_sent_at) })
        : T("fac.day.mailNotSent");
      lines.push(line(!!sentBoth, T("fac.day.mail"), mailStatus, "", "mail"));
      var ms = facts.media_status;
      var mediaDone = ms === "ready";
      var mediaStatus = ms === "ready" ? T("fac.day.mediaReady") : ms === "preparing" ? T("fac.day.mediaPreparing")
        : ms === "failed" || facts.media_failed > 0 ? T("fac.day.mediaFailed", { count: facts.media_failed || 1 }) : T("fac.day.mediaNone");
      lines.push(line(mediaDone, T("fac.day.media"), mediaStatus, "", "media"));
      lines.push(line(!!t.connection, T("fac.day.check"), t.connection ? T("fac.day.tickedOn", { when: day(t.connection) }) : T("fac.day.checkTodo"),
        btn("check", T("fac.day.checkBtn")) + (t.connection ? btn("untick-connection", T("fac.day.untick")) : btn("tick-connection", T("fac.day.checkTick"), true)), "connection"));
      lines.push(line(!!facts.expected_set, T("fac.day.numbers"), facts.expected_set ? T("fac.day.numbersSet") : T("fac.day.numbersTodo"), btn("numbers", T("fac.day.numbersBtn")), "numbers"));
      lines.push(line(!!t.pack, T("fac.day.pack"), t.pack ? T("fac.day.tickedOn", { when: day(t.pack) }) : T("fac.day.packTodo"),
        btn("pack", T("fac.day.packBtn")) + (t.pack ? btn("untick-pack", T("fac.day.untick")) : btn("tick-pack", T("fac.day.packTick"), true)), "pack"));
      lines.push(line(true, T("fac.day.rooms"), T("fac.day.roomsCount", { count: facts.room_count || 1 }), btn("rooms", T("fac.day.roomsBtn")), "rooms"));
      var manualDone = !!(t.pack && t.connection);
      var openAuto = [];
      if (!sentBoth) openAuto.push(T("fac.day.mail"));
      if (!mediaDone) openAuto.push(T("fac.day.media"));
      if (!facts.expected_set) openAuto.push(T("fac.day.numbers"));
      var summary = manualDone && !openAuto.length ? T("fac.day.ready") : manualDone ? T("fac.day.foldedStill", { list: openAuto.join(" · ") }) : T("fac.day.heading");
      var wasOpen = el.querySelector("details") ? el.querySelector("details").open : !manualDone;
      var html = '<details class="day-fold"' + (manualDone && !wasOpen ? "" : " open") + '><summary><h2>' + esc(summary) + "</h2></summary>" +
        '<p class="pp-hint">' + esc(T("fac.day.sub")) + "</p><ul class=\"day-list\">" + lines.join("") + "</ul>" +
        (err ? '<p class="pp-hint" role="alert">' + esc(err) + "</p>" : "") + "</details>";
      el.classList.toggle("folded", manualDone);
      // Redraw only when something changed: a redraw between a press and its release loses the click (build 3 finish).
      if (html === el.__ppDayHtml && el.querySelector("details")) return;
      el.__ppDayHtml = html;
      el.innerHTML = html;
      el.querySelectorAll("[data-act]").forEach(function (b) {
        b.addEventListener("click", function () {
          var a = b.getAttribute("data-act");
          if (a === "tick-pack") return tick("pack", true);
          if (a === "untick-pack") return tick("pack", false);
          if (a === "tick-connection") return tick("connection", true);
          if (a === "untick-connection") return tick("connection", false);
          if (opts.onAction) opts.onAction(a);
        });
      });
    }
    return { refresh: function (force) { var r = row(); if (r && r.status === "lobby") load(force); render(); }, render: render };
  }

  // ---------------- The Criteria tab ----------------
  function tab(el, opts) {
    var data = null, busy = false, lastAt = 0, err = null, saving = {};
    function row() { return (opts.getRow && opts.getRow()) || null; }
    function currentInject() { var r = row(); return r && r.current_inject_index >= 0 ? r.current_inject_index + 1 : null; }
    async function load(force) {
      if (busy || (!force && Date.now() - lastAt < 15000)) return;
      busy = true;
      try { data = await callNotesRpc("facilitator_criteria", { p_session_id: opts.sessionId }, opts.token); err = null; lastAt = Date.now(); }
      catch (e) { err = e.message || String(e); lastAt = Date.now(); } // a failed load waits its normal interval too
      finally { busy = false; render(); }
    }
    function list() { return (data && data.criteria) || []; }
    function forCurrent() {
      var n = currentInject();
      return n == null ? [] : list().filter(function (c) { return injectsOf(c.tested_by).indexOf(n) >= 0; });
    }
    function unratedCurrent() { return forCurrent().filter(function (c) { return !c.rating; }).length; }
    function unratedAll() { return list().filter(function (c) { return !c.rating; }).length; }
    async function rate(id, rating, note) {
      saving[id] = true;
      try {
        await callNotesRpc("facilitator_rate_criterion", { p_session_id: opts.sessionId, p_criterion: id, p_rating: rating, p_note: note }, opts.token);
        var c = list().find(function (x) { return x.id === id; });
        if (c) { c.rating = rating; c.note = note; c.rated_at = new Date().toISOString(); }
        err = null;
      } catch (e) { err = e.message || String(e); }
      saving[id] = false;
      render();
      load(true);
    }
    function item(c, cur) {
      var choices = RATINGS.map(function (k) {
        return '<button type="button" class="crit-choice r-' + k + (c.rating === k ? " on" : "") + '" aria-pressed="' + (c.rating === k) + '" data-crit="' + esc(c.id) + '" data-rating="' + k + '"' + (data.open ? "" : " disabled") + ">" + esc(T("fac.crit.rating." + k)) + "</button>";
      }).join("");
      return '<li class="crit-item' + (cur ? " current" : "") + (c.rating ? " rated" : "") + '" data-crit-id="' + esc(c.id) + '">' +
        '<div class="crit-head"><span class="crit-id">' + esc(c.id) + '</span> <span class="crit-text">' + esc(c.text) + "</span></div>" +
        '<div class="crit-meta">' + esc(T("fac.crit.testedBy", { what: c.tested_by || "—" })) + (c.ncema ? " · NCEMA " + esc(c.ncema) : "") + "</div>" + // i18n-ok: clause label
        '<div class="crit-choices" role="group" aria-label="' + esc(T("fac.crit.choicesAria", { id: c.id })) + '">' + choices + "</div>" +
        '<label class="crit-note"><span>' + esc(T("fac.crit.note")) + '</span><input type="text" maxlength="300" data-note="' + esc(c.id) + '" value="' + esc(c.note || "") + '"' + (data.open && c.rating ? "" : " disabled") + "></label></li>";
    }
    function render() {
      if (opts.onBadge) opts.onBadge(data && data.open ? unratedCurrent() : 0);
      if (!data) { el.__ppCritHtml = null; el.innerHTML = '<div class="pp-card"><h2>' + esc(T("fac.crit.heading")) + '</h2><p class="pp-hint">' + esc(err ? T("fac.crit.loadFailed", { error: err }) : T("fac.common.loading")) + "</p></div>"; return; }
      var all = list(), n = currentInject();
      var cur = forCurrent(), curIds = cur.map(function (c) { return c.id; });
      var rest = all.filter(function (c) { return curIds.indexOf(c.id) < 0; });
      var areas = [];
      rest.forEach(function (c) { var a = c.area || T("fac.crit.otherArea"); if (areas.indexOf(a) < 0) areas.push(a); });
      var rated = all.length - unratedAll();
      var head = '<div class="pp-card crit-top"><h2>' + esc(T("fac.crit.heading")) + "</h2>" +
        '<p class="pp-hint">' + esc(T("fac.crit.sub")) + "</p>" +
        '<p class="crit-count">' + esc(T("fac.crit.count", { rated: rated, total: all.length })) + (data.is_trial ? ' <span class="crit-trial">' + esc(T("fac.crit.trial")) + "</span>" : "") + "</p>" +
        (data.open ? "" : '<p class="crit-closed" role="status">' + esc(data.closed_reason || "") + "</p>") +
        (err ? '<p class="pp-hint" role="alert">' + esc(err) + "</p>" : "") + "</div>";
      if (!all.length) { el.__ppCritHtml = null; el.innerHTML = head + '<div class="pp-card"><p class="pp-hint">' + esc(T("fac.crit.none")) + "</p></div>"; return; }
      var html = head;
      if (n != null) {
        html += '<div class="pp-card crit-group current"><h3>' + esc(T("fac.crit.thisInject", { number: n })) + "</h3>" +
          (cur.length ? '<ul class="crit-list">' + cur.map(function (c) { return item(c, true); }).join("") + "</ul>" : '<p class="pp-hint">' + esc(T("fac.crit.noneThisInject")) + "</p>") + "</div>";
      }
      areas.forEach(function (a) {
        var items = rest.filter(function (c) { return (c.area || T("fac.crit.otherArea")) === a; });
        html += '<div class="pp-card crit-group"><h3>' + esc(a) + "</h3><ul class=\"crit-list\">" + items.map(function (c) { return item(c, false); }).join("") + "</ul></div>";
      });
      var focus = document.activeElement && document.activeElement.getAttribute && document.activeElement.getAttribute("data-note");
      // Keep what the facilitator is typing: a timed reload must not put a half-typed note back to the saved one (build 3 finish).
      var drafts = {}, caret = null;
      el.querySelectorAll("[data-note]").forEach(function (inp) {
        var id = inp.getAttribute("data-note"), c = list().find(function (x) { return x.id === id; });
        if (c && inp.value !== (c.note || "")) drafts[id] = inp.value;
        if (id === focus) { try { caret = [inp.selectionStart, inp.selectionEnd]; } catch (e) { caret = null; } }
      });
      if (html === el.__ppCritHtml && !Object.keys(drafts).length && el.querySelector(".crit-top")) return;
      el.__ppCritHtml = html;
      el.innerHTML = html;
      Object.keys(drafts).forEach(function (id) { var inp = el.querySelector('[data-note="' + id + '"]'); if (inp && !inp.disabled) inp.value = drafts[id]; });
      el.querySelectorAll("[data-rating]").forEach(function (b) {
        b.addEventListener("click", function () {
          var id = b.getAttribute("data-crit"), k = b.getAttribute("data-rating");
          var c = list().find(function (x) { return x.id === id; });
          if (!c || saving[id]) return;
          rate(id, c.rating === k ? null : k, c.rating === k ? null : (c.note || null));
        });
      });
      el.querySelectorAll("[data-note]").forEach(function (inp) {
        inp.addEventListener("change", function () {
          var id = inp.getAttribute("data-note"); var c = list().find(function (x) { return x.id === id; });
          if (c && c.rating) rate(id, c.rating, inp.value.trim() || null);
        });
      });
      if (focus) { var back = el.querySelector('[data-note="' + focus + '"]'); if (back) { back.focus(); if (caret) try { back.setSelectionRange(caret[0], caret[1]); } catch (e) {} } }
    }
    return {
      refresh: function (force) { var r = row(); if (r && r.status !== "lobby") load(force); else { data = null; if (opts.onBadge) opts.onBadge(0); el.__ppCritHtml = null; el.innerHTML = '<div class="pp-card"><h2>' + esc(T("fac.crit.heading")) + '</h2><p class="pp-hint">' + esc(T("fac.crit.fromStart")) + "</p></div>"; } },
      unrated: function () { return data && data.open && !data.is_trial ? { unrated: unratedAll(), total: list().length } : null; },
    };
  }

  window.PPCriteria = { dayPanel: dayPanel, tab: tab, injectsOf: injectsOf };
})();
