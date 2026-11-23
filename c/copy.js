// W8 (11 November 2026) — the CLIENT COPY of a scenario version, drawn the same
// way on the client page (plan-proof.com/c/<token>) and on the admin page
// ("View client copy"). Design: w8-design.md D.2.
//
// Two locks keep facilitator material out:
//   1. the database sends only the allow-listed fields (private.client_copy);
//   2. this file reads only these named fields too (an allow-list again), so a
//      field that ever slipped through would still never be drawn.
// Every text is escaped. No field outside ALLOWED is ever read.
(function (root) {
  "use strict";
  const ALLOWED = Object.freeze({
    top: ["label", "eyebrow", "subtitle", "briefTitle", "briefDesc", "language", "version", "versionNote", "format", "teams", "objectives", "injects", "debriefQuestions"],
    format: ["lengthMinutes", "breakMinutes", "debriefMinutes", "injectsEndMinute", "scenarioClock"],
    inject: ["time", "minute", "durationMinutes", "team", "title", "deliveredAs", "message", "questions", "task", "socialPosts", "readAloud", "newsClip"],
    task: ["type", "label", "text", "bilingual"],
    post: ["platform", "name", "handle", "text", "stats"],
  });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const para = (s) => String(s == null ? "" : s).split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const pick = (obj, keys) => { const o = {}; if (obj && typeof obj === "object") keys.forEach((k) => { if (obj[k] != null) o[k] = obj[k]; }); return o; };
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
  const AS = { call: "Phone call", email: "Email", news: "News report", chat: "Chat message", social: "Social media", message: "Message", memo: "Memo", radio: "Radio", sms: "Text message", visit: "Visit" };

  // Live-experience (23 Nov 2026, Ahmed's approved wording): the sponsor reads a
  // script, so the copy says plainly how it is played on the day. Fixed text only —
  // nothing from the scenario goes into LIVE (the leak test checks the rest).
  const LIVE_URL = "https://plan-proof.com/live-example";
  const LIVE = Object.freeze({
    title: "This is the script, not the experience.",
    body: "This page lists, in order, the messages your teams will receive, so that you can check the facts, names and timings. On the day, the exercise is played live: each message appears on the room screen and on every participant\u2019s phone with a countdown, a sound announces it, a voice reads it aloud, and news items arrive as short video clips with a presenter. Your teams answer on their phones, under time pressure.",
    button: "See an example of a live exercise",
    voiceOff: "If you prefer no voice for a sensitive exercise, tell us and we switch it off.",
    news: "On the day: a news clip on the room screen \u2014 a presenter reads it, with sound.",
    quiet: "On the day: shown on the screen and phones only \u2014 not read aloud. The facilitator warns the room first.",
    call: "On the day: a phone call \u2014 a voice reads it aloud on the room screen.",
  });
  // An email, a text message, a memo… → "On the day: an email on the room screen and every phone — a voice reads it aloud."
  const ON_SCREEN = { email: "an email", news: "a news report", sms: "a text message", memo: "a memo", chat: "a chat message", message: "a message", social: "social media posts", radio: "a radio message", visit: "a visit" };
  function onTheDay(i) {
    if (i.readAloud === false) return LIVE.quiet;
    if (i.newsClip === true) return LIVE.news;
    if (i.deliveredAs === "call") return LIVE.call;
    return `On the day: ${ON_SCREEN[i.deliveredAs] || "a message"} on the room screen and every phone \u2014 a voice reads it aloud.`;
  }
  function liveBox() {
    return `<section class="cc-box cc-live"><h2>${esc(LIVE.title)}</h2><p>${esc(LIVE.body)}</p>` +
      `<p class="cc-live-link"><a class="cc-live-btn" href="${LIVE_URL}" target="_blank" rel="noopener">${esc(LIVE.button)}</a> <span class="cc-live-url">\u2014 plan-proof.com/live-example</span></p>` +
      `<p class="cc-live-small">${esc(LIVE.voiceOff)}</p></section>`;
  }

  function formatLine(f, teams, injects) {
    const parts = [];
    if (f.lengthMinutes) parts.push(`${f.lengthMinutes} minutes${f.breakMinutes ? `, including a ${f.breakMinutes}-minute break` : ", no break"}`);
    if (injects) parts.push(`${injects} inject${injects === 1 ? "" : "s"}${f.injectsEndMinute ? ` over ${f.injectsEndMinute} minutes` : ""}`);
    if (f.debriefMinutes) parts.push(`then a ${f.debriefMinutes}-minute debrief`);
    return parts.join(" · ");
  }

  // payload: what client_page / admin_client_copy return ({ copy, organisation, version_no, … }).
  // Returns an HTML string (the client page and the admin page put it in the page).
  function renderHtml(payload) {
    const p = payload && typeof payload === "object" ? payload : {};
    const c = pick(p.copy, ALLOWED.top);
    const f = pick(c.format, ALLOWED.format);
    const injects = arr(c.injects).map((i) => pick(i, ALLOWED.inject));
    const teams = arr(c.teams).map(str).filter(Boolean);
    const out = [];
    out.push(`<header class="cc-head">`,
      c.eyebrow ? `<div class="cc-eyebrow">${esc(c.eyebrow)}</div>` : "",
      `<h1 class="cc-title">${esc(c.label || "Exercise scenario")}</h1>`,
      c.subtitle ? `<div class="cc-sub">${esc(c.subtitle)}</div>` : "",
      `</header>`);
    out.push(liveBox());
    if (c.versionNote) out.push(`<section class="cc-box cc-changed"><h2>What changed in this version</h2>${para(c.versionNote)}</section>`);
    out.push(`<section class="cc-sec"><h2>The situation</h2>`, c.briefTitle ? `<p class="cc-lead">${esc(c.briefTitle)}</p>` : "", c.briefDesc ? para(c.briefDesc) : "", `</section>`);
    const fl = formatLine(f, teams, injects.length);
    if (fl || teams.length || f.scenarioClock) {
      out.push(`<section class="cc-sec"><h2>Format</h2><dl class="cc-facts">`,
        fl ? `<dt>Length</dt><dd>${esc(fl)}</dd>` : "",
        f.scenarioClock ? `<dt>Scenario clock</dt><dd>${esc(f.scenarioClock)}</dd>` : "",
        teams.length ? `<dt>Teams</dt><dd>${teams.map(esc).join(" · ")}</dd>` : "",
        `</dl></section>`);
    }
    const objs = arr(c.objectives).map((o) => (typeof o === "string" ? { text: o } : pick(o, ["text", "area"])));
    if (objs.length) out.push(`<section class="cc-sec"><h2>Objectives</h2><ol class="cc-list">`,
      ...objs.map((o) => `<li>${esc(o.text)}${o.area ? ` <span class="cc-area">${esc(o.area)}</span>` : ""}</li>`), `</ol></section>`);
    if (injects.length) {
      out.push(`<section class="cc-sec"><h2>The injects — what the room receives, in order</h2>`);
      injects.forEach((i, n) => {
        const t = pick(i.task, ALLOWED.task);
        const posts = arr(i.socialPosts).map((s) => pick(s, ALLOWED.post));
        out.push(`<article class="cc-inject">`,
          `<div class="cc-inj-top"><span class="cc-inj-no">Inject ${n + 1}</span>`,
          [str(i.time), i.durationMinutes ? `${i.durationMinutes} min to answer` : "", str(i.team), AS[i.deliveredAs] || ""].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join(""),
          `</div>`,
          `<h3>${esc(i.title)}</h3>`,
          `<div class="cc-onday">${esc(onTheDay(i))}</div>`,
          i.message ? `<div class="cc-msg">${para(i.message)}</div>` : "",
          posts.length ? `<div class="cc-posts">${posts.map((s) => `<div class="cc-post"><div class="cc-post-who">${esc([s.name, s.handle, s.platform].filter(Boolean).join(" · "))}</div>${para(s.text)}${s.stats ? `<div class="cc-post-stats">${esc(s.stats)}</div>` : ""}</div>`).join("")}</div>` : "",
          arr(i.questions).length ? `<div class="cc-q"><div class="cc-label">Questions for the team</div><ul>${arr(i.questions).map((q) => `<li>${esc(str(q))}</li>`).join("")}</ul></div>` : "",
          t.text ? `<div class="cc-task"><div class="cc-label">Task — ${esc(t.type === "DECIDE" ? "decide" : t.type === "LOCATE" ? "find" : "produce")}${t.label ? ": " + esc(t.label) : ""}${t.bilingual ? " (English and Arabic)" : ""}</div>${para(t.text)}</div>` : "",
          `</article>`);
      });
      out.push(`</section>`);
    }
    const dq = arr(c.debriefQuestions).map((q) => (q && typeof q === "object" ? str(q.text) : str(q))).filter(Boolean);
    if (dq.length) out.push(`<section class="cc-sec"><h2>Debrief questions</h2><ol class="cc-list">${dq.map((q) => `<li>${esc(q)}</li>`).join("")}</ol></section>`);
    out.push(`<footer class="cc-foot">Prepared by PlanProof for ${esc(p.organisation || "the client")} · version v${esc(p.version_no || c.version || "")} · for the exercise sponsor only — please do not share with participants.</footer>`);
    return out.join("");
  }

  const api = { renderHtml, ALLOWED, LIVE, onTheDay, LIVE_URL };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PPCopy = api;
})(typeof window !== "undefined" ? window : globalThis);
