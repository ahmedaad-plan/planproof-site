// Voice notes (17 October 2026): a mic button on a typing box for Observers
// and the Facilitator. Speaking only puts words INTO the box — the person
// corrects them, and only Log / Send sends. Text is stored, never audio.
// Design: design-notes.md → "Screen layout and usability → Voice notes".
//
// Two ways to turn speech into text, chosen once per page:
//   1. PlanProof's own speech-to-text route (/api/transcribe, a Netlify
//      function that forwards a short recorded clip to the provider PlanProof
//      chose). Used when the route reports that it is configured. One
//      behaviour on every browser; our own vocabulary list.
//   2. The browser's own speech service (Web Speech API) — the fallback when
//      the route is not configured or cannot be reached. Chrome, Edge, Safari;
//      not Firefox.
// Where neither exists the button is never shown (the keyboard's own mic
// remains). A refused microphone permission hides the button with one line.
(function () {
  "use strict"; // i18n-ok: a JavaScript directive

  const SpeechRecognitionAPI = window.SpeechRecognition || window.webkitSpeechRecognition || null;
  const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  const MAX_CLIP_MS = 60000;      // one clip is at most a minute; tap again for more
  const SILENCE_STOP_MS = 30000;  // stops by itself after this long without speech
  const ROUTE = "/api/transcribe"; // i18n-ok: a path

  // Is PlanProof's own route available? Asked once per page (GET), so the
  // choice is made before the first tap and a clip is never recorded for a
  // service that is not there. Tests and a page served from elsewhere can set
  // window.PP_TRANSCRIBE = "service" | "browser" | "none" to force the choice.
  let modePromise = null;
  function mode() {
    if (modePromise) return modePromise;
    modePromise = (async () => {
      const forced = window.PP_TRANSCRIBE;
      if (forced === "service" || forced === "browser" || forced === "none") return forced;
      if (canRecord) {
        try {
          const res = await fetch(ROUTE, { method: "GET", cache: "no-store" });
          if (res.ok) {
            const info = await res.json();
            if (info && info.configured) return "service";
          }
        } catch { /* not reachable: the browser's own service, if any */ }
      }
      return SpeechRecognitionAPI ? "browser" : "none";
    })();
    return modePromise;
  }

  const MIC_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke-linecap="round"/></svg>';

  // attach(textarea, { who, labels, onText })
  //   who     { sessionId, attendeeId } for an Observer, { sessionId, facilitatorToken } for the Facilitator
  //   labels  wording from the page (through T): title, listening, working,
  //           refused, noConnection, unsupported, nothingHeard, failed, tapToSpeak
  //   onText  called after words were added (the page may autosave)
  // Returns { stop(), destroy(), element } or null when no mic is possible here.
  function attach(textarea, { who, labels, onText, vocabulary } = {}) {
    if (!textarea || textarea.dataset.ppMic) return null;
    if (!canRecord && !SpeechRecognitionAPI) return null;
    textarea.dataset.ppMic = "1";

    // Wrap the box so the button can sit in its corner.
    const wrap = document.createElement("div");
    wrap.className = "pp-micwrap";
    textarea.parentNode.insertBefore(wrap, textarea);
    wrap.appendChild(textarea);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pp-mic";
    btn.title = labels.title;
    btn.setAttribute("aria-label", labels.title);
    btn.setAttribute("aria-pressed", "false");
    btn.innerHTML = MIC_SVG;
    wrap.appendChild(btn);
    const line = document.createElement("div");
    line.className = "pp-mic-line";
    wrap.insertAdjacentElement("afterend", line);

    let state = "idle"; // idle | listening | working
    let stopFn = null;
    let hiddenForGood = false;
    const say = (text, tone) => { line.textContent = text || ""; line.className = `pp-mic-line${tone ? ` ${tone}` : ""}`; };
    const paint = () => {
      btn.classList.toggle("on", state === "listening");
      btn.classList.toggle("busy", state === "working");
      btn.setAttribute("aria-pressed", state === "listening" ? "true" : "false");
      btn.disabled = state === "working";
    };
    function addWords(text) {
      const t = String(text || "").trim();
      if (!t) return;
      const cur = textarea.value;
      textarea.value = cur ? (cur.replace(/\s+$/, "") + " " + t) : t;
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      if (onText) onText(t);
    }
    function hideForGood(text) {
      hiddenForGood = true;
      say(text, "err");
      btn.hidden = true;
      textarea.classList.add("pp-mic-gone");
    }
    function refused(err) {
      const name = err && (err.name || err.error || "");
      return /NotAllowed|PermissionDenied|not-allowed|service-not-allowed|SecurityError/i.test(String(name));
    }

    // ---- 1. PlanProof's route: record a clip, send it, add the words ----
    async function startService() {
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        if (refused(err)) hideForGood(labels.refused); else say(labels.failed, "err");
        state = "idle"; paint();
        return;
      }
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus", ""]
        .find((t) => !t || (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported(t)));
      let rec;
      try { rec = type ? new window.MediaRecorder(stream, { mimeType: type }) : new window.MediaRecorder(stream); }
      catch { rec = new window.MediaRecorder(stream); }
      const chunks = [];
      rec.addEventListener("dataavailable", (e) => { if (e.data && e.data.size) chunks.push(e.data); });
      // Silence watch: a quiet room for 30 seconds stops the clip by itself.
      let silenceTimer = null, maxTimer = null, analyser = null, ctx = null, raf = null;
      try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (Ctx) {
          ctx = new Ctx();
          analyser = ctx.createAnalyser(); analyser.fftSize = 512;
          ctx.createMediaStreamSource(stream).connect(analyser);
          const buf = new Uint8Array(analyser.fftSize);
          let lastLoud = Date.now();
          const tick = () => {
            if (state !== "listening") return;
            analyser.getByteTimeDomainData(buf);
            let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
            if (Math.sqrt(sum / buf.length) > 0.02) lastLoud = Date.now();
            if (Date.now() - lastLoud > SILENCE_STOP_MS) { stop(false); return; }
            raf = requestAnimationFrame(tick);
          };
          raf = requestAnimationFrame(tick);
        }
      } catch { /* no silence watch: the minute cap still stops it */ }
      const cleanup = () => {
        if (silenceTimer) clearTimeout(silenceTimer);
        if (maxTimer) clearTimeout(maxTimer);
        if (raf) cancelAnimationFrame(raf);
        try { stream.getTracks().forEach((t) => t.stop()); } catch {}
        try { if (ctx) ctx.close(); } catch {}
      };
      // discard = the page pressed Log / Send while the mic was still on:
      // what was already in the box is what gets sent, so the clip is dropped
      // rather than words appearing in the emptied box a moment later.
      let discarded = false;
      const stop = (discard) => { if (discard) discarded = true; if (rec.state !== "inactive") { try { rec.stop(); } catch {} } };
      maxTimer = setTimeout(() => stop(), MAX_CLIP_MS);
      stopFn = stop;
      rec.addEventListener("stop", async () => {
        cleanup();
        stopFn = null;
        if (discarded) { state = "idle"; paint(); say(labels.tapToSpeak); return; }
        const blob = new Blob(chunks, { type: rec.mimeType || type || "audio/webm" });
        if (!blob.size) { state = "idle"; paint(); say(labels.nothingHeard); return; }
        state = "working"; paint(); say(labels.working);
        try {
          const form = new FormData();
          form.append("audio", blob, "clip." + ((rec.mimeType || type || "audio/webm").includes("mp4") ? "mp4" : "webm"));
          form.append("session", who.sessionId || "");
          if (who.attendeeId) form.append("attendee", who.attendeeId);
          form.append("lang", (window.PPLang && PPLang.speechLang()) || "en-US");
          if (vocabulary) form.append("vocabulary", (typeof vocabulary === "function" ? vocabulary() : vocabulary).slice(0, 60).join("\n"));
          const headers = {};
          if (who.facilitatorToken) headers["x-facilitator-token"] = who.facilitatorToken;
          const res = await fetch(ROUTE, { method: "POST", body: form, headers });
          const out = await res.json().catch(() => ({}));
          if (!res.ok || !out || typeof out.text !== "string") {
            // PlanProof's route or its provider is down: the next tap uses
            // the browser's own speech service, where there is one (the
            // automatic fallback agreed on 17 October 2026). Nothing typed
            // or said is lost — the box is untouched.
            if (SpeechRecognitionAPI && res.status !== 403 && res.status !== 413) modePromise = Promise.resolve("browser");
            say(out && out.reason === "not_configured" ? labels.unsupported : labels.failed, "err");
          } else if (!out.text.trim()) {
            say(labels.nothingHeard);
          } else {
            addWords(out.text);
            say(labels.tapToSpeak);
          }
        } catch {
          if (SpeechRecognitionAPI) modePromise = Promise.resolve("browser");
          say(labels.noConnection, "err");
        }
        state = "idle"; paint();
      });
      rec.start(250);
      state = "listening"; paint(); say(labels.listening);
    }

    // ---- 2. The browser's own speech service -------------------------------
    function startBrowser() {
      let recognition;
      try { recognition = new SpeechRecognitionAPI(); } catch { say(labels.failed, "err"); return; }
      recognition.lang = (window.PPLang && PPLang.speechLang()) || "en-US";
      // Phones (Android Chrome, iPhone Safari) repeat earlier words in
      // "continuous" listening — Ahmed's test, 17 October 2026: "the health
      // locate the plan the health and safety team…". There, listen one
      // sentence at a time; the loop below starts the next one at once.
      const phoneLike = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "") || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent || ""));
      recognition.continuous = !phoneLike;
      recognition.interimResults = false;
      let stopped = false;
      let silenceTimer = null;
      const armSilence = () => { if (silenceTimer) clearTimeout(silenceTimer); silenceTimer = setTimeout(() => stop(), SILENCE_STOP_MS); };
      const stop = () => { stopped = true; try { recognition.stop(); } catch {} };
      stopFn = stop;
      recognition.onstart = () => { state = "listening"; paint(); say(labels.listening); armSilence(); };
      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) addWords(event.results[i][0].transcript);
        }
        armSilence();
      };
      recognition.onerror = (e) => {
        const kind = (e && e.error) || "";
        if (refused(e)) { hideForGood(labels.refused); stopped = true; }
        else if (kind === "network") { say(labels.noConnection, "err"); stopped = true; }
        else if (kind === "no-speech") { /* quiet: the silence timer handles it */ }
        else if (kind !== "aborted") { say(labels.failed, "err"); stopped = true; }
      };
      recognition.onend = () => {
        if (!stopped && state === "listening") {
          // Some browsers end continuous listening on their own after a pause;
          // carry on until the person stops it or 30 quiet seconds pass.
          try { recognition.start(); return; } catch { /* give up */ }
        }
        if (silenceTimer) clearTimeout(silenceTimer);
        stopFn = null;
        state = "idle"; paint();
        if (!hiddenForGood && !line.classList.contains("err")) say(labels.tapToSpeak);
      };
      try { recognition.start(); } catch { say(labels.failed, "err"); }
    }

    btn.addEventListener("click", async () => {
      if (state === "listening") { if (stopFn) stopFn(false); return; }
      if (state === "working") return;
      const m = await mode();
      if (m === "none") { hideForGood(labels.unsupported); return; }
      say("");
      if (m === "service") await startService(); else startBrowser();
    });
    // Listening ends when the person taps the mic again, presses Log / Send
    // (the page calls stop()), or after 30 quiet seconds — never on its own
    // while they are still talking.
    mode().then((m) => { if (m === "none") { btn.hidden = true; line.hidden = true; } else say(labels.tapToSpeak); });

    return {
      stop() { if (stopFn) stopFn(true); },
      destroy() { if (stopFn) stopFn(true); btn.remove(); line.remove(); },
      element: btn,
    };
  }

  window.PPMic = { attach, mode, available: () => canRecord || !!SpeechRecognitionAPI };
})();
