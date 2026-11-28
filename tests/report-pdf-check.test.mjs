// Build 3 finish: the Report block's "(names removed)" check reads only the words printed on the pages.
// A real Arabic report embeds a font whose licence text reads "…the terms of the GNU General Public License";
// that made the report look readable and raised a false alarm on every real Arabic archive copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
globalThis.fflate = require("../vendor/fflate-0.8.2.js");
const html = fs.readFileSync(new URL("../admin/index.html", import.meta.url), "utf8");
const a = html.indexOf("async function pdfText(bytes) {"), b = html.indexOf("async function reportFileProblem(");
const n0 = html.indexOf("const isShortName ="), n1 = html.indexOf("// \"(names removed)\" check");
const src = html.slice(n0, n1) + html.slice(a, b) + html.slice(b, html.indexOf("\n}\n", b) + 3);
const { reportFileProblem, slotOfName } = new Function(src + "; return { reportFileProblem, slotOfName };")();
const enc = (s) => new Uint8Array([...s].map((c) => c.charCodeAt(0) & 255));
const pdf = (streams, title = "Exercise Report") => enc("%PDF-1.4\n1 0 obj << /Title (" + title + ") >> endobj\n" +
  streams.map((st, i) => `${i + 2} 0 obj << /Length ${st.length} >> stream\n${st}\nendstream endobj\n`).join("") + "%%EOF");
const page = (...lines) => "BT /F1 12 Tf 60 780 Td " + lines.map((l) => `(${l.replace(/[()]/g, (c) => "\\" + c)}) Tj`).join(" 0 -20 Td ") + " ET";
const fontLicence = "/FontFile2 % This font is free software; see the terms of the GNU General Public License";
const glyphs = "BT /F2 12 Tf <0042004F0055> Tj ET"; // a real report: letters stored as font codes, unreadable

test("a real-style archive copy (unreadable page text, font licence text inside) is not flagged", async () => {
  assert.equal(await reportFileProblem("report_archive_ar", { name: "X-Report-AR-v1.0-ARCHIVE.pdf" }, pdf([fontLicence, glyphs])), null);
});
test("a readable archive copy with (names removed) is accepted", async () => {
  assert.equal(await reportFileProblem("report_archive_en", { name: "X-Report-EN-v1.0-ARCHIVE.pdf" }, pdf([page("Exercise report", "Attendance: (names removed)")])), null);
});
test("a readable archive copy with a name in it is flagged", async () => {
  assert.match(await reportFileProblem("report_archive_ar", { name: "X-Report-AR-v1.0-ARCHIVE.pdf" }, pdf([page("Exercise report", "Attendance: Test Person")])), /names removed/);
});
test("an archive slot without -ARCHIVE in the name is flagged; a client slot with it is flagged", async () => {
  assert.match(await reportFileProblem("report_archive_en", { name: "X-Report-EN-v1.0.pdf" }, pdf([glyphs])), /ARCHIVE/);
  assert.match(await reportFileProblem("report_client_en", { name: "X-Report-EN-v1.0-ARCHIVE.pdf" }, pdf([glyphs])), /ARCHIVE copy/);
});
test("the file's title alone does not make a PDF readable", async () => {
  assert.equal(await reportFileProblem("report_archive_en", { name: "X-EN-ARCHIVE.pdf" }, pdf([glyphs], "The exercise report")), null);
});

// ---- Fix 68 (26 Nov 2026): the short report has its own two slots ----
test("68: the page sorts the six files by name — -Summary- = short, plain = full, -ARCHIVE = archive", () => {
  assert.equal(slotOfName("SIFC-Exercise-Report-Summary-EN-v1.0.pdf"), "report_short_en");
  assert.equal(slotOfName("SIFC-Exercise-Report-Summary-AR-v1.0.pdf"), "report_short_ar");
  assert.equal(slotOfName("SIFC-Exercise-Report-EN-v1.0.pdf"), "report_client_en");
  assert.equal(slotOfName("SIFC-Exercise-Report-AR-v1.0.pdf"), "report_client_ar");
  assert.equal(slotOfName("SIFC-Exercise-Report-EN-v1.0-ARCHIVE.pdf"), "report_archive_en");
  assert.equal(slotOfName("SIFC-Exercise-Report-AR-v1.0-ARCHIVE.pdf"), "report_archive_ar");
  assert.equal(slotOfName("Summary-signoff.pdf"), "signoff");
});
test("68: a full report in a short slot (or the other way round) asks first", async () => {
  assert.match(await reportFileProblem("report_short_en", { name: "X-Exercise-Report-EN-v1.0.pdf" }, pdf([glyphs])), /SHORT report/);
  assert.match(await reportFileProblem("report_client_en", { name: "X-Exercise-Report-Summary-EN-v1.0.pdf" }, pdf([glyphs])), /FULL report/);
  assert.equal(await reportFileProblem("report_short_ar", { name: "X-Exercise-Report-Summary-AR-v1.0.pdf" }, pdf([glyphs])), null);
  assert.equal(await reportFileProblem("report_client_ar", { name: "X-Exercise-Report-AR-v1.0.pdf" }, pdf([glyphs])), null);
});
