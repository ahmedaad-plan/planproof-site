// PPMedia — W6a (2 November 2026): the briefing videos before Start, the inject
// narration and the newsroom clips ("Marsa News"). Design:
// planproof-exercise-player/w6-design.md §4.4; scripts and look:
// w6-video-scripts.md §1, §4, §5.
//
// Files live in the public Supabase bucket "exercise-media" (the same
// project the exercise already depends on). Narration and clips of an inject
// reach a page only once the inject has been played (player_session), like
// the inject text. Nothing here ever calls Azure or HeyGen.
//
// Three pieces, each failing quietly back to what the room had before W6:
//  - briefing(root, opts): the briefing player — no scrub bar, "watched" only
//    when the video reaches its end without skipping, the position kept for a
//    reload; reports ready / playing / watched / failed.
//  - narrate(url, opts): the inject's sound at full volume for 3 s, down to
//    20 % over 1 s, the narration, then the sound fades out over 2 s.
//  - clip(opts): a full-screen newsroom clip with the Marsa News layer drawn
//    OVER the video by the page (channel bug, the permanent "Exercise
//    simulation" label, the band and headline, the ticker, the clock, the end
//    card) — the label can never be missing from a clip.
(function () {
  "use strict"; // i18n-ok: a directive, not wording

  const BASE = `${SUPABASE_URL}/storage/v1/object/public/exercise-media/`;
  const url = (path) => (path ? BASE + String(path).split("/").map(encodeURIComponent).join("/") : null);
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: no resume */ } },
  };

  // ---------- the briefing player ----------
  // opts: { sessionId, run, role: "participant"|"observer", lang, files (row.briefing.files),
  //         small (720p file), captions (bool), langToggle (bool), fullscreen (bool),
  //         playedAt (a key: a new value restarts), onState(state, position), onWatched(lang) }
  function briefing(root, opts) {
    const key = `pp_brief_${opts.sessionId}_${opts.run}_${opts.role}_${opts.playedAt || "self"}`;
    const saved = store.get(key) || {};
    let lang = saved.lang || opts.lang || "en";
    let state = saved.watched ? "watched" : "none";
    let position = saved.position || 0;
    let captions = opts.captions !== false;
    let lastGood = 0;
    let programmatic = false;
    let triedSmall = false;
    const report = () => { if (opts.onState) opts.onState(state, Math.round(position)); };
    const has = (l) => !!(opts.files && opts.files[opts.role] && opts.files[opts.role][l]);

    const box = el("div", "pp-brief" + (opts.fullscreen ? " full" : ""));
    box.setAttribute("data-state", state);
    const title = el("div", "pp-brief-title", T(opts.role === "observer" ? "media.brief.titleObserver" : "media.brief.titleParticipant"));
    const frame = el("div", "pp-brief-frame");
    const video = document.createElement("video");
    // The captions file lives on the PlanProof database's storage (another
    // address). A browser loads a captions track from another address only
    // when the video asks for it this way; without it the captions never
    // appeared in a real browser (found 5 November 2026, player move).
    video.crossOrigin = "anonymous";
    video.setAttribute("playsinline", "");
    video.preload = "auto";
    video.className = "pp-brief-video";
    const bar = el("div", "pp-brief-bar");
    const playBtn = el("button", "pp-brief-play", T("media.brief.play"));
    playBtn.type = "button";
    const time = el("span", "pp-brief-time");
    const ccBtn = el("button", "pp-brief-cc");
    ccBtn.type = "button";
    const langBox = el("span", "pp-brief-langs");
    const msg = el("div", "pp-brief-msg");
    msg.setAttribute("role", "status");
    bar.append(playBtn, time, ccBtn, langBox);
    frame.append(video);
    box.append(title, frame, bar, msg);
    root.replaceChildren(box);

    function src(l, small) {
      const name = `briefing/${opts.role}-${l}${small ? "-720" : ""}.mp4`;
      return url(name);
    }
    function load() {
      triedSmall = false;
      video.innerHTML = "";
      video.src = src(lang, !!opts.small);
      const tr = document.createElement("track");
      tr.kind = "captions";
      tr.srclang = lang;
      tr.label = T(lang === "ar" ? "media.brief.langAr" : "media.brief.langEn");
      tr.src = url(`briefing/${opts.role}-${lang}.vtt`);
      tr.default = true;
      video.appendChild(tr);
      video.load();
      setCaptions(captions);
      drawLangs();
    }
    function setCaptions(on) {
      captions = on;
      for (const t of video.textTracks) t.mode = on ? "showing" : "hidden";
      ccBtn.textContent = T(on ? "media.brief.captionsOn" : "media.brief.captionsOff");
      ccBtn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    function drawLangs() {
      langBox.innerHTML = "";
      if (!opts.langToggle) return;
      for (const l of ["en", "ar"]) {
        if (!has(l)) continue;
        const b = el("button", "pp-brief-lang" + (l === lang ? " sel" : ""), T(l === "ar" ? "media.brief.langAr" : "media.brief.langEn"));
        b.type = "button";
        b.lang = l;
        b.disabled = state === "playing";
        b.addEventListener("click", () => { if (l === lang) return; lang = l; position = 0; lastGood = 0; store.set(key, { lang, position: 0 }); setState("none"); load(); });
        langBox.append(b);
      }
    }
    function setState(s) {
      state = s;
      box.setAttribute("data-state", s);
      playBtn.textContent = T(s === "playing" ? "media.brief.pause" : s === "watched" ? "media.brief.watchAgain" : "media.brief.play");
      msg.textContent = s === "watched" ? T("media.brief.watched") : s === "failed" ? T("media.brief.failed") : "";
      drawLangs();
      report();
    }
    function drawTime() { time.textContent = T("media.brief.time", { now: fmt(video.currentTime), total: fmt(video.duration || 0) }); }

    video.addEventListener("loadeddata", () => {
      if (position > 1 && state !== "watched") { programmatic = true; video.currentTime = position; lastGood = position; }
      if (state === "none") setState("ready");
      drawTime();
    });
    video.addEventListener("timeupdate", () => {
      if (!programmatic && video.currentTime > lastGood + 2.5) { programmatic = true; video.currentTime = lastGood; return; }
      lastGood = Math.max(lastGood, video.currentTime);
      position = video.currentTime;
      drawTime();
      if (Math.floor(position) % 2 === 0) store.set(key, { lang, position, watched: state === "watched" });
    });
    // No scrub bar; a skip attempted another way is put back.
    video.addEventListener("seeking", () => {
      if (programmatic) return;
      if (video.currentTime > lastGood + 1) { programmatic = true; video.currentTime = lastGood; }
    });
    video.addEventListener("seeked", () => { programmatic = false; });
    video.addEventListener("play", () => setState("playing"));
    video.addEventListener("pause", () => { if (state === "playing" && !video.ended) setState("ready"); });
    video.addEventListener("ended", () => {
      position = video.duration || position;
      store.set(key, { lang, position: 0, watched: true });
      lastGood = 0;
      setState("watched");
      if (opts.onWatched) opts.onWatched(lang);
    });
    video.addEventListener("error", () => {
      // The 720p copy missing: try the full one before giving up.
      if (opts.small && !triedSmall) { triedSmall = true; video.src = src(lang, false); video.load(); return; }
      setState("failed");
    });
    playBtn.addEventListener("click", () => {
      if (state === "playing") { video.pause(); return; }
      if (state === "watched") { programmatic = true; video.currentTime = 0; lastGood = 0; }
      start();
    });
    ccBtn.addEventListener("click", () => setCaptions(!captions));

    function start() {
      const p = video.play();
      if (p && p.catch) p.catch(() => { setState(state === "watched" ? "watched" : "ready"); msg.textContent = T("media.brief.tapToPlay"); });
    }
    if (!has(lang)) { const other = lang === "en" ? "ar" : "en"; if (has(other)) lang = other; }
    load();
    setState(state);
    return {
      el: box,
      play: start,
      stop() { try { video.pause(); } catch { /* nothing */ } },
      state: () => state,
      position: () => Math.round(position),
      lang: () => lang,
      destroy() { try { video.pause(); video.removeAttribute("src"); video.load(); } catch { /* gone */ } box.remove(); },
    };
  }

  // ---------- narration ----------
  // Inject sound full for 3 s → 20 % over 1 s → narration → the sound fades out
  // over 2 s. Returns { stop() }. opts: { hasSfx, onStatus(text), onFail() }.
  let current = null;
  function stopAll() {
    if (current) { try { current.stop(); } catch { /* already stopped */ } current = null; }
  }
  function narrate(src, opts) {
    stopAll();
    opts = opts || {};
    const audio = new Audio(src);
    audio.preload = "auto";
    let timers = [];
    let stopped = false;
    const later = (ms, fn) => timers.push(setTimeout(fn, ms));
    const job = {
      audio,
      stop() { stopped = true; timers.forEach(clearTimeout); timers = []; try { audio.pause(); } catch { /* fine */ } },
    };
    current = job;
    const begin = () => {
      if (stopped) return;
      audio.play().then(() => { if (opts.onStatus) opts.onStatus(T("media.status.narrating")); }).catch(() => fail());
    };
    const fail = () => {
      if (stopped) return;
      if (typeof sfxFade === "function") sfxFade(0.8, 300);
      if (opts.onFail) opts.onFail();
    };
    audio.addEventListener("error", fail);
    audio.addEventListener("ended", () => { if (!stopped && typeof sfxFadeOut === "function") sfxFadeOut(2000); });
    if (opts.hasSfx) {
      later(3000, () => { if (typeof sfxFade === "function") sfxFade(0.2 * 0.8, 1000); });
      later(4000, begin);
    } else {
      later(500, begin);
    }
    return job;
  }

  // ---------- the newsroom clip ----------
  // A short synthesised broadcast sting (no library track): four notes for
  // BREAKING, two for UPDATE, none for LIVE.
  function sting(variant) {
    const notes = variant === "breaking" ? [523.25, 659.25, 783.99, 1046.5] : variant === "update" ? [659.25, 987.77] : [];
    if (!notes.length) return 0;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const t0 = ctx.currentTime + 0.05;
      notes.forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = "triangle"; o.frequency.value = f;
        const at = t0 + i * 0.22;
        g.gain.setValueAtTime(0.0001, at);
        g.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, at + (i === notes.length - 1 ? 0.55 : 0.2));
        o.connect(g).connect(ctx.destination);
        o.start(at); o.stop(at + 0.6);
      });
      setTimeout(() => ctx.close().catch(() => {}), 2000);
    } catch { /* no audio: the band still wipes in */ }
    return 1200;
  }

  // opts: { clip: { path, duration, cues }, video: { variant, headline, headline2, clock }, lang,
  //         closeButton (personal devices), onEnd(), onFail(), onStatus(text) }
  function clip(opts) {
    stopAll();
    const lang = opts.lang === "ar" ? "ar" : "en";
    const v = opts.video || {};
    const variant = ["breaking", "update", "live"].includes(v.variant) ? v.variant : "breaking";
    const layer = el("div", "pp-news" + (lang === "ar" ? " ar" : ""));
    layer.setAttribute("data-variant", variant);
    layer.setAttribute("role", "region");
    layer.setAttribute("aria-label", T(`media.news.bug.${lang}`));
    if (lang === "ar") layer.dir = "rtl";
    const video = document.createElement("video");
    video.setAttribute("playsinline", "");
    video.preload = "auto";
    video.src = url(opts.clip.path);
    const g = el("div", "pp-news-gfx");
    const bug = el("div", "pp-news-bug");
    bug.append(el("span", "pp-news-mark"), el("span", "pp-news-bugtext", T(`media.news.bug.${lang}`)));
    const label = el("div", "pp-news-label", T("media.news.label"));
    const clock = el("div", "pp-news-clock", v.clock ? String(v.clock) : "");
    clock.dir = "ltr";
    const band = el("div", "pp-news-band");
    const badge = el("span", "pp-news-variant", T(`media.news.variant.${variant}.${lang}`));
    const head = el("span", "pp-news-head", String(v.headline || ""));
    head.dir = "auto";
    band.append(badge, head);
    const ticker = el("div", "pp-news-ticker");
    const tick = el("div", "pp-news-tickin");
    const items = [1, 2, 3].map((n) => T(`media.news.ticker${n}.${lang}`)).join("   •   ");
    tick.textContent = `${items}   •   ${items}`;
    ticker.append(tick);
    // W6b: the end card's English and Arabic on their own lines (one line mixed the two directions badly).
    const endCard = el("div", "pp-news-end");
    String(T("media.news.end")).split(" · ").forEach((line) => { const d = el("div", null, line); d.dir = "auto"; endCard.append(d); });
    g.append(bug, label, clock, band, ticker, endCard);
    layer.append(video, g);
    if (opts.closeButton) {
      const close = el("button", "pp-news-close", T("media.news.close"));
      close.type = "button";
      close.addEventListener("click", () => finish());
      layer.append(close);
    }
    document.body.append(layer);
    let done = false, timers = [];
    const cues = (opts.clip.cues || []).filter((c) => c && c.line === 2 && v.headline2);
    function finish(failed) {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      try { video.pause(); } catch { /* fine */ }
      layer.classList.add("leaving");
      setTimeout(() => layer.remove(), 250);
      if (current === job) current = null;
      if (failed) { if (opts.onFail) opts.onFail(); } else if (opts.onEnd) opts.onEnd();
    }
    video.addEventListener("timeupdate", () => {
      for (const c of cues) if (video.currentTime >= c.at && head.textContent !== String(v.headline2)) {
        head.textContent = String(v.headline2);
        band.classList.remove("swap"); void band.offsetWidth; band.classList.add("swap");
      }
      const left = (video.duration || 0) - video.currentTime;
      layer.classList.toggle("ending", !!video.duration && left <= 2);
    });
    video.addEventListener("ended", () => { layer.classList.add("ending"); timers.push(setTimeout(() => finish(false), 2000)); });
    video.addEventListener("error", () => finish(true));
    const job = { stop: () => finish(false), layer, video };
    current = job;
    const wait = sting(variant);
    layer.classList.add("opening");
    timers.push(setTimeout(() => {
      layer.classList.remove("opening");
      const p = video.play();
      if (opts.onStatus) opts.onStatus(T("media.status.clip"));
      if (p && p.catch) p.catch(() => finish(true));
    }, wait || 300));
    return job;
  }

  window.PPMedia = { url, briefing, narrate, clip, stopAll, fmt };
})();
