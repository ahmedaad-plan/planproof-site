#!/usr/bin/env node
// Makes the 1200×627 share images used when an Insights article is posted on
// LinkedIn (or any site that reads og:image): insights/<slug>/card.png, plus
// insights/card.png for the index. Run after adding an article:
//
//   FONT_DIR=/path/to/fonts node tools/make-insight-cards.mjs
//   node tools/build-insights.mjs        (picks the new images up)
//
// Needs Playwright (Chromium). FONT_DIR holds SpaceGrotesk[wght].ttf and
// IBMPlexSans[wdth,wght].ttf (from github.com/google/fonts, ofl/…); without it
// the fonts are loaded from Google Fonts, which needs internet access.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART_DIR = path.join(ROOT, "insights", "articles");
const FONT_DIR = process.env.FONT_DIR || "";

function field(text, key) {
  const m = text.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!m) return "";
  const v = m[1].trim();
  return v.startsWith('"') ? JSON.parse(v) : v;
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function fontCss() {
  if (FONT_DIR) {
    const f = (n) => "data:font/ttf;base64," + fs.readFileSync(path.join(FONT_DIR, n)).toString("base64");
    return `@font-face{font-family:"Space Grotesk";src:url(${f("SpaceGrotesk[wght].ttf")});font-weight:300 700}
@font-face{font-family:"IBM Plex Sans";src:url(${f("IBMPlexSans[wdth,wght].ttf")});font-weight:100 700}`;
  }
  return `@import url("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@700&family=IBM+Plex+Sans:wght@500&display=block");`;
}

function cardHtml({ topic, title }) {
  const size = title.length > 78 ? 50 : title.length > 58 ? 56 : 64;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
${fontCss()}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:627px;background:#10151b;color:#f2f3f5;font-family:"IBM Plex Sans",sans-serif;position:relative;overflow:hidden}
.shield{position:absolute;right:-70px;top:40px;width:560px;height:560px;opacity:.07}
.top{position:absolute;left:72px;top:58px;display:flex;align-items:center;gap:14px;font:700 34px "Space Grotesk"}
.top svg{width:50px;height:50px}
.proof{color:#d84a3a}
.body{position:absolute;left:72px;right:150px;top:178px}
.topic{font:500 26px "IBM Plex Sans";color:#e8705f;margin-bottom:18px}
h1{font:700 ${size}px/1.1 "Space Grotesk";letter-spacing:-.015em}
.foot{position:absolute;left:72px;right:72px;bottom:52px;display:flex;justify-content:space-between;font:500 22px "IBM Plex Sans";color:#9aa5b1}
.bar{position:absolute;left:0;right:0;bottom:0;height:8px;background:#d84a3a}
</style></head><body>
<svg class="shield" viewBox="0 0 52 52"><path d="M26 4 L45 11 V24 C45 36 37 44 26 48 C15 44 7 36 7 24 V11 Z" fill="none" stroke="#fff" stroke-width="1.2"/><path d="M14 24 Q20 24 22 30 Q24 36 30 30 L38 20" fill="none" stroke="#d84a3a" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
<div class="top"><svg viewBox="0 0 52 52"><path d="M26 4 L45 11 V24 C45 36 37 44 26 48 C15 44 7 36 7 24 V11 Z" fill="none" stroke="#f2f3f5" stroke-width="2"/><path d="M14 24 Q20 24 22 30 Q24 36 30 30 L38 20" fill="none" stroke="#d84a3a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>Plan<span class="proof">Proof</span></span></div>
<div class="body">${topic ? `<div class="topic">${esc(topic)}</div>` : ""}<h1>${esc(title)}</h1></div>
<div class="foot"><span>plan-proof.com/insights</span><span>Business continuity exercises · UAE and GCC</span></div>
<div class="bar"></div>
</body></html>`;
}

const cards = [{ out: "insights/card.png", topic: "Insights", title: "Plain answers to business continuity and crisis management exercise questions" }];
for (const f of fs.readdirSync(ART_DIR).filter((n) => n.endsWith(".md"))) {
  const t = fs.readFileSync(path.join(ART_DIR, f), "utf8");
  cards.push({ out: `insights/${field(t, "slug")}/card.png`, topic: field(t, "topic"), title: field(t, "title") });
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 627 } });
for (const c of cards) {
  await page.setContent(cardHtml(c), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const out = path.join(ROOT, c.out);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log("wrote", c.out);
}
await browser.close();
