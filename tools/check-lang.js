#!/usr/bin/env node
// Wording guard for the exercise player (language foundation, 13 October 2026).
// Fails (exit 1) when a player page carries wording that is not in the
// language file play/lang.js. Run by Netlify before every deploy
// (netlify.toml → build.command) and by hand: node tools/check-lang.js
//
// It checks, for play/*.html and play/*.js (not lang.js itself):
//  1. static markup: every piece of visible text sits in an element with
//     data-i18n / data-i18n-html / data-i18n-nodes, its key exists, and the English written in
//     the page is exactly the English in the language file; wording in
//     placeholder / title / aria-label / alt is listed in data-i18n-attr;
//  2. scripts: every T("key") exists; no quoted wording outside T(...);
//  3. the language file: no key is left unused.
// A line that must keep a quoted technical phrase carries the comment
// "i18n-ok: why". A block is fenced with /* i18n-off: why */ … /* i18n-on */.
// These are for code, never for wording a person reads.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PLAY = path.join(__dirname, "..", "play");
const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const quietUnused = process.argv.includes("--no-unused") || only.length > 0;

// ---------- the language file ----------
function loadEnglish() {
  const src = fs.readFileSync(path.join(PLAY, "lang.js"), "utf8");
  const store = {};
  const win = {
    location: { search: "" },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    console,
  };
  const doc = { documentElement: {}, write() {}, querySelectorAll: () => [], head: { appendChild() {} }, createElement: () => ({}) };
  vm.runInNewContext(src, { window: win, document: doc, console, URLSearchParams, Intl, Promise, store });
  return win.PPLang.packs.en;
}
const EN = loadEnglish();
const KEYS = EN.strings;
const used = new Set();
const dynamicPrefixes = new Set();
const problems = [];
const problem = (file, line, msg) => problems.push(`${file}:${line}  ${msg}`);
const norm = (s) => String(s).replace(/\s+/g, " ").trim();

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rarr: "→", larr: "←", darr: "↓", uarr: "↑", times: "×", middot: "·", bull: "•", copy: "©", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", check: "✓", cross: "✗" };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  return ENTITIES[e] !== undefined ? ENTITIES[e] : m;
});
const flat = (v) => (v && typeof v === "object" ? Object.values(v).map(String) : [String(v)]);
const keyHasEnglish = (key, text, html) => {
  if (KEYS[key] === undefined) return false;
  const want = norm(html ? text : decode(text));
  return flat(KEYS[key]).some((v) => norm(v) === want);
};

