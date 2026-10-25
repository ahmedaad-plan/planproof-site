#!/usr/bin/env node
// Builds the Insights section (the "answer library") from plain text files.
//
//   node tools/build-insights.mjs
//
// Reads   insights/articles/<slug>.md   (front matter + a small Markdown subset)
// Writes  insights/index.html           (the list of articles)
//         insights/<slug>/index.html    (one page per article)
//         insights/feed.xml             (RSS, for LinkedIn/newsletter tools)
//         sitemap.xml                   (whole site)
//
// No dependencies and no build step on Netlify: the generated pages are
// committed, so the live site only ever serves plain files. To publish a new
// article: add one .md file, run this script, open a pull request.
// Share images (insights/<slug>/card.png) are made separately with
// tools/make-insight-cards.mjs, which needs Playwright.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "https://plan-proof.com";
const ART_DIR = path.join(ROOT, "insights", "articles");
const OUT_DIR = path.join(ROOT, "insights");

// "Book a 20-minute call" — decided 25 October 2026: LATER, once the front
// person (and their calendar) exists. Put the booking link here and re-run the
// script; a third button then appears in every article's closing box.
const BOOKING_URL = "";

// Pages outside /insights/ that belong in the sitemap.
const STATIC_PAGES = [
  { loc: "/", lastmod: "2026-10-25" },
  { loc: "/privacy-policy.html", lastmod: "2026-10-18" },
];

// ---------- reading the article files ----------

function parseFrontMatter(text, file) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error(`${file}: missing front matter`);
  const data = {};
  let listKey = null;
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) { data[listKey].push(unquote(item[1])); continue; }
    const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
    if (!kv) throw new Error(`${file}: cannot read front-matter line: ${line}`);
    if (kv[2] === "") { listKey = kv[1]; data[listKey] = []; }
    else { listKey = null; data[kv[1]] = unquote(kv[2]); }
  }
  return { data, body: m[2] };
}
function unquote(v) {
  v = v.trim();
  if (v.startsWith('"') && v.endsWith('"')) return JSON.parse(v);
  return v;
}

const REQUIRED = ["title", "searchTitle", "description", "slug", "date", "topic", "shortAnswer"];

function loadArticles() {
  const files = fs.readdirSync(ART_DIR).filter((f) => f.endsWith(".md")).sort();
  const list = files.map((f) => {
    const { data, body } = parseFrontMatter(fs.readFileSync(path.join(ART_DIR, f), "utf8").replace(/\r\n/g, "\n"), f);
    for (const k of REQUIRED) if (!data[k]) throw new Error(`${f}: "${k}" is missing`);
    if (data.slug + ".md" !== f) throw new Error(`${f}: slug must match the file name`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) throw new Error(`${f}: date must be YYYY-MM-DD`);
    if (data.description.length > 160) throw new Error(`${f}: description is ${data.description.length} characters (keep it to 160 for search results)`);
    for (const k of ["title", "description", "shortAnswer"]) data[k] = smart(data[k]);
    data.updated = data.updated || data.date;
    data.related = data.related || [];
    data.order = Number(data.order || 999);
    data.html = markdown(body);
    data.words = body.split(/\s+/).filter(Boolean).length;
    data.minutes = Math.max(1, Math.round(data.words / 220));
    return data;
  });
  const slugs = new Set(list.map((a) => a.slug));
  for (const a of list) for (const r of a.related) if (!slugs.has(r)) throw new Error(`${a.slug}: related article "${r}" does not exist`);
  return list.sort((a, b) => (b.date.localeCompare(a.date)) || (a.order - b.order));
}

// ---------- a small Markdown reader (headings, paragraphs, lists, bold, italics, links) ----------

function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

