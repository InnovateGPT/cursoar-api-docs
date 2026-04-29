import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ─── Markdown content ────────────────────────────────────────────────────────
const MARKDOWN = readFileSync(join(__dirname, "cursoar-api.md"), "utf8");
const LOGO = readFileSync(join(__dirname, "logo.png"));
const FAVICON = readFileSync(join(__dirname, "favicon.png"));

// ─── Markdown → HTML (block parser) ──────────────────────────────────────────
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}
function slug(t) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function renderBlocks(md) {
  const lines = md.split("\n");
  let out = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]); i++;
      }
      i++;
      out += `<pre><code class="lang-${lang}">${escapeHtml(buf.join("\n"))}</code></pre>\n`;
      continue;
    }

    // Headings
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      const lvl = h[1].length;
      const txt = h[2];
      out += `<h${lvl} id="${slug(txt.replace(/\*\*|`/g, ""))}">${inline(txt)}</h${lvl}>\n`;
      i++;
      continue;
    }

    // Horizontal rule
    if (line.trim() === "---") {
      out += "<hr>\n";
      i++; continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith("> ")) {
        buf.push(lines[i].slice(2)); i++;
      }
      out += `<blockquote>${inline(buf.join(" "))}</blockquote>\n`;
      continue;
    }

    // Tables
    if (line.startsWith("|") && i + 1 < lines.length && /^\|[\s|:-]+\|$/.test(lines[i+1])) {
      const head = line.split("|").slice(1, -1).map(c => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].startsWith("|")) {
        rows.push(lines[i].split("|").slice(1, -1).map(c => c.trim()));
        i++;
      }
      out += `<div class="tbl-wrap"><table><thead><tr>${head.map(h => `<th>${inline(h)}</th>`).join("")}</tr></thead><tbody>`;
      out += rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("");
      out += `</tbody></table></div>\n`;
      continue;
    }

    // Lists
    if (line.match(/^[-*]\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^[-*]\s+/)) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      out += `<ul>${items.map(it => `<li>${inline(it)}</li>`).join("")}</ul>\n`;
      continue;
    }
    if (line.match(/^\d+\.\s+/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+/)) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      out += `<ol>${items.map(it => `<li>${inline(it)}</li>`).join("")}</ol>\n`;
      continue;
    }

    // Empty line
    if (line.trim() === "") {
      i++; continue;
    }

    // Paragraph (collect until blank line / block start)
    const para = [];
    while (i < lines.length && lines[i].trim() !== "" &&
           !lines[i].startsWith("#") && !lines[i].startsWith("```") &&
           !lines[i].startsWith(">") && !lines[i].startsWith("|") &&
           !lines[i].match(/^[-*]\s+/) && !lines[i].match(/^\d+\.\s+/) &&
           lines[i].trim() !== "---") {
      para.push(lines[i]); i++;
    }
    out += `<p>${inline(para.join(" "))}</p>\n`;
  }
  return out;
}