// ---------- is this quoted text wording? ----------
const PLAIN = /^[("“‘']*[A-Za-z؀-ۿ]{2,}(['’\-][A-Za-z]+)*[,.!?:;…)"”’']*$/;
function looksLikeWording(text) {
  const attrs = [];
  text.replace(/\b(title|placeholder|aria-label|alt)\s*=\s*(["'])(.*?)\2/g, (m, a, q, v) => { attrs.push(v); return m; });
  let body = text.replace(/<[^>]*>/g, " ").replace(/<[^>]*$/, " ").replace(/^[^<]*>/, (m) => (/[="]/.test(m) ? " " : m)).replace(/&[a-z#0-9]+;/gi, " ");
  for (const c of [body, ...attrs]) {
    const tokens = c.split(/[\s\u0001]+/).filter(Boolean);
    let run = 0;
    for (const tk of tokens) {
      if (PLAIN.test(tk)) { run++; if (run >= 2) return true; } else run = 0;
    }
    // a single word written as a label: "Send", "Cancel", "Online"
    if (tokens.some((tk) => /^[("“']*[A-Z][a-z]{2,}[a-z'’\-]*[,.!?:;…)"”']*$/.test(tk))) return true;
  }
  return false;
}
// Quoted text that is code, not wording.
const TECHNICAL = [
  /^[a-z-]+\s*:\s*[^;{}]+;?(\s*[a-z-]+\s*:\s*[^;{}]+;?)*$/,          // css declarations
  /^(Content-Type|Authorization|Prefer|Accept|Cache-Control|Bearer \u0001|Bearer)$/,
  /^[A-Za-z]+\/[A-Za-z0-9.+-]+$/,                                     // mime types
  /^(Enter|Escape|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Shift|Control|Alt|Meta)$/, // key names
  /^(Promise|Object|Array|String|Number|Boolean|Date|Error|NotAllowedError|AbortError|TypeError|Notification|WakeLock|Audio|Intl)$/,
  /^(SUBSCRIBED|CLOSED|TIMED_OUT|CHANNEL_ERROR)$/,
];
const CODE_BEFORE = /(console\.\w+\(|\bT\(|PPLang\.\w+\(|getElementById\(|querySelector(All)?\(|addEventListener\(|removeEventListener\(|classList\.\w+\(|className\s*[+]?=|\.closest\(|\.matches\(|\w+Attribute\(|createElement\(|new (Custom)?Event\(|Storage\.\w+\(|\.getItem\(|\.setItem\(|\.removeItem\(|searchParams\.\w+\(|params\.get\(|\.channel\(|\.on\(|\.rpc\(|typeof\s+[\w.$]+\s*[!=]==?|\bcase)\s*$/;

// ---------- a small JavaScript reader: finds quoted text ----------
function scanJs(src, file, lineOffset, isLangFile) {
  const lines = src.split("\n");
  const okLine = new Set();
  let off = false;
  lines.forEach((l, i) => {
    if (/i18n-off/.test(l)) off = true;
    if (off || /i18n-ok/.test(l)) okLine.add(i);
    if (/i18n-on\b/.test(l)) off = false;
  });
  const lineAt = (idx) => { let n = 0; for (let i = 0; i < idx; i++) if (src.charCodeAt(i) === 10) n++; return n; };
  const lits = [];
  let i = 0, prevSig = "", prevWord = "";
  const KEYWORDS_BEFORE_REGEX = /^(return|typeof|case|in|of|do|else|void|delete|throw|new|instanceof|yield|await)$/;
  function readString(q) {
    const start = i; i++;
    let out = "";
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\\") { const n = src[i + 1]; out += n === "n" ? "\n" : n === "t" ? "\t" : n === "u" ? (() => { const h = src.substr(i + 2, 4); i += 4; return String.fromCharCode(parseInt(h, 16)); })() : n; i += 2; continue; }
      if (src[i] === "\n") break;
      out += src[i++];
    }
    i++;
    lits.push({ start, text: out, kind: "s" });
  }
  function readTemplate() {
    const start = i; i++;
    let out = "";
    while (i < src.length && src[i] !== "`") {
      if (src[i] === "\\") { out += src[i + 1]; i += 2; continue; }
      if (src[i] === "$" && src[i + 1] === "{") { i += 2; out += "\u0001"; readCode(true); continue; }
      out += src[i++];
    }
    i++;
    lits.push({ start, text: out, kind: "t" });
  }
  function readCode(untilBrace) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (untilBrace && c === "}" && depth === 0) { i++; prevSig = "}"; return; }
      if (c === "{") depth++;
      if (c === "}") depth--;
      if (c === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? src.length : e + 2; continue; }
      if (c === '"' || c === "'") { readString(c); prevSig = '"'; prevWord = ""; continue; }
      if (c === "`") { readTemplate(); prevSig = '"'; prevWord = ""; continue; }
      if (c === "/") {
        const regexOk = prevSig === "" || "(,=:[!&|?{};+-*%<>~^".includes(prevSig) || KEYWORDS_BEFORE_REGEX.test(prevWord);
        if (regexOk) {
          i++; let inClass = false;
          while (i < src.length && src[i] !== "\n") {
            if (src[i] === "\\") { i += 2; continue; }
            if (src[i] === "[") inClass = true; else if (src[i] === "]") inClass = false;
            else if (src[i] === "/" && !inClass) break;
            i++;
          }
          i++;
          while (/[a-z]/i.test(src[i] || "")) i++;
          prevSig = ")"; prevWord = "";
          continue;
        }
      }
      if (/[A-Za-z_$]/.test(c)) { let w = ""; while (i < src.length && /[\w$]/.test(src[i])) w += src[i++]; prevWord = w; prevSig = "a"; continue; }
      if (!/\s/.test(c)) { prevSig = c; prevWord = ""; }
      i++;
    }
  }
  readCode(false);
  for (const lit of lits) {
    const line0 = lineAt(lit.start);
    const line = line0 + 1 + lineOffset;
    const before = src.slice(Math.max(0, lit.start - 120), lit.start);
    const keyCall = /(\bT|PPLang\.T|PPLang\.has)\(\s*$/.test(before);
    if (keyCall) {
      if (lit.text.includes("\u0001")) { dynamicPrefixes.add(lit.text.split("\u0001")[0]); continue; }
      // T("prefix." + something)
      const after = src.slice(lit.start + lit.text.length + 2, lit.start + lit.text.length + 12);
      if (/^\s*\+/.test(after)) { dynamicPrefixes.add(lit.text); continue; }
      if (KEYS[lit.text] === undefined) problem(file, line, `T("${lit.text}") — this key is not in play/lang.js`);
      else used.add(lit.text);
      continue;
    }
    // keys handed around as data: "key:some.key" convention is not used; a
    // literal that IS an existing key counts as a use (e.g. tables of keys).
    if (isLangFile) continue;   // the file's own list of keys is not a use of them
    if (KEYS[lit.text] !== undefined && /^[a-z][\w]*(\.[\w]+)+$/.test(lit.text)) { used.add(lit.text); continue; }
    if (okLine.has(line0) || okLine.has(line0 - 1)) continue;
    if (CODE_BEFORE.test(before)) continue;
    const text = lit.text;
    if (TECHNICAL.some((re) => re.test(text.trim()))) continue;
    if (looksLikeWording(text)) problem(file, line, `wording typed into the page (move it to play/lang.js and use T): ${JSON.stringify(norm(text.replace(/\u0001/g, "${…}"))).slice(0, 140)}`);
  }
}

// ---------- static markup ----------
const VOID = new Set(["meta", "link", "input", "br", "img", "hr", "source", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "use", "stop", "base", "col", "wbr"]);
function attrsOf(tag) {
  const out = {};
  tag.replace(/([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g, (m, n, a, b, c) => { out[n.toLowerCase()] = a !== undefined ? a : b !== undefined ? b : c !== undefined ? c : ""; return m; });
  return out;
}
function scanHtml(file) {
  const full = fs.readFileSync(path.join(PLAY, file), "utf8");
  // scripts are read as JavaScript; their place is kept as blank lines
  let html = full.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (m, a, body, at) => {
    if (!/\bsrc\s*=/.test(a) && body.trim()) scanJs(body, file, full.slice(0, at + m.indexOf(body)).split("\n").length - 1, false);
    return m.replace(/[^\n]/g, " ");
  });
  html = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => m.replace(/[^\n]/g, " "));
  const re = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+/g;
  const stack = [];
  let m;
  const lineOf = (idx) => html.slice(0, idx).split("\n").length;
  while ((m = re.exec(html))) {
    const tok = m[0];
    if (tok.startsWith("<!")) continue;
    if (tok[0] === "<" && tok[1] !== "/") {
      const name = /^<([a-zA-Z][\w-]*)/.exec(tok)[1].toLowerCase();
      const a = attrsOf(tok.slice(name.length + 1, -1));
      const line = lineOf(m.index);
      // attributes that carry wording
      const map = {};
      (a["data-i18n-attr"] || "").split(";").forEach((p) => { const at = p.indexOf(":"); if (at > 0) map[p.slice(0, at).trim()] = p.slice(at + 1).trim(); });
      const inSkip = stack.some((s) => s.mode === "skip") || "data-i18n-skip" in a;
      for (const attr of ["placeholder", "title", "aria-label", "alt"].concat(name === "input" && /^(button|submit)$/.test(a.type || "") ? ["value"] : [])) {
        const v = a[attr];
        if (v === undefined || !/[A-Za-z؀-ۿ]{2,}/.test(decode(v)) || inSkip) continue;
        if (!map[attr]) problem(file, line, `${attr}="${v}" needs data-i18n-attr="${attr}:key"`);
        else if (KEYS[map[attr]] === undefined) problem(file, line, `data-i18n-attr key "${map[attr]}" is not in play/lang.js`);
        else if (!keyHasEnglish(map[attr], v, false)) problem(file, line, `${attr}="${v}" differs from the English for "${map[attr]}": ${JSON.stringify(KEYS[map[attr]])}`);
        else used.add(map[attr]);
      }
      for (const k of Object.values(map)) if (KEYS[k] !== undefined) used.add(k);
      const mode = "data-i18n" in a ? "text" : "data-i18n-html" in a ? "html" : "data-i18n-skip" in a ? "skip" : "data-i18n-nodes" in a ? "nodes" : null;
      const nodeKeys = (a["data-i18n-nodes"] || "").split(";").map((k) => k.trim()).filter(Boolean);
      const selfClosed = VOID.has(name) || /\/>$/.test(tok);
      if (!selfClosed) stack.push({ name, mode, key: a["data-i18n"] || a["data-i18n-html"], nodeKeys, contentStart: re.lastIndex, line });
      continue;
    }
    if (tok[0] === "<") {
      const name = tok.slice(2, -1).trim().toLowerCase();
      let idx = stack.length - 1;
      while (idx >= 0 && stack[idx].name !== name) idx--;
      if (idx < 0) continue;
      const el = stack[idx];
      stack.length = idx;
      if (el.mode === "nodes" && el.nodeKeys.length) problem(file, el.line, `data-i18n-nodes lists more keys than the element has pieces of text: ${el.nodeKeys.join("; ")}`);
      if (el.mode === "text" || el.mode === "html") {
        const inner = html.slice(el.contentStart, m.index);
        if (KEYS[el.key] === undefined) problem(file, el.line, `data-i18n key "${el.key}" is not in play/lang.js`);
        else {
          used.add(el.key);
          if (el.mode === "text" && /<[a-zA-Z]/.test(inner)) problem(file, el.line, `data-i18n="${el.key}" has markup inside it — use data-i18n-html and a key ending in _html`);
          else if (norm(inner) && !keyHasEnglish(el.key, inner, el.mode === "html")) problem(file, el.line, `the English in the page for "${el.key}" differs from play/lang.js: page ${JSON.stringify(norm(inner)).slice(0, 110)} / file ${JSON.stringify(KEYS[el.key]).slice(0, 110)}`);
        }
      }
      continue;
    }
    // text
    if (!/[A-Za-z؀-ۿ]{2,}/.test(decode(tok).replace(/&[a-z#0-9]+;/gi, " "))) continue;
    if (stack.some((s) => s.mode === "text" || s.mode === "html" || s.mode === "skip" || s.name === "svg")) continue;
    const top = stack[stack.length - 1];
    if (top && top.mode === "nodes") {
      // the element's own pieces of text take its keys in order
      const key = top.nodeKeys.shift();
      const line = lineOf(m.index + tok.search(/\S/));
      if (!key) problem(file, line, `data-i18n-nodes has no key for this piece of text: ${JSON.stringify(norm(tok)).slice(0, 110)}`);
      else if (KEYS[key] === undefined) problem(file, line, `data-i18n-nodes key "${key}" is not in play/lang.js`);
      else if (!keyHasEnglish(key, tok, false)) problem(file, line, `the English in the page for "${key}" differs from play/lang.js: page ${JSON.stringify(norm(tok)).slice(0, 110)} / file ${JSON.stringify(KEYS[key]).slice(0, 110)}`);
      else used.add(key);
      continue;
    }
    problem(file, lineOf(m.index + tok.search(/\S/)), `text typed into the page without data-i18n: ${JSON.stringify(norm(tok)).slice(0, 110)}`);
  }
}

// ---------- run ----------
const files = fs.readdirSync(PLAY).filter((f) => /\.(html|js)$/.test(f) && !/^lang-/.test(f));
for (const f of files) {
  if (only.length && !only.includes(f)) continue;
  if (f === "lang.js") { scanJs(fs.readFileSync(path.join(PLAY, f), "utf8"), f, 0, true); continue; }
  if (f.endsWith(".html")) scanHtml(f);
  else scanJs(fs.readFileSync(path.join(PLAY, f), "utf8"), f, 0, false);
}
if (!quietUnused) {
  for (const k of Object.keys(KEYS)) {
    if (used.has(k)) continue;
    if ([...dynamicPrefixes].some((p) => p && k.startsWith(p))) continue;
    problem("lang.js", 0, `key "${k}" is not used by any page (remove it, or use it)`);
  }
}
// the catalogue of database messages must be well formed
(EN.db || []).forEach((d, n) => {
  if (!d || typeof d.match !== "string" || !d.match) problem("lang.js", 0, `db entry ${n} has no "match"`);
  else if (d.match.startsWith("re:")) { try { new RegExp(d.match.slice(3)); } catch (e) { problem("lang.js", 0, `db entry ${n}: bad pattern`); } if (!d.text) problem("lang.js", 0, `db entry ${n}: a pattern needs "text"`); }
});

if (problems.length) {
  console.error(problems.join("\n"));
  console.error(`\ncheck-lang: ${problems.length} problem(s). Wording belongs in play/lang.js.`);
  process.exit(1);
}
console.log(`check-lang: ok — ${Object.keys(KEYS).length} keys, ${files.length} files.`);
