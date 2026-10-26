// W5 — the exercise record builder (admin/exercise-record.js).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const R = require("../admin/exercise-record.js");
const sample = () => JSON.parse(JSON.stringify(require("./fixtures/exercise-record-sample.json")));

test("group statuses: on time, after the time, draft, no response", () => {
  const rec = sample();
  assert.match(R.departmentStatus(rec, 0, "Finance").label, /^Submitted on time/);
  assert.match(R.departmentStatus(rec, 0, "IT").label, /^Submitted after the time/);
  assert.equal(R.departmentStatus(rec, 0, "Operations").code, "draft");
  assert.equal(R.departmentStatus(rec, 3, "Finance").code, "none");
});

test("late-department rule: not required for injects it missed, counted afterwards", () => {
  const rec = sample();
  assert.equal(R.departmentStatus(rec, 0, "HR").code, "not_required_late"); // started before HR was added
  assert.equal(R.departmentStatus(rec, 2, "HR").code, "not_required_late"); // running when HR was added
  assert.equal(R.departmentStatus(rec, 3, "HR").code, "on_time");           // started afterwards, addressed to all
});

test("individual task: only participants registered before it started are counted", () => {
  const st = R.departmentStatus(sample(), 1, "Finance");
  assert.equal(st.n, 2);
  assert.equal(st.onTime, 1);
  assert.equal(st.drafts, 1);
  assert.match(st.label, /1 joined after it started \(not counted\)/);
});

test("observer departments are not exercise departments", () => {
  assert.deepEqual(R.departments(sample()), ["Finance", "IT", "Operations", "HR"]);
});

test("text: names only in the participants list, never next to answers or notes", () => {
  const rec = sample();
  const text = R.buildText(rec);
  const after = text.split("2. INJECTS AND RESPONSES")[1];
  for (const a of rec.attendees) {
    assert.ok(!after.includes(`${a.first_name} ${a.family_name}`), `${a.first_name} appears after section 1`);
  }
  assert.match(text, /Operations \| Rashid Nasser \| Ops Supervisor \| Remote/);
  assert.match(text, /hybridLimitationNote/);
});

test("text: survey box for the report and internal part kept apart", () => {
  const text = R.buildText(sample());
  const a = text.split("A. FOR THE REPORT")[1].split("B. INTERNAL")[0];
  assert.match(a, /Realistic: 100% agree/);
  assert.match(a, /Technical problems: 1 of 3/);
  assert.ok(!a.includes("NPS") && !a.includes("Very real"));
  assert.match(text.split("B. INTERNAL")[1], /NPS 67/);
});

test("text: warnings when notes or survey are open, or the exercise is not linked", () => {
  const rec = sample();
  rec.readiness.notes_open = true; rec.survey.open = true; rec.request = null; rec.client = null;
  const w = R.warnings(rec);
  assert.equal(w.length, 3);
  assert.match(R.buildText(rec), /WARNINGS/);
  assert.equal(R.fileBase(rec), "unlinked-11111111");
});

test("text: an inject not played is listed as not played", () => {
  const rec = sample();
  delete rec.session.inject_started_log["3"];
  const text = R.buildText(rec);
  assert.match(text, /INJECT 4 of 4 — Media call\n  NOT PLAYED/);
  assert.ok(R.warnings(rec).some((x) => /1 inject was not played/.test(x)));
});

test("attachments get unique, safe names in the zip", () => {
  const rec = sample();
  rec.submissions[0].attachments = [{ path: "x/0/Finance/1-a.pdf", filename: "plan.pdf" }, { path: "x/0/Finance/2-a.pdf", filename: "plan.pdf" }, { path: "x/0/Finance/3", filename: "../../etc/passwd" }];
  const names = R.attachmentEntries(rec).map((a) => a.zipName);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length);
  assert.ok(names.includes("attachments/inject-01/Finance/plan (2).pdf"));
  assert.ok(names.every((n) => !n.includes("..") || /_\.\._/.test(n)) && names.every((n) => n.split("/").length === 4 || n.split("/").length === 5));
});

test("counts carry no names or answers", () => {
  const c = R.counts(sample());
  assert.deepEqual(Object.keys(c).sort(), ["answers", "attachments", "injects_played", "injects_total", "notes", "observers", "participants", "run", "survey_responses"]);
  assert.equal(c.participants, 6);
});

test("manifest lists every file with its fingerprint", () => {
  const m = R.manifestText(sample(), [{ name: "a.txt", size: 3, sha256: "a".repeat(64) }]);
  assert.match(m, /a{64}  3  a\.txt/);
});

test("the zip's JSON cannot tie an answer to a person (W5 audit)", () => {
  const rec = sample();
  const j = R.publicJson(rec);
  assert.ok(j.attendees.every((a) => !("id" in a) && !("joined_at" in a)));
  assert.ok(j.submissions.every((s) => !("attendee_id" in s)));
  const ind = j.submissions.filter((s) => s.individual);
  assert.equal(ind.length, 2);
  assert.ok(ind.every((s) => s.counted === true));
  rec.submissions.push({ inject_index: 1, department: "Finance", individual: true, attendee_id: rec.attendees.find((a) => a.name === "Late Joiner").id, status: "submitted", on_time: true, answer_text: "late", attachments: [] });
  assert.equal(R.publicJson(rec).submissions.filter((s) => s.individual && s.counted === false).length, 1);
  assert.ok(j.survey.comments.every((c) => !("quote_ok" in c) && c.internal_only === true));
  assert.ok(!("exercises" in j.survey));
  assert.ok(!JSON.stringify(rec).includes('"internal_only"'), "the original record is not changed");
});

test("text says 'Warnings: none' and that more-time requests do not show what was granted", () => {
  const rec = sample(); rec.readiness.notes_open = false; rec.survey.open = false;
  const t = R.buildText(rec);
  assert.match(t, /Warnings:\s+none/);
  assert.match(t, /not whether extra time was given/);
  assert.match(t, /the level it SUPPORTS \(evidence, not the rating\)/);
});