// ─── Split markdown into sections (intro + 10 numbered sections) ─────────────
function parseSections(md) {
  // Split on `## N. Title` boundaries
  const parts = md.split(/\n(?=## \d+\. )/);
  const intro = parts[0]; // includes # H1 + intro blockquote + first ---
  const sections = parts.slice(1).map(raw => {
    const titleMatch = raw.match(/^## (\d+)\. (.+?)$/m);
    if (!titleMatch) return null;
    return {
      num: titleMatch[1].padStart(2, "0"),
      title: titleMatch[2].trim(),
      raw,
      body: raw.replace(/^## \d+\. .+\n/, "").replace(/\n---\s*$/, ""),
    };
  }).filter(Boolean);
  return { intro, sections };
}

// ─── Build full HTML ─────────────────────────────────────────────────────────
function buildPage() {
  const { intro, sections } = parseSections(MARKDOWN);

  const sidebarHtml = sections.map(s => `
    <a href="#section-${s.num}" data-section="${s.num}" class="nav-item">
      <span class="nav-num">${s.num}</span>
      <span class="nav-title">${s.title}</span>
    </a>`).join("");

  const sectionsHtml = sections.map(s => `
    <section id="section-${s.num}" class="doc-section" data-section-num="${s.num}">
      <header class="section-header">
        <div class="section-marker">
          <span class="marker-num">${s.num}</span>
          <span class="marker-line"></span>
        </div>
        <div class="section-title-wrap">
          <h2 class="section-title">${s.title}</h2>
          <button class="copy-btn" data-target="md-${s.num}" aria-label="Copy markdown for this section">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            <span class="copy-label">Copy markdown</span>
          </button>
        </div>
      </header>
      <div class="section-body">
        ${renderBlocks(s.body)}
      </div>
      <template id="md-${s.num}">${escapeHtml(s.raw)}</template>
    </section>`).join("");

  // Render intro (H1, blockquote)
  const introHtml = renderBlocks(intro.replace(/^---\s*$/gm, "").trim());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cursoar — API Codex</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <meta name="description" content="The complete Cursoar API reference. tRPC, MCP HTTP, REST. For agents and humans alike.">
  <meta property="og:title" content="Cursoar — API Codex">
  <meta property="og:description" content="The complete Cursoar API reference. tRPC, MCP HTTP, REST.">
  <meta property="og:image" content="/logo.png">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,300..900,0..100,0..1&family=Geist:wght@300..700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">

  <style>
    /* ────────────────────────────────────────────────────────────────
       CURSOAR API CODEX — Editorial Brutalism, Monochrome
       Design tokens borrowed from Cursoar's actual design system:
         bg #1c1c1c · card hsl(0 0% 14%) · border hsl(0 0% 20%)
         text hsl(0 0% 95%) · muted hsl(0 0% 55%)
       ──────────────────────────────────────────────────────────── */
    :root {
      --bg: hsl(0 0% 7%);
      --bg-card: hsl(0 0% 11%);
      --bg-elevated: hsl(0 0% 14%);
      --bg-hover: hsl(0 0% 18%);
      --border: hsl(0 0% 18%);
      --border-strong: hsl(0 0% 28%);
      --text: hsl(0 0% 96%);
      --text-muted: hsl(0 0% 62%);
      --text-faint: hsl(0 0% 40%);
      --accent: hsl(70 95% 60%);   /* electric lime — used surgically */
      --code-keyword: hsl(310 60% 75%);
      --code-string: hsl(95 50% 70%);
      --code-comment: hsl(0 0% 50%);
      --shadow-lg: 0 20px 50px -10px rgba(0,0,0,0.6);
      --serif: "Fraunces", "TWK Lausanne", Georgia, serif;
      --sans: "Geist", "TWK Lausanne", -apple-system, sans-serif;
      --mono: "JetBrains Mono", "SF Mono", Consolas, monospace;
      --sidebar-w: 320px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; -webkit-font-smoothing: antialiased; }
    body {
      font-family: var(--sans);
      background: var(--bg);
      color: var(--text);
      font-size: 15px;
      line-height: 1.65;
      font-feature-settings: "ss01", "cv01";
      letter-spacing: -0.005em;
    }

    /* ── Grain overlay ── */
    body::before {
      content: "";
      position: fixed; inset: 0; z-index: 0; pointer-events: none;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E");
      opacity: 0.045;
      mix-blend-mode: overlay;
    }

    /* ── Floating orbs ── */
    .orb {
      position: fixed; border-radius: 50%;
      filter: blur(120px); pointer-events: none; z-index: 0;
      will-change: transform;
    }
    .orb-1 {
      top: -10%; left: 30%;
      width: 540px; height: 540px;
      background: radial-gradient(circle, rgba(255,255,255,0.04) 0%, transparent 70%);
      animation: drift1 30s ease-in-out infinite;
    }
    .orb-2 {
      bottom: 10%; right: -10%;
      width: 420px; height: 420px;
      background: radial-gradient(circle, rgba(255,255,255,0.025) 0%, transparent 70%);
      animation: drift2 38s ease-in-out infinite;
    }
    @keyframes drift1 {
      0%,100% { transform: translate(0,0) scale(1); }
      33% { transform: translate(60px,-40px) scale(1.06); }
      66% { transform: translate(-30px,-80px) scale(0.94); }
    }
    @keyframes drift2 {
      0%,100% { transform: translate(0,0) scale(1); }
      50% { transform: translate(-50px,30px) scale(1.04); }
    }

    /* ── Reading progress ── */
    .progress {
      position: fixed; top: 0; left: 0; height: 2px; width: 0;
      background: var(--accent); z-index: 200;
      transition: width 0.1s linear;
    }

    /* ── Top bar ── */
    .topbar {
      position: fixed; top: 0; left: 0; right: 0; z-index: 100;
      background: rgba(15,15,15,0.85);
      backdrop-filter: blur(16px) saturate(140%);
      -webkit-backdrop-filter: blur(16px) saturate(140%);
      border-bottom: 1px solid var(--border);
      height: 60px;
      display: flex; align-items: center;
      padding: 0 28px;
      gap: 24px;
    }
    .brand {
      display: flex; align-items: center; gap: 12px;
      font-weight: 600; letter-spacing: -0.02em;
    }
    .brand img { width: 28px; height: 28px; }
    .brand .name { font-family: var(--serif); font-size: 18px; font-weight: 600; }
    .brand .sep { color: var(--text-faint); margin: 0 2px; font-weight: 300; }
    .brand .sub { font-size: 12px; color: var(--text-muted); font-weight: 400;
                  letter-spacing: 0.06em; text-transform: uppercase; }
    .topbar-actions { margin-left: auto; display: flex; gap: 6px; }
    .topbar-actions a, .topbar-actions button {
      font: inherit; font-size: 12px; font-weight: 500;
      color: var(--text-muted); text-decoration: none;
      padding: 6px 12px; border-radius: 4px;
      background: transparent; border: 1px solid transparent;
      cursor: pointer; transition: all 0.15s;
      letter-spacing: 0.02em;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .topbar-actions a:hover, .topbar-actions button:hover {
      color: var(--text); background: var(--bg-elevated); border-color: var(--border);
    }
    .topbar-actions .primary {
      color: var(--bg); background: var(--text); border-color: var(--text);
    }
    .topbar-actions .primary:hover { background: var(--accent); border-color: var(--accent); color: #000; }

    /* ── Layout ── */
    .layout {
      position: relative; z-index: 1;
      display: grid;
      grid-template-columns: var(--sidebar-w) 1fr;
      padding-top: 60px;
      max-width: 1480px;
      margin: 0 auto;
    }

    /* ── Sidebar ── */
    aside {
      position: sticky; top: 60px; align-self: start;
      height: calc(100vh - 60px); overflow-y: auto;
      padding: 32px 0 32px 28px;
      border-right: 1px solid var(--border);
    }
    .sidebar-head {
      font-family: var(--sans);
      font-size: 11px; font-weight: 600;
      color: var(--text-faint);
      text-transform: uppercase; letter-spacing: 0.18em;
      padding: 0 24px 14px 0;
    }
    .search-wrap { padding-right: 24px; margin-bottom: 18px; }
    #search {
      width: 100%; background: var(--bg-elevated);
      border: 1px solid var(--border); border-radius: 6px;
      padding: 9px 12px; color: var(--text);
      font: inherit; font-size: 13px; outline: none;
      transition: border-color 0.15s;
    }
    #search:focus { border-color: var(--border-strong); }
    #search::placeholder { color: var(--text-faint); }
    .nav-list { display: flex; flex-direction: column; gap: 1px; padding-right: 20px; }
    .nav-item {
      display: grid; grid-template-columns: 32px 1fr; gap: 12px;
      align-items: baseline;
      padding: 9px 14px; border-radius: 5px;
      color: var(--text-muted); text-decoration: none;
      transition: all 0.15s;
      border-left: 2px solid transparent;
    }
    .nav-item:hover { color: var(--text); background: rgba(255,255,255,0.02); }
    .nav-item.active {
      color: var(--text); background: rgba(255,255,255,0.04);
      border-left-color: var(--accent);
    }
    .nav-num {
      font-family: var(--mono); font-size: 11px;
      color: var(--text-faint); font-weight: 500;
      letter-spacing: 0.06em; font-variant-numeric: tabular-nums;
    }
    .nav-item.active .nav-num { color: var(--accent); }
    .nav-title {
      font-family: var(--serif); font-size: 14px;
      font-weight: 500; line-height: 1.35;
      letter-spacing: -0.01em;
    }
    .sidebar-footer {
      margin-top: 36px; padding: 20px 24px 0 0;
      border-top: 1px solid var(--border);
      font-size: 11px; color: var(--text-faint);
      letter-spacing: 0.04em;
    }
    .sidebar-footer .stat {
      display: flex; justify-content: space-between;
      padding: 4px 0;
      font-variant-numeric: tabular-nums;
    }
    .sidebar-footer .stat strong { color: var(--text-muted); font-weight: 500; }

    /* ── Main ── */
    main { padding: 0 64px 120px; max-width: 1000px; }

    /* ── Hero ── */
    .hero { padding: 80px 0 40px; }
    .hero-eyebrow {
      font-size: 11px; font-weight: 500;
      color: var(--text-muted);
      letter-spacing: 0.22em; text-transform: uppercase;
      margin-bottom: 20px;
      display: inline-flex; align-items: center; gap: 12px;
    }
    .hero-eyebrow::before {
      content: ""; width: 32px; height: 1px;
      background: var(--text-faint);
    }
    .hero h1 {
      font-family: var(--serif); font-weight: 350;
      font-size: clamp(48px, 7vw, 92px);
      line-height: 0.96; letter-spacing: -0.04em;
      margin-bottom: 24px;
      font-variation-settings: "opsz" 144, "SOFT" 0, "WONK" 0;
    }
    .hero h1 em {
      font-style: italic; font-weight: 300;
      font-variation-settings: "opsz" 144, "SOFT" 100, "WONK" 1;
      color: var(--text-muted);
    }
    .hero-meta {
      display: flex; gap: 28px; flex-wrap: wrap;
      padding-top: 28px; margin-top: 40px;
      border-top: 1px solid var(--border);
      font-size: 12px; color: var(--text-muted);
      letter-spacing: 0.02em;
    }
    .hero-meta strong {
      display: block; font-family: var(--mono);
      font-size: 14px; color: var(--text); font-weight: 500;
      margin-top: 4px; letter-spacing: 0;
      font-variant-numeric: tabular-nums;
    }
    .hero blockquote {
      margin: 36px 0 0;
      padding: 0 0 0 20px;
      border-left: 2px solid var(--text-faint);
      font-family: var(--serif);
      font-size: 18px; font-style: italic;
      font-weight: 350;
      line-height: 1.55;
      color: var(--text-muted);
      max-width: 720px;
    }
    .hero blockquote strong { font-weight: 600; color: var(--text); font-style: normal; }

    /* ── LLM action bar ── */
    .llm-bar {
      display: flex; flex-wrap: wrap; gap: 8px;
      margin: 28px 0 0;
    }
    .llm-bar a, .llm-bar button {
      font: inherit; font-size: 12px; font-weight: 500;
      letter-spacing: 0.02em;
      color: var(--text); text-decoration: none;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: 5px;
      padding: 7px 14px;
      cursor: pointer;
      transition: all 0.15s;
      display: inline-flex; align-items: center; gap: 7px;
    }
    .llm-bar a:hover, .llm-bar button:hover {
      border-color: var(--accent);
      color: var(--accent);
    }
    .llm-bar svg { width: 13px; height: 13px; opacity: 0.7; }
    .llm-bar .accent {
      background: var(--text); color: var(--bg); border-color: var(--text);
    }
    .llm-bar .accent:hover { background: var(--accent); border-color: var(--accent); color: #000; }

    /* ── Section ── */
    .doc-section {
      margin-top: 96px;
      scroll-margin-top: 84px;
    }
    .section-header {
      display: grid;
      grid-template-columns: 80px 1fr;
      gap: 24px; align-items: start;
      margin-bottom: 28px;
    }
    .section-marker { padding-top: 22px; }
    .marker-num {
      display: block;
      font-family: var(--mono); font-size: 13px;
      font-weight: 500; color: var(--text-faint);
      letter-spacing: 0.08em; font-variant-numeric: tabular-nums;
      margin-bottom: 14px;
    }
    .marker-line {
      display: block; width: 56px; height: 1px;
      background: var(--text-faint);
    }
    .section-title-wrap {
      display: flex; align-items: flex-end; justify-content: space-between;
      gap: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--border);
    }
    .section-title {
      font-family: var(--serif); font-weight: 400;
      font-size: clamp(32px, 4vw, 48px);
      line-height: 1.05; letter-spacing: -0.025em;
      max-width: 700px;
    }
    .copy-btn {
      font: inherit; font-size: 12px; font-weight: 500;
      letter-spacing: 0.02em;
      color: var(--text-muted);
      background: transparent; border: 1px solid var(--border);
      border-radius: 5px; padding: 7px 12px;
      cursor: pointer; transition: all 0.15s;
      display: inline-flex; align-items: center; gap: 7px;
      flex-shrink: 0;
    }
    .copy-btn:hover { color: var(--text); border-color: var(--border-strong); background: var(--bg-elevated); }
    .copy-btn.copied { color: var(--accent); border-color: var(--accent); }
    .copy-btn svg { width: 13px; height: 13px; }

    /* ── Body content typography ── */
    .section-body { max-width: 760px; }
    .section-body h3 {
      font-family: var(--serif); font-weight: 500;
      font-size: 22px; letter-spacing: -0.015em;
      margin: 36px 0 12px;
      color: var(--text);
    }
    .section-body h4 {
      font-family: var(--sans); font-weight: 600;
      font-size: 13px; letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin: 24px 0 10px;
    }
    .section-body p { margin: 0 0 14px; color: var(--text); }
    .section-body p strong { color: var(--text); font-weight: 600; }
    .section-body p em { font-style: italic; }
    .section-body a {
      color: var(--text); text-decoration: underline;
      text-decoration-color: var(--text-faint);
      text-underline-offset: 3px;
      transition: text-decoration-color 0.15s;
    }
    .section-body a:hover { text-decoration-color: var(--accent); }
    .section-body ul, .section-body ol {
      margin: 0 0 16px 0; padding-left: 0;
      list-style: none;
    }
    .section-body ul li,
    .section-body ol li {
      position: relative; padding-left: 22px;
      margin-bottom: 8px;
    }
    .section-body ul li::before {
      content: "—"; position: absolute; left: 0;
      color: var(--text-faint); font-family: var(--mono);
    }
    .section-body ol { counter-reset: ol; }
    .section-body ol li { counter-increment: ol; }
    .section-body ol li::before {
      content: counter(ol, decimal-leading-zero);
      position: absolute; left: 0;
      color: var(--text-faint);
      font-family: var(--mono); font-size: 12px;
      font-variant-numeric: tabular-nums;
      top: 4px;
    }

    .section-body hr {
      border: none;
      height: 1px; background: var(--border);
      margin: 36px 0;
    }

    .section-body blockquote {
      margin: 18px 0;
      padding: 16px 20px;
      border-left: 2px solid var(--accent);
      background: rgba(255,255,255,0.02);
      font-style: italic;
      color: var(--text-muted);
      border-radius: 0 6px 6px 0;
    }
    .section-body blockquote p { margin: 0; }

    /* ── Code ── */
    code {
      font-family: var(--mono); font-size: 0.86em;
      background: var(--bg-elevated);
      padding: 2px 6px; border-radius: 3px;
      border: 1px solid var(--border);
      color: var(--text);
      letter-spacing: -0.01em;
    }
    pre {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 22px 24px;
      overflow-x: auto;
      margin: 18px 0;
      position: relative;
    }
    pre::before {
      content: ""; position: absolute; top: 0; left: 0; right: 0; height: 28px;
      background: linear-gradient(to right, transparent, transparent 32px, var(--border) 32px, var(--border) 33px, transparent 33px);
      pointer-events: none;
    }
    pre code {
      background: none; border: none;
      padding: 0; color: var(--text);
      font-size: 13px; line-height: 1.7;
    }

    /* ── Tables ── */
    .tbl-wrap {
      margin: 22px 0;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow-x: auto;
      background: var(--bg-card);
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      text-align: left;
      font-family: var(--sans); font-weight: 600;
      color: var(--text-muted);
      font-size: 11px; letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 12px 18px;
      border-bottom: 1px solid var(--border);
      background: rgba(255,255,255,0.015);
    }
    td {
      padding: 11px 18px;
      border-bottom: 1px solid var(--border);
      color: var(--text);
      vertical-align: top;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,0.018); }
    td code { font-size: 11.5px; padding: 1px 5px; }

    /* ── Section divider ornament ── */
    .section-divider {
      display: flex; align-items: center;
      gap: 16px; margin: 80px 0 0;
    }
    .section-divider .line { flex: 1; height: 1px; background: var(--border); }
    .section-divider .glyph {
      font-family: var(--serif); font-style: italic;
      color: var(--text-faint);
      font-size: 14px;
    }

    /* ── Toast ── */
    .toast {
      position: fixed; bottom: 32px; left: 50%;
      transform: translateX(-50%) translateY(120%);
      background: var(--text); color: var(--bg);
      padding: 12px 20px; border-radius: 6px;
      font-size: 13px; font-weight: 500;
      box-shadow: var(--shadow-lg);
      transition: transform 0.3s cubic-bezier(.2,.9,.3,1.1);
      z-index: 300;
      display: inline-flex; align-items: center; gap: 10px;
    }
    .toast.show { transform: translateX(-50%) translateY(0); }
    .toast .check {
      width: 16px; height: 16px;
      background: var(--accent); border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      color: #000; font-weight: 700; font-size: 11px;
    }

    /* ── Mobile ── */
    @media (max-width: 900px) {
      :root { --sidebar-w: 0px; }
      .layout { grid-template-columns: 1fr; }
      aside { display: none; }
      main { padding: 0 24px 80px; }
      .hero { padding: 48px 0 32px; }
      .section-header { grid-template-columns: 1fr; gap: 14px; }
      .section-marker { padding-top: 0; }
      .section-title-wrap { flex-direction: column; align-items: flex-start; }
    }

    /* ── Reveal animation ── */
    @keyframes reveal {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .reveal { animation: reveal 0.6s ease-out both; }
    .reveal-1 { animation-delay: 0.1s; }
    .reveal-2 { animation-delay: 0.2s; }
    .reveal-3 { animation-delay: 0.3s; }
    .reveal-4 { animation-delay: 0.4s; }

    /* ── Selection ── */
    ::selection { background: var(--accent); color: #000; }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-faint); }
  </style>
</head>
<body>

<div class="progress" id="progress"></div>
<div class="orb orb-1"></div>
<div class="orb orb-2"></div>

<header class="topbar">
  <div class="brand">
    <img src="/logo.png" alt="Cursoar">
    <span class="name">Cursoar</span>
    <span class="sep">/</span>
    <span class="sub">API Codex</span>
  </div>
  <div class="topbar-actions">
    <button id="copy-all" title="Copy entire markdown to clipboard">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      Copy all
    </button>
    <a href="/raw" target="_blank">Raw .md</a>
    <a href="/llms.txt" target="_blank">llms.txt</a>
    <a href="/api-json" target="_blank">JSON</a>
  </div>
</header>

<div class="layout">

  <aside>
    <div class="sidebar-head">Contents</div>
    <div class="search-wrap">
      <input id="search" type="text" placeholder="Filter sections..." autocomplete="off">
    </div>
    <nav class="nav-list" id="nav">
      ${sidebarHtml}
    </nav>
    <div class="sidebar-footer">
      <div class="stat"><span>Sections</span><strong>${sections.length}</strong></div>
      <div class="stat"><span>tRPC routers</span><strong>20</strong></div>
      <div class="stat"><span>MCP tools</span><strong>84</strong></div>
      <div class="stat"><span>Last update</span><strong>2026‑04</strong></div>
    </div>
  </aside>

  <main>

    <div class="hero">
      <div class="hero-eyebrow reveal reveal-1">Developer Reference · v1</div>
      <h1 class="reveal reveal-2">The Cursoar<br><em>API Codex.</em></h1>
      <blockquote class="reveal reveal-3">
        <strong>Audience:</strong> Phil, Jiarong, dev team. Single doc covering every API surface
        Cursoar exposes — tRPC (web app), MCP HTTP (agents), and the few standalone REST routes
        (auth, attachments, OAuth, realtime).
      </blockquote>
      <div class="llm-bar reveal reveal-4">
        <button class="accent" id="hero-copy">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          Copy entire spec
        </button>
        <a href="/raw">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="14 2 14 8 20 8"/><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/></svg>
          Raw markdown
        </a>
        <a href="/llms.txt">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          llms.txt
        </a>
        <a href="/api-json">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h2"/><path d="M16 21h2a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2"/></svg>
          api-json
        </a>
      </div>
      <div class="hero-meta">
        <div>Surfaces<strong>5</strong></div>
        <div>tRPC routers<strong>20</strong></div>
        <div>MCP tools<strong>84</strong></div>
        <div>REST endpoints<strong>9</strong></div>
        <div>Source of truth<strong>apps/web/src/server</strong></div>
      </div>
    </div>

    ${sectionsHtml}

    <div class="section-divider">
      <span class="line"></span>
      <span class="glyph">end of codex</span>
      <span class="line"></span>
    </div>

  </main>
</div>

<div class="toast" id="toast">
  <span class="check">✓</span>
  <span id="toast-msg">Copied to clipboard</span>
</div>

<script>
  // ── Reading progress ──
  const progress = document.getElementById("progress");
  document.addEventListener("scroll", () => {
    const h = document.documentElement;
    const pct = (h.scrollTop / (h.scrollHeight - h.clientHeight)) * 100;
    progress.style.width = pct + "%";
  });

  // ── Active nav ──
  const navItems = document.querySelectorAll(".nav-item");
  const sections = document.querySelectorAll(".doc-section");
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        const num = e.target.dataset.sectionNum;
        navItems.forEach(n => n.classList.toggle("active", n.dataset.section === num));
      }
    });
  }, { rootMargin: "-20% 0px -70% 0px" });
  sections.forEach(s => obs.observe(s));

  // ── Search filter ──
  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    const q = search.value.toLowerCase();
    navItems.forEach(item => {
      const txt = item.textContent.toLowerCase();
      item.style.display = q && !txt.includes(q) ? "none" : "";
    });
  });

  // ── Copy section markdown ──
  const toast = document.getElementById("toast");
  const toastMsg = document.getElementById("toast-msg");
  function showToast(msg) {
    toastMsg.textContent = msg;
    toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("show"), 2400);
  }
  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(label || "Copied to clipboard");
      return true;
    } catch (e) {
      showToast("Copy failed");
      return false;
    }
  }
  document.querySelectorAll(".copy-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const tpl = document.getElementById(btn.dataset.target);
      if (!tpl) return;
      const md = tpl.innerHTML.replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">");
      const ok = await copyText(md.trim(), "Section markdown copied");
      if (ok) {
        btn.classList.add("copied");
        const lbl = btn.querySelector(".copy-label");
        if (lbl) { const old = lbl.textContent; lbl.textContent = "Copied"; setTimeout(()=>{lbl.textContent=old; btn.classList.remove("copied");},1800); }
      }
    });
  });

  // ── Copy all ──
  async function copyAll() {
    const r = await fetch("/raw");
    const t = await r.text();
    await copyText(t, "Full spec copied (" + (t.length/1024).toFixed(1) + " KB)");
  }
  document.getElementById("copy-all").addEventListener("click", copyAll);
  document.getElementById("hero-copy").addEventListener("click", copyAll);
