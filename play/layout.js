// Screen layout and usability (17 October 2026) — the pieces the three pages
// share: tabs (a bottom bar on a phone, a row under the top bar on a laptop)
// with badges and a remembered tab, the alert strip, "Copy link" and the QR
// codes. Design: design-notes.md → "Screen layout and usability".
//
// Nothing here carries wording: labels come from the page through T().
(function () {
  "use strict"; // i18n-ok: a JavaScript directive

  // One flexible layout: below this width the page is "a phone" (tabs at the
  // bottom, one column); from it upwards "a laptop" (tabs on top, columns).
  const LAPTOP_MIN_PX = 900;
  const laptopMedia = window.matchMedia ? window.matchMedia(`(min-width: ${LAPTOP_MIN_PX}px)`) : { matches: true, addEventListener() {} }; // i18n-ok: a media query
  const isLaptop = () => !!laptopMedia.matches;

  // ---- Tabs -------------------------------------------------------------
  // tabs({ nav, tabs: [{ id, label, panel }], storageKey, pinned, onShow })
  //   nav      the <nav> element that gets the tab buttons
  //   tabs     id (stable), label (wording from the page), panel (element)
  //   pinned   (id) => true when the panel must stay visible on a laptop
  //            (the participant's inject, the Observer's exercise view); on a
  //            laptop such a panel is never a tab
  //   storageKey  the open tab is remembered on the device for this exercise
  // Returns { show(id), current(), badge(id, count, tone), dot(id, on), refresh() }.
  function tabs({ nav, tabs: defs, storageKey, pinned, onShow }) {
    let current = null;
    const byId = {};
    defs.forEach((d) => { byId[d.id] = d; });
    const isPinned = (id) => !!(pinned && isLaptop() && pinned(id));
    const visibleTabs = () => defs.filter((d) => !isPinned(d.id));

    try { current = storageKey ? sessionStorage.getItem(storageKey) : null; } catch { current = null; }
    if (!current || !byId[current]) current = defs[0].id;

    function render() {
      const list = visibleTabs();
      if (!list.some((d) => d.id === current)) current = (list[0] || defs[0]).id;
      nav.setAttribute("role", "tablist");
      // A single tab is no choice at all (e.g. a laptop where the inject is
      // always shown beside the one other panel): no bar then.
      nav.classList.toggle("pp-tabs-none", list.length < 2);
      nav.innerHTML = (list.length < 2 ? [] : list).map((d) =>
        `<button type="button" role="tab" class="pp-tab" data-tab="${d.id}" aria-selected="${d.id === current}" aria-controls="${d.panel.id}">` +
          `<span class="pp-tab-label"></span><span class="pp-tab-badge" hidden></span><i class="pp-tab-dot" hidden></i>` +
        `</button>`).join("");
      list.forEach((d) => { const l = nav.querySelector(`[data-tab="${d.id}"] .pp-tab-label`); if (l) l.textContent = d.label; });
      defs.forEach((d) => {
        const show = isPinned(d.id) || d.id === current;
        d.panel.hidden = !show;
        d.panel.setAttribute("role", "tabpanel");
        d.panel.classList.toggle("pp-tab-current", d.id === current);
        d.panel.classList.toggle("pp-tab-pinned", isPinned(d.id));
      });
      document.body.classList.toggle("pp-laptop", isLaptop());
      Object.keys(badges).forEach((id) => paintBadge(id));
    }

    const badges = {};
    function paintBadge(id) {
      const btn = nav.querySelector(`[data-tab="${id}"]`);
      if (!btn) return;
      const b = badges[id] || {};
      const badge = btn.querySelector(".pp-tab-badge");
      const dot = btn.querySelector(".pp-tab-dot");
      const n = Number(b.count || 0);
      badge.hidden = !(n > 0);
      badge.textContent = n > 99 ? "99+" : String(n); // i18n-ok: a number
      badge.className = `pp-tab-badge${b.tone ? ` ${b.tone}` : ""}`;
      dot.hidden = !!(n > 0) || !b.dot;
    }

    function show(id, { user } = {}) {
      if (!byId[id]) return;
      if (isPinned(id)) { // on a laptop a pinned panel is always there: scroll to it
        try { byId[id].panel.scrollIntoView({ behavior: "smooth", block: "start" }); } catch {}
        return;
      }
      const changed = id !== current;
      current = id;
      try { if (storageKey) sessionStorage.setItem(storageKey, id); } catch {}
      render();
      if (changed || user) {
        window.scrollTo({ top: 0 });
        if (onShow) onShow(id);
      }
    }

    nav.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tab]");
      if (btn) show(btn.dataset.tab, { user: true });
    });
    nav.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const list = visibleTabs().map((d) => d.id);
      const i = list.indexOf(current);
      const next = list[(i + (e.key === "ArrowRight" ? 1 : list.length - 1)) % list.length];
      show(next, { user: true });
      const b = nav.querySelector(`[data-tab="${next}"]`);
      if (b) b.focus();
    });
    if (laptopMedia.addEventListener) laptopMedia.addEventListener("change", render);
    else if (laptopMedia.addListener) laptopMedia.addListener(render);

    render();
    return {
      show,
      current: () => current,
      isCurrent: (id) => current === id || isPinned(id),
      badge(id, count, tone) { badges[id] = Object.assign(badges[id] || {}, { count, tone }); paintBadge(id); },
      dot(id, on) { badges[id] = Object.assign(badges[id] || {}, { dot: !!on }); paintBadge(id); },
      refresh: render,
      isLaptop,
    };
  }

  // On a phone the bottom bar hides while a typing box has the keyboard, so
  // it never covers the box. (focusin/focusout, plus the visual viewport
  // shrinking under a software keyboard.)
  function watchKeyboard() {
    const typing = (el) => !!el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /^(text|search|number|email|tel|url)$/.test(el.type || "text")));
    const update = () => {
      const kbd = typing(document.activeElement) && !isLaptop();
      document.body.classList.toggle("pp-kbd", kbd);
    };
    // A tap on a button under the form (Submit, Log) first takes the focus
    // away from the typing box. The bar must not come back under the finger
    // before that tap has finished, or the tap lands on the bar instead of
    // the button: while a finger or mouse is down, wait for it to lift, and
    // only then (a moment after the click) bring the bar back.
    let pointerDown = false;
    document.addEventListener("pointerdown", () => { pointerDown = true; }, true);
    document.addEventListener("pointerup", () => { pointerDown = false; setTimeout(update, 350); }, true);
    document.addEventListener("pointercancel", () => { pointerDown = false; setTimeout(update, 350); }, true);
    document.addEventListener("focusin", (e) => { if (!pointerDown || typing(e.target)) update(); });
    document.addEventListener("focusout", () => { if (!pointerDown) setTimeout(update, 50); });
    if (window.visualViewport) window.visualViewport.addEventListener("resize", update);
  }

  // ---- Alert strip --------------------------------------------------------
  // alerts(root) → set([{ id, text, tone: "amber"|"red", actions: [{ label, run }] }])
  // At most three are shown; the rest fold behind one "+N" button (its
  // wording comes from the page: opts.moreLabel(n)). Re-drawn only when the
  // list actually changes, so a button being pressed is never rebuilt under
  // the finger.
  function alerts(root, opts) {
    let items = [];
    let expanded = false;
    let signature = "";
    const handlers = {};
    function draw() {
      const max = isLaptop() ? 3 : 1; // a phone shows one alert, then "+N more"
      const list = expanded ? items : items.slice(0, max);
      const more = items.length - list.length;
      root.hidden = items.length === 0;
      root.innerHTML = list.map((a, i) =>
        `<span class="pp-alert ${a.tone || "amber"}" data-alert="${a.id}"><span class="pp-alert-text"></span>${(a.actions || []).map((x, j) =>
          `<button type="button" class="pp-alert-btn" data-alert="${a.id}" data-act="${j}"></button>`).join("")}</span>`).join("") +
        (more > 0 ? `<button type="button" class="pp-alert-btn more" data-more="1"></button>` : "");
      list.forEach((a) => {
        const el = root.querySelector(`.pp-alert[data-alert="${a.id}"]`);
        if (!el) return;
        el.querySelector(".pp-alert-text").textContent = a.text;
        (a.actions || []).forEach((x, j) => { const b = el.querySelector(`[data-act="${j}"]`); if (b) b.textContent = x.label; handlers[`${a.id}|${j}`] = x.run; });
      });
      if (more > 0) root.querySelector("[data-more]").textContent = opts && opts.moreLabel ? opts.moreLabel(more) : `+${more}`;
    }
    root.addEventListener("click", (e) => {
      const more = e.target.closest("[data-more]");
      if (more) { expanded = true; signature = ""; set(items); return; }
      const btn = e.target.closest(".pp-alert-btn[data-act]");
      if (!btn) return;
      const run = handlers[`${btn.dataset.alert}|${btn.dataset.act}`];
      if (run) run();
    });
    function set(next) {
      items = next || [];
      const sig = JSON.stringify(items.map((a) => [a.id, a.tone, a.text, (a.actions || []).map((x) => x.label)]));
      if (sig === signature) { // same list: only refresh the handlers
        items.forEach((a) => (a.actions || []).forEach((x, j) => { handlers[`${a.id}|${j}`] = x.run; }));
        return;
      }
      signature = sig;
      if (items.length <= (isLaptop() ? 3 : 1)) expanded = false;
      draw();
    }
    return { set, count: () => items.length };
  }

  // ---- Copy link -----------------------------------------------------------
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; }
    } catch { /* fall through to the older way */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch { return false; }
  }

  // ---- QR codes -------------------------------------------------------------
  // Drawn by the self-hosted library (/vendor/qrcode-generator-1.4.4.js, MIT);
  // nothing is fetched from outside. Returns false when the library is missing
  // or the text is too long, so the page can fall back to the link alone.
  function qr(el, text, { cellSize = 4 } = {}) {
    try {
      if (typeof window.qrcode !== "function") return false;
      const q = window.qrcode(0, "M");
      q.addData(text);
      q.make();
      el.innerHTML = q.createSvgTag({ cellSize, margin: 0, scalable: true });
      const svg = el.querySelector("svg");
      if (svg) { svg.removeAttribute("width"); svg.removeAttribute("height"); svg.setAttribute("role", "img"); }
      return true;
    } catch { el.innerHTML = ""; return false; }
  }

  window.PPLayout = { tabs, watchKeyboard, alerts, copyText, qr, isLaptop, LAPTOP_MIN_PX };
})();
