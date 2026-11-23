// W8 — the client copy (c/copy.js). The LEAK TEST: a client page built from the
// SIFC practice-run build data never shows facilitator material — even if the
// database's own allow-list (private.client_copy, tested in supabase/w8a_tests.sql
// C4) ever let the whole file through, this page's allow-list still holds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { renderHtml, ALLOWED, LIVE, onTheDay } = require("../c/copy.js");
const full = JSON.parse(readFileSync(new URL("./fixtures/sifc-scenario-v2.json", import.meta.url), "utf8"));
const FORBIDDEN = /facilitator|expected|watch for|criterion|criteria|ground truth|groundtruth|observer|whatgoodlookslike|ifroomstalls|misinformation|script|readiness/i;
// The fixed "how it is played" texts (live box, "On the day" lines) are PlanProof's own
// words and use "script" / "facilitator" on purpose — they are taken out before the
// leak scan, which then checks everything that came from the scenario.
const scrub = (html) => html.replace(/<section class="cc-box cc-live">[\s\S]*?<\/section>/g, "").replace(/<div class="cc-onday">[^<]*<\/div>/g, "");
const visible = (html) => html.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ");

test("LEAK TEST: the whole build data, unfiltered, still draws no facilitator text", () => {
  const html = scrub(renderHtml({ copy: full, organisation: "Sareef Island Financial Centre (fictional)", version_no: 2 }));
  const m = html.match(FORBIDDEN);
  assert.equal(m, null, m && "leaked: …" + html.slice(Math.max(0, m.index - 60), m.index + 40) + "…");
  // nothing of the hidden fields' own words appears either
  for (const i of full.injects) {
    if (i.facilitator && i.facilitator.ifRoomStalls) assert.ok(!visible(html).includes(i.facilitator.ifRoomStalls.replace(/"/g, "").slice(5, 45)), "ifRoomStalls text leaked");
    for (const w of i.observerWatch || []) assert.ok(!visible(html).includes(w), "Observer watch-for leaked: " + w);
  }
  assert.ok(!html.includes(full.groundTruth.slice(20, 80)), "ground truth leaked");
  assert.ok(!html.includes(full.facilitatorNotes.slice(10, 60)), "facilitator notes leaked");
  for (const c of full.readinessCriteria) assert.ok(!html.includes(c.text.slice(0, 50)), "criterion leaked: " + c.id);
});

test("the client copy keeps what the sponsor must see", () => {
  const html = renderHtml({ copy: full, organisation: "Sareef Island Financial Centre (fictional)", version_no: 2 });
  assert.ok(html.includes("Renewal Season"));
  assert.equal((html.match(/class="cc-inject"/g) || []).length, 7, "seven injects");
  assert.ok(html.includes("Task — produce: Notice to regulated firms (English and Arabic)"));
  assert.ok(html.includes("Task — decide: Manual processing decision"));
  assert.ok(html.includes("@tower2life"), "the social post");
  assert.ok(html.includes("What changed in this version"));
  for (const q of full.debriefQuestions) assert.ok(html.includes(q.text.slice(0, 40).replace(/'/g, "&#39;")));
  assert.ok(html.includes("90 minutes, no break"));
  assert.ok(html.includes("Crisis Management Team"));
});

test("every value is escaped (a scenario cannot inject HTML into the client page)", () => {
  const html = renderHtml({ copy: { label: "<script>alert(1)</script>", injects: [{ title: "<img src=x onerror=alert(1)>", message: "a & b", questions: ["<b>q</b>"] }] }, organisation: "<i>x</i>" });
  assert.ok(!/<script>|<img |<b>q|<i>x/.test(html));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("the allow-list names no facilitator field", () => {
  const all = Object.values(ALLOWED).flat().join(" ");
  assert.ok(!/facilitator|observer|readiness|ground|script|criteria|expected|video/i.test(all), all);
});

test("live experience: the box is at the top and every inject says how it is played", () => {
  const html = renderHtml({ copy: full, organisation: "Sareef Island Financial Centre (fictional)", version_no: 2 });
  assert.ok(html.indexOf("cc-live") < html.indexOf("The situation"), "box before the situation");
  assert.ok(html.includes(LIVE.title) && html.includes("https://plan-proof.com/live-example") && html.includes("plan-proof.com/live-example"));
  assert.equal((html.match(/class="cc-onday"/g) || []).length, 7, "one On the day line per inject");
  // only fixed texts in the scrubbed parts: no scenario words inside them
  for (const m of html.match(/<div class="cc-onday">[^<]*<\/div>/g)) assert.ok(/^<div class="cc-onday">On the day: /.test(m));
});

test("On the day follows the voice rule: off = not read aloud; a clip = news; a call = phone", () => {
  assert.equal(onTheDay({ readAloud: false, newsClip: true, deliveredAs: "news" }), LIVE.quiet, "sensitive wins over a clip");
  assert.equal(onTheDay({ readAloud: true, newsClip: true, deliveredAs: "news" }), LIVE.news);
  assert.equal(onTheDay({ deliveredAs: "call" }), LIVE.call);
  assert.match(onTheDay({ deliveredAs: "news" }), /a news report on the room screen .* a voice reads it aloud/, "a news inject with no clip is read aloud, not called a clip");
  assert.match(onTheDay({ deliveredAs: "email" }), /^On the day: an email on the room screen and every phone/);
  assert.match(onTheDay({ deliveredAs: "<b>x" }), /a message/, "an unknown kind never reaches the page");
});