// Typographic quotes and apostrophes ("x" -> “x”, it's -> it’s) in running text.
function smart(s) {
  return String(s)
    .replace(/(^|[\s(\[—–-])"/g, "$1\u201C").replace(/"/g, "\u201D")
    .replace(/(^|[\s(\[—–-])'/g, "$1\u2018").replace(/'/g, "\u2019");
}

function inline(s) {
  // Links first, so their addresses are never touched by the quote fixer.
  const links = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => { links.push({ text, href }); return `\u0000${links.length - 1}\u0000`; });
  let out = esc(smart(s));
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => {
    const { text, href } = links[Number(i)];
    const ext = /^https?:\/\//.test(href) && !href.startsWith(SITE);
    return `<a href="${esc(href)}"${ext ? ' rel="noopener" target="_blank"' : ""}>${esc(smart(text))}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return out;
}

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }

function markdown(src) {
  const lines = src.split("\n");
  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if ((m = line.match(/^(#{2,3})\s+(.*)$/))) {
      flushPara(); flushList();
      const lvl = m[1].length;
      out.push(`<h${lvl} id="${slugify(m[2])}">${inline(m[2])}</h${lvl}>`);
      continue;
    }
    if ((m = line.match(/^(\d+)\.\s+(.*)$/)) || (m = line.match(/^(-)\s+(.*)$/))) {
      flushPara();
      const tag = m[1] === "-" ? "ul" : "ol";
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(m[2]);
      continue;
    }
    if (list && /^\s+\S/.test(raw)) { list.items[list.items.length - 1] += " " + line.trim(); continue; }
    flushList();
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join("\n");
}

// ---------- shared page parts ----------

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function longDate(iso) { const [y, m, d] = iso.split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; }
function rfc822(iso) { return new Date(iso + "T06:00:00Z").toUTCString(); }

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@600;700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap" rel="stylesheet">`;

const ICONS = `<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-96.png" type="image/png" sizes="96x96">
<link rel="icon" href="/favicon-48.png" type="image/png" sizes="48x48">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#10151b">
<link rel="alternate" type="application/rss+xml" title="PlanProof Insights" href="/insights/feed.xml">
<link rel="stylesheet" href="/insights/insights.css">`;

const NAV = `<a class="skip" href="#main">Skip to the article</a>
<nav class="sitenav">
  <div class="nav-inner">
    <a href="/" class="brand" aria-label="PlanProof home">
      <svg viewBox="0 0 52 52" class="brand-mark" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <path d="M26 4 L45 11 V24 C45 36 37 44 26 48 C15 44 7 36 7 24 V11 Z" fill="none" stroke="currentColor" stroke-width="2"/>
        <path d="M14 24 Q20 24 22 30 Q24 36 30 30 L38 20" fill="none" stroke="#d84a3a" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      <span class="brand-plan">Plan</span><span class="brand-proof">Proof</span>
    </a>
    <button type="button" class="nav-toggle" id="navToggle" aria-expanded="false" aria-controls="navLinks">
      <span class="nav-toggle-bars" aria-hidden="true"><span></span><span></span><span></span></span>Menu
    </button>
    <div class="nav-links" id="navLinks">
      <a href="/">Home</a>
      <a href="/#tool">Start an exercise</a>
      <a href="/#services">Services</a>
      <a href="/#demo">Watch a Demo</a>
      <a href="/#about">About</a>
      <a href="/#faq">FAQ</a>
      <a href="/insights/" aria-current="page">Insights</a>
      <a href="/#contact">Contact</a>
    </div>
  </div>
</nav>`;

const FOOTER = `<footer class="sitefooter">
  <div class="footer-inner">
    <div class="footer-email">Email us at <a href="mailto:exercises@plan-proof.com">exercises@plan-proof.com</a></div>
    <div class="footer-links">
      <a href="/">Home</a><a href="/#tool">Start an exercise</a><a href="/#services">Services</a><a href="/#demo">Watch a Demo</a><a href="/#about">About</a><a href="/#faq">FAQ</a><a href="/insights/">Insights</a><a href="/#contact">Contact</a><a href="/privacy-policy.html">Privacy Policy</a>
    </div>
    <div class="footer-copyright">© 2026 PlanProof. All rights reserved.</div>
  </div>
</footer>`;

const SCRIPT = `<script>
(function(){
  var nav = document.querySelector(".sitenav"), btn = document.getElementById("navToggle");
  if(nav && btn){
    var set = function(open){ nav.classList.toggle("open", open); btn.setAttribute("aria-expanded", open ? "true" : "false"); };
    btn.addEventListener("click", function(){ set(!nav.classList.contains("open")); });
    nav.querySelectorAll(".nav-links a").forEach(function(a){ a.addEventListener("click", function(){ set(false); }); });
    document.addEventListener("keydown", function(e){ if(e.key === "Escape") set(false); });
    document.addEventListener("click", function(e){ if(nav.classList.contains("open") && !nav.contains(e.target)) set(false); });
  }
  var copy = document.querySelector("[data-copy-link]");
  if(copy){
    copy.addEventListener("click", function(){
      var url = copy.getAttribute("data-copy-link"), label = copy.textContent;
      var done = function(ok){ copy.textContent = ok ? "Link copied" : "Copy failed — select the address bar"; setTimeout(function(){ copy.textContent = label; }, 2500); };
      if(navigator.clipboard && window.isSecureContext){ navigator.clipboard.writeText(url).then(function(){ done(true); }, function(){ done(false); }); }
      else {
        var t = document.createElement("textarea"); t.value = url; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
        document.body.appendChild(t); t.select(); var ok = false; try { ok = document.execCommand("copy"); } catch(e){} document.body.removeChild(t); done(ok);
      }
    });
  }
})();
</script>`;

const ORG = { "@type": "Organization", "@id": `${SITE}/#organization`, name: "PlanProof", url: `${SITE}/`, logo: { "@type": "ImageObject", url: `${SITE}/logo.png`, width: 512, height: 512 } };

function jsonld(obj) { return `<script type="application/ld+json">\n${JSON.stringify(obj, null, 2).replace(/</g, "\\u003c")}\n</script>`; }

function cardUrl(slug) {
  const rel = slug ? `insights/${slug}/card.png` : "insights/card.png";
  return fs.existsSync(path.join(ROOT, rel)) ? `${SITE}/${rel}` : `${SITE}/hero.jpg`;
}

function ctaBlock() {
  const book = BOOKING_URL ? `<a class="btn btn-outline" href="${esc(BOOKING_URL)}" rel="noopener" target="_blank">Book a 20-minute call</a>` : "";
  return `<aside class="cta" aria-labelledby="cta-title">
  <h2 id="cta-title">Test your plan before a real incident does</h2>
  <p>PlanProof designs and facilitates business continuity tabletop exercises for organizations in the UAE and the wider GCC, aligned with ISO 22301 and NCEMA 7000:2021. You receive a scored report in English and Arabic within three working days.</p>
  <div class="cta-buttons"><a class="btn btn-primary" href="/#tool">Start an exercise</a><a class="btn btn-outline" href="/#contact">Contact us</a>${book}</div>
</aside>`;
}

// ---------- the pages ----------

function articlePage(a, bySlug) {
  const url = `${SITE}/insights/${a.slug}/`;
  const image = cardUrl(a.slug);
  const related = a.related.map((s) => bySlug[s]);
  const pageTitle = `${a.searchTitle} | PlanProof Insights`;
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        "@id": `${url}#article`,
        headline: a.title,
        description: a.description,
        image: [image],
        datePublished: `${a.date}T08:00:00+04:00`,
        dateModified: `${a.updated}T08:00:00+04:00`,
        author: { "@id": `${SITE}/#organization` },
        publisher: { "@id": `${SITE}/#organization` },
        mainEntityOfPage: url,
        articleSection: a.topic,
        wordCount: a.words,
        inLanguage: "en",
        isPartOf: { "@type": "Blog", "@id": `${SITE}/insights/#blog`, name: "PlanProof Insights", url: `${SITE}/insights/` },
      },
      ORG,
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
          { "@type": "ListItem", position: 2, name: "Insights", item: `${SITE}/insights/` },
          { "@type": "ListItem", position: 3, name: a.title, item: url },
        ],
      },
    ],
  };
  const shareLinkedIn = `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;
  const updatedLine = a.updated !== a.date ? ` · Updated <time datetime="${a.updated}">${longDate(a.updated)}</time>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(a.description)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${url}">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(a.title)}">
<meta property="og:description" content="${esc(a.description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${image}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="627">
<meta property="og:site_name" content="PlanProof">
<meta property="og:locale" content="en_AE">
<meta property="article:published_time" content="${a.date}T08:00:00+04:00">
<meta property="article:modified_time" content="${a.updated}T08:00:00+04:00">
<meta property="article:section" content="${esc(a.topic)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(a.title)}">
<meta name="twitter:description" content="${esc(a.description)}">
<meta name="twitter:image" content="${image}">
${ICONS}
${FONTS}
${jsonld(ld)}
</head>
<body>
${NAV}
<main id="main" class="wrap">
  <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">/</span><a href="/insights/">Insights</a></nav>
  <article>
    <header class="article-head">
      <p class="topic">${esc(a.topic)}</p>
      <h1>${esc(a.title)}</h1>
      <p class="meta"><time datetime="${a.date}">${longDate(a.date)}</time>${updatedLine} · ${a.minutes} min read · PlanProof</p>
    </header>
    <section class="short-answer" aria-label="Short answer">
      <h2>Short answer</h2>
      <p>${esc(a.shortAnswer)}</p>
    </section>
    <div class="prose">
${a.html}
    </div>
    <div class="share">
      <span>Share this article</span>
      <a class="btn btn-small" href="${shareLinkedIn}" rel="noopener" target="_blank">Share on LinkedIn</a>
      <button type="button" class="btn btn-small" data-copy-link="${url}">Copy link</button>
    </div>
  </article>
  ${ctaBlock()}
  ${related.length ? `<section class="related" aria-labelledby="related-title">
    <h2 id="related-title">Related questions</h2>
    <ul class="entry-list">
${related.map((r) => entry(r, 3)).join("\n")}
    </ul>
  </section>` : ""}
</main>
${FOOTER}
${SCRIPT}
</body>
</html>
`;
}

function entry(a, hLevel = 2) {
  return `      <li class="entry">
        <p class="topic">${esc(a.topic)}</p>
        <h${hLevel}><a href="/insights/${a.slug}/">${esc(a.title)}</a></h${hLevel}>
        <p class="entry-summary">${esc(a.description)}</p>
        <p class="meta"><time datetime="${a.date}">${longDate(a.date)}</time> · ${a.minutes} min read</p>
      </li>`;
}

function indexPage(list) {
  const url = `${SITE}/insights/`;
  const description = "Plain answers to the questions risk, compliance and audit teams ask about business continuity and crisis management exercises in the UAE.";
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Blog",
        "@id": `${url}#blog`,
        name: "PlanProof Insights",
        description,
        url,
        inLanguage: "en",
        publisher: { "@id": `${SITE}/#organization` },
        blogPost: list.map((a) => ({ "@type": "BlogPosting", headline: a.title, url: `${url}${a.slug}/`, datePublished: `${a.date}T08:00:00+04:00` })),
      },
      ORG,
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "Home", item: `${SITE}/` },
          { "@type": "ListItem", position: 2, name: "Insights", item: url },
        ],
      },
    ],
  };
  const image = cardUrl("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>Insights — business continuity exercise questions answered | PlanProof</title>
<meta name="description" content="${esc(description)}">
<meta name="robots" content="index, follow, max-image-preview:large">
<link rel="canonical" href="${url}">
<meta property="og:type" content="website">
<meta property="og:title" content="PlanProof Insights">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${image}">
<meta property="og:site_name" content="PlanProof">
<meta property="og:locale" content="en_AE">
<meta name="twitter:card" content="summary_large_image">
${ICONS}
${FONTS}
${jsonld(ld)}
</head>
<body>
${NAV.replace("Skip to the article", "Skip to the list")}
<main id="main" class="wrap wrap-index">
  <header class="index-head">
    <h1>Insights</h1>
    <p class="lede">${esc(description)} Each article answers one question, with the clauses and sources behind it.</p>
  </header>
  <ul class="entry-list entry-grid">
${list.map((a) => entry(a)).join("\n")}
  </ul>
  ${ctaBlock()}
</main>
${FOOTER}
${SCRIPT}
</body>
</html>
`;
}

function feed(list) {
  const items = list.map((a) => `    <item>
      <title>${esc(a.title)}</title>
      <link>${SITE}/insights/${a.slug}/</link>
      <guid isPermaLink="true">${SITE}/insights/${a.slug}/</guid>
      <pubDate>${rfc822(a.date)}</pubDate>
      <category>${esc(a.topic)}</category>
      <description>${esc(a.shortAnswer)}</description>
    </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>PlanProof Insights</title>
    <link>${SITE}/insights/</link>
    <atom:link href="${SITE}/insights/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Plain answers to the questions risk, compliance and audit teams ask about business continuity and crisis management exercises in the UAE.</description>
    <language>en</language>
    <lastBuildDate>${rfc822(list.reduce((m, a) => (a.updated > m ? a.updated : m), "0000-00-00"))}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

function sitemap(list) {
  const newest = list.reduce((m, a) => (a.updated > m ? a.updated : m), "0000-00-00");
  const urls = [
    ...STATIC_PAGES.map((p) => ({ loc: SITE + p.loc, lastmod: p.lastmod })),
    { loc: `${SITE}/insights/`, lastmod: newest },
    ...list.map((a) => ({ loc: `${SITE}/insights/${a.slug}/`, lastmod: a.updated })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`).join("\n")}
</urlset>
`;
}

// ---------- run ----------

const list = loadArticles();
const bySlug = Object.fromEntries(list.map((a) => [a.slug, a]));
const written = [];
const write = (rel, content) => { const p = path.join(ROOT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); written.push(rel); };

for (const a of list) write(`insights/${a.slug}/index.html`, articlePage(a, bySlug));
write("insights/index.html", indexPage([...list].sort((a, b) => a.order - b.order)));
write("insights/feed.xml", feed(list));
write("sitemap.xml", sitemap(list));

// Remove pages of articles that no longer exist (renamed or withdrawn).
for (const d of fs.readdirSync(OUT_DIR, { withFileTypes: true })) {
  if (d.isDirectory() && d.name !== "articles" && !bySlug[d.name]) {
    fs.rmSync(path.join(OUT_DIR, d.name), { recursive: true });
    console.log(`removed insights/${d.name}/ (no matching article)`);
  }
}
console.log(`Built ${list.length} articles:\n  ${written.join("\n  ")}`);
