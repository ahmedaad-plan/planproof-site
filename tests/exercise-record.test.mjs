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
