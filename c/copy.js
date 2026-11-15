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
    inject: ["time", "minute", "durationMinutes", "team", "title", "deliveredAs", "message", "questions", "task", "socialPosts"],
    task: ["type", "label", "text", "bilingual"],
    post: ["platform", "name", "handle", "text", "stats"],
  });
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const para = (s) => String(s == null ? "" : s).split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
  const pick = (obj, keys) => { const o = {}; if (obj && typeof obj === "object") keys.forEach((k) => { if (obj[k] != null) o[k] = obj[k]; }); return o; };
  const arr = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => (typeof v === "string" || typeof v === "number" ? String(v) : "");
  const AS = { call: "Phone call", email: "Email", news: "News report", chat: "Chat message", social: "Social media", message: "Message", memo: "Memo", radio: "Radio", sms: "Text message", visit: "Visit" };

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
          i.message ? `<div class="cc-msg">${para(i.message)}</div>` : "",
          posts.length ? `<div class="cc-posts">${posts.map((s) => `<div class="cc-post"><div class="cc-post-who">${esc([s.name, s.handle, s.platform].filter(Boolean).join(" · "))}</div>${para(s.text)}${s.stats ? `<div class="cc-post-stats">${esc(s.stats)}</div>` : ""}</div>`).join("")}</div>` : "",
          arr(i.questions).length ? `<div class="cc-q"><div class="cc-label">Questions for the team</div><ul>${arr(i.questions).map((q) => `<li>${esc(str(q))}</li>`).join("")}</ul></div>` : "",
          t.text ? `<div class="cc-task"><div class="cc-label">Task — ${esc(t.type === "DECIDE" ? "decide" : "produce")}${t.label ? ": " + esc(t.label) : ""}${t.bilingual ? " (English and Arabic)" : ""}</div>${para(t.text)}</div>` : "",
          `</article>`);
      });
      out.push(`</section>`);
    }
    const dq = arr(c.debriefQuestions).map((q) => (q && typeof q === "object" ? str(q.text) : str(q))).filter(Boolean);
    if (dq.length) out.push(`<section class="cc-sec"><h2>Debrief questions</h2><ol class="cc-list">${dq.map((q) => `<li>${esc(q)}</li>`).join("")}</ol></section>`);
    out.push(`<footer class="cc-foot">Prepared by PlanProof for ${esc(p.organisation || "the client")} · version v${esc(p.version_no || c.version || "")} · for the exercise sponsor only — please do not share with participants.</footer>`);
    return out.join("");
  }

  const api = { renderHtml, ALLOWED };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PPCopy = api;
})(typeof window !== "undefined" ? window : globalThis);