</script>
</body>
</html>`;
}

const PAGE_HTML = buildPage();

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE_HTML);
  } else if (url === "/raw" || url === "/raw.md") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(MARKDOWN);
  } else if (url === "/llms.txt") {
    const llms = `# Cursoar API Codex

> Complete Cursoar platform API documentation: tRPC web routes, MCP HTTP (84 tools), REST endpoints, OAuth flows, and Prisma schema reference. Audience: developers and AI agents implementing against Cursoar.

## Surface map

- tRPC \`/api/trpc/*\` — Cursoar web UI · Clerk session cookie · 20 routers
- MCP HTTP \`/mcp\` — Agents (Claude, cowork) · Bearer token (mcp_*) · 84 tools
- REST attachments — Browser uploads/downloads · Clerk session
- REST OAuth — RFC 7591 dynamic client registration + PKCE
- REST realtime — SSE event stream

## Sections in this doc

01. Surface map
02. Authentication & authorization
03. tRPC routers
04. REST endpoints
05. Client portal access model
06. MCP tool reference (84 tools)
07. Realtime event bus
08. Schema cheat-sheet
09. Conventions to follow
10. Known gaps and TODO

## Full content

${req.headers.host ? `https://${req.headers.host}/raw` : "/raw"}

## Structured data

${req.headers.host ? `https://${req.headers.host}/api-json` : "/api-json"}
`;
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(llms);
  } else if (url === "/api-json") {
    const structure = {
      title: "Cursoar API Codex",
      surfaces: [
        { name: "tRPC", path: "/api/trpc/*", auth: "Clerk session cookie", consumer: "Cursoar web UI" },
        { name: "MCP HTTP", path: "/mcp", auth: "Bearer mcp_* token (sha256-hashed) or OAuth-issued", consumer: "Agents" },
        { name: "REST attachments", path: "/api/attachments/**", auth: "Clerk session cookie" },
        { name: "REST OAuth", path: "/api/oauth/**", auth: "OAuth 2.0 PKCE" },
        { name: "REST webhooks", path: "/api/webhooks/**", auth: "Clerk webhook signing secret" },
        { name: "REST realtime", path: "/api/realtime", auth: "Clerk session cookie" }
      ],
      trpc_procedures: ["publicProcedure", "protectedProcedure", "teamProcedure", "ownerProcedure", "clientPortalProcedure"],
      trpc_routers: ["workspace", "portfolio", "project", "task", "comment", "attachment", "clientPortal", "brainDump", "mcpToken", "oauthClient", "user", "notification", "chat", "audit", "reporting", "reportTemplate", "timeEntry", "customField", "sow", "workload", "team"],
      mcp_tool_count: 84,
      mcp_tool_categories: {
        tasks: ["create_task", "update_task", "list_tasks", "get_task", "assign_task", "unassign_task", "bulk_update_tasks", "move_task_to_section", "attach_file_to_task"],
        subtasks: ["create_subtask", "list_subtasks"],
        comments: ["add_comment", "list_comments"],
        sections: ["list_sections", "create_section", "delete_section"],
        projects: ["create_project", "update_project", "delete_project", "list_projects", "list_archived_projects", "archive_project", "unarchive_project", "add_project_member", "remove_project_member", "list_project_members", "export_project", "import_project"],
        portfolios: ["create_portfolio", "update_portfolio", "delete_portfolio", "list_portfolios", "add_project_to_portfolio", "remove_project_from_portfolio", "get_portfolio_status", "export_portfolio", "import_portfolio"],
        workspace: ["get_workspace_summary", "list_workspace_members", "search_users"],
        brain_dumps: ["list_brain_dumps", "create_brain_dump", "add_brain_dump_task", "triage_brain_dump_task"],
        reports: ["generate_report", "generate_ai_report", "send_report_email", "list_reports", "get_user_activity"],
        sow: ["parse_sow", "create_project_from_sow"],
        time_tracking: ["start_timer", "stop_timer", "get_active_timer", "list_time_entries", "add_time_entry", "delete_time_entry"],
        custom_fields: ["list_custom_fields", "set_custom_field_value", "create_custom_field"],
        dependencies: ["add_dependency", "remove_dependency", "list_dependencies"],
        workload: ["get_user_availability"],
        search: ["search_tasks", "list_tasks_due", "list_tasks_for_user", "list_stale_tasks"],
        self: ["my_tasks", "whoami"]
      },
      raw_markdown_url: "/raw",
      llms_txt_url: "/llms.txt"
    };
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify(structure, null, 2));
  } else if (url === "/logo.png") {
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    res.end(LOGO);
  } else if (url === "/favicon.png" || url === "/favicon.ico") {
    res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    res.end(FAVICON);
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Cursoar API Codex running on port ${PORT}`);
});
