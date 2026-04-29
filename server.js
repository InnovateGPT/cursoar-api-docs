import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ─── Markdown content ────────────────────────────────────────────────────────
const MARKDOWN = readFileSync(join(__dirname, "cursoar-api.md"), "utf8");

// ─── Minimal markdown → HTML renderer ────────────────────────────────────────
function mdToHtml(md) {
  let html = md
    // Escape HTML entities first (in code blocks only — handled below)
    // Code blocks (fenced)
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<pre><code class="language-${lang || "text"}">${escaped}</code></pre>`;
    })
    // Inline code
    .replace(/`([^`]+)`/g, (_, code) => {
      const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<code>${escaped}</code>`;
    })
    // H1–H4
    .replace(/^#### (.+)$/gm, (_, t) => `<h4 id="${slug(t)}">${t}</h4>`)
    .replace(/^### (.+)$/gm, (_, t) => `<h3 id="${slug(t)}">${t}</h3>`)
    .replace(/^## (.+)$/gm, (_, t) => `<h2 id="${slug(t)}">${t}</h2>`)
    .replace(/^# (.+)$/gm, (_, t) => `<h1 id="${slug(t)}">${t}</h1>`)
    // Blockquotes
    .replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>")
    // Bold / italic
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    // Horizontal rule
    .replace(/^---$/gm, "<hr>")
    // Tables — detect lines containing |
    .replace(/((?:^\|.+\|\s*\n)+)/gm, (block) => {
      const rows = block.trim().split("\n").filter(r => !r.match(/^\|\s*[-:]+/));
      if (rows.length < 1) return block;
      const parseRow = (row) =>
        row.split("|").slice(1, -1).map(cell => cell.trim());
      const [header, ...body] = rows;
      const heads = parseRow(header).map(h => `<th>${h}</th>`).join("");
      const bodyRows = body.map(r =>
        `<tr>${parseRow(r).map(c => `<td>${c}</td>`).join("")}</tr>`
      ).join("\n");
      return `<div class="table-wrap"><table><thead><tr>${heads}</tr></thead><tbody>${bodyRows}</tbody></table></div>`;
    })
    // Lists — unordered
    .replace(/((?:^- .+\n?)+)/gm, (block) => {
      const items = block.trim().split("\n").map(l => `<li>${l.replace(/^- /, "")}</li>`).join("\n");
      return `<ul>${items}</ul>`;
    })
    // Paragraphs — wrap orphan text lines
    .replace(/^(?!<[a-z/])(.+)$/gm, "<p>$1</p>")
    // Clean up empty paragraphs
    .replace(/<p><\/p>/g, "")
    .replace(/<p>\s*<\/p>/g, "");

  return html;
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ─── Extract TOC from headings ────────────────────────────────────────────────
function buildToc(md) {
  const entries = [];
  const re = /^(#{1,3}) (.+)$/gm;
  let m;
  while ((m = re.exec(md)) !== null) {
    const level = m[1].length;
    const text = m[2].replace(/\*\*/g, "").replace(/`/g, "");
    entries.push({ level, text, id: slug(text) });
  }
  return entries;
}

// ─── Build full HTML page ─────────────────────────────────────────────────────
function buildPage() {
  const toc = buildToc(MARKDOWN);
  const body = mdToHtml(MARKDOWN);

  const tocHtml = toc.map(({ level, text, id }) =>
    `<a href="#${id}" class="toc-l${level}">${text}</a>`
  ).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cursoar API Reference</title>
  <style>
    :root {
      --bg: #0f1117;
      --sidebar: #161b22;
      --surface: #1c2128;
      --border: #30363d;
      --accent: #58a6ff;
      --accent2: #3fb950;
      --text: #e6edf3;
      --muted: #8b949e;
      --code-bg: #161b22;
      --table-header: #21262d;
      --sidebar-w: 280px;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      font-size: 15px;
      line-height: 1.7;
    }

    /* ── Header ── */
    header {
      position: fixed; top: 0; left: 0; right: 0; z-index: 100;
      background: rgba(15,17,23,0.95);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 24px; height: 56px;
    }
    .logo { display: flex; align-items: center; gap: 10px; }
    .logo-badge {
      background: linear-gradient(135deg, var(--accent), #a371f7);
      color: #fff; font-size: 11px; font-weight: 700;
      padding: 2px 8px; border-radius: 4px; letter-spacing: .5px;
    }
    .logo-text { font-weight: 600; font-size: 16px; }
    .logo-sub { font-size: 13px; color: var(--muted); margin-left: 4px; }
    .header-links { display: flex; gap: 16px; }
    .header-links a {
      color: var(--muted); text-decoration: none; font-size: 13px;
      padding: 4px 10px; border-radius: 6px; transition: all .15s;
    }
    .header-links a:hover { color: var(--text); background: var(--surface); }
    .badge-pill {
      background: var(--surface); color: var(--accent2);
      font-size: 11px; font-weight: 600;
      padding: 2px 8px; border-radius: 20px;
      border: 1px solid var(--border);
    }

    /* ── Layout ── */
    .layout { display: flex; padding-top: 56px; min-height: 100vh; }

    /* ── Sidebar ── */
    aside {
      position: fixed; left: 0; top: 56px; bottom: 0;
      width: var(--sidebar-w); overflow-y: auto;
      background: var(--sidebar);
      border-right: 1px solid var(--border);
      padding: 20px 0;
    }
    .sidebar-title {
      font-size: 11px; font-weight: 700; letter-spacing: .8px;
      color: var(--muted); text-transform: uppercase;
      padding: 0 16px 8px;
    }
    aside a {
      display: block; color: var(--muted);
      text-decoration: none; padding: 3px 16px;
      font-size: 13px; transition: all .1s;
      border-left: 2px solid transparent;
      line-height: 1.5;
    }
    aside a:hover { color: var(--text); background: var(--surface); }
    aside a.active { color: var(--accent); border-left-color: var(--accent); background: rgba(88,166,255,0.06); }
    .toc-l1 { font-weight: 600; color: var(--text) !important; padding-top: 10px; }
    .toc-l2 { padding-left: 28px; }
    .toc-l3 { padding-left: 44px; font-size: 12px; }

    /* ── Main content ── */
    main {
      margin-left: var(--sidebar-w);
      flex: 1; max-width: 900px;
      padding: 40px 48px 80px;
    }

    /* ── Typography ── */
    h1 { font-size: 2rem; font-weight: 700; margin: 0 0 8px; color: #fff; }
    h1 + blockquote { margin-top: 0; }
    h2 {
      font-size: 1.35rem; font-weight: 600;
      margin: 48px 0 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
      color: #fff;
    }
    h3 { font-size: 1.05rem; font-weight: 600; margin: 28px 0 10px; color: var(--text); }
    h4 { font-size: .95rem; font-weight: 600; margin: 20px 0 8px; color: var(--muted); }
    p { margin: 0 0 12px; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    strong { color: #fff; font-weight: 600; }
    hr { border: none; border-top: 1px solid var(--border); margin: 32px 0; }

    blockquote {
      border-left: 3px solid var(--accent);
      padding: 12px 16px;
      margin: 16px 0;
      background: rgba(88,166,255,0.05);
      border-radius: 0 6px 6px 0;
      color: var(--muted);
    }
    blockquote strong { color: var(--text); }
    blockquote p { margin: 0; }

    /* ── Code ── */
    code {
      font-family: "SF Mono", "Cascadia Code", Consolas, monospace;
      font-size: .85em;
      background: var(--code-bg);
      padding: 2px 6px; border-radius: 4px;
      color: #f97583;
      border: 1px solid var(--border);
    }
    pre {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 20px;
      overflow-x: auto;
      margin: 16px 0;
    }
    pre code {
      background: none; border: none;
      padding: 0; color: #e6edf3;
      font-size: .875rem; line-height: 1.6;
    }

    /* ── Tables ── */
    .table-wrap { overflow-x: auto; margin: 16px 0; border-radius: 8px; border: 1px solid var(--border); }
    table { width: 100%; border-collapse: collapse; }
    th {
      background: var(--table-header);
      color: var(--text); font-size: 12px; font-weight: 600;
      text-align: left; padding: 10px 14px;
      border-bottom: 1px solid var(--border);
    }
    td { padding: 9px 14px; border-bottom: 1px solid var(--border); font-size: 14px; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255,255,255,0.02); }

    /* ── Lists ── */
    ul, ol { padding-left: 24px; margin: 8px 0 12px; }
    li { margin: 4px 0; }

    /* ── Search ── */
    .search-wrap { padding: 0 12px 16px; }
    #search {
      width: 100%; background: var(--surface);
      border: 1px solid var(--border); border-radius: 6px;
      color: var(--text); font-size: 13px;
      padding: 7px 10px; outline: none;
    }
    #search:focus { border-color: var(--accent); }
    #search::placeholder { color: var(--muted); }

    /* ── LLM-friendly callout ── */
    .llm-bar {
      display: flex; gap: 8px; flex-wrap: wrap;
      margin-bottom: 24px;
    }
    .llm-bar a {
      display: inline-flex; align-items: center; gap: 5px;
      background: var(--surface); color: var(--muted);
      border: 1px solid var(--border); border-radius: 6px;
      padding: 5px 12px; font-size: 12px; font-weight: 500;
      text-decoration: none; transition: all .15s;
    }
    .llm-bar a:hover { color: var(--text); border-color: var(--accent); }

    /* ── Responsive ── */
    @media (max-width: 768px) {
      aside { display: none; }
      main { margin-left: 0; padding: 24px 20px 60px; }
    }
  </style>
</head>
<body>

<header>
  <div class="logo">
    <span class="logo-badge">CURSOAR</span>
    <span class="logo-text">API Reference</span>
    <span class="logo-sub">/ Developer Docs</span>
  </div>
  <div class="header-links">
    <span class="badge-pill">84 MCP tools</span>
    <a href="/raw">Raw Markdown</a>
    <a href="/llms.txt">llms.txt</a>
  </div>
</header>

<div class="layout">
  <aside>
    <div class="sidebar-title">Documentation</div>
    <div class="search-wrap">
      <input id="search" type="text" placeholder="Filter sections..." autocomplete="off">
    </div>
    <nav id="toc">
${tocHtml}
    </nav>
  </aside>

  <main id="content">
    <div class="llm-bar">
      <a href="/raw" title="Raw markdown — paste directly into any LLM">📄 Raw Markdown</a>
      <a href="/llms.txt" title="llms.txt — optimised for LLM context windows"># llms.txt</a>
      <a href="/api-json" title="Machine-readable JSON structure">{ } JSON</a>
    </div>
    ${body}
  </main>
</div>

<script>
  // ── TOC search filter ──
  const searchEl = document.getElementById("search");
  const tocLinks = document.querySelectorAll("#toc a");
  searchEl.addEventListener("input", () => {
    const q = searchEl.value.toLowerCase();
    tocLinks.forEach(a => {
      a.style.display = q && !a.textContent.toLowerCase().includes(q) ? "none" : "";
    });
  });

  // ── Active TOC highlight on scroll ──
  const headings = document.querySelectorAll("main h1, main h2, main h3");
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        tocLinks.forEach(a => a.classList.remove("active"));
        const active = document.querySelector(\`#toc a[href="#\${e.target.id}"]\`);
        if (active) active.classList.add("active");
      }
    });
  }, { rootMargin: "-10% 0px -80% 0px" });
  headings.forEach(h => observer.observe(h));
</script>
</body>
</html>`;
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const PAGE_HTML = buildPage();

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
    // llms.txt standard — brief index + pointers
    const llms = `# Cursoar API Reference\n\n> The Cursoar platform API documentation covering tRPC, MCP HTTP (84 tools), REST endpoints, OAuth, and schema reference.\n\n## Sections\n\n- Surface map (tRPC, MCP HTTP, REST, OAuth, Realtime)\n- Authentication (Clerk sessions, tRPC tiers, MCP token auth)\n- tRPC routers (20 routers: workspace, project, task, portfolio, brainDump, mcpToken, etc.)\n- REST endpoints (attachments, OAuth PKCE, webhooks, realtime SSE)\n- Client portal access model (3-gate visibility system)\n- MCP tool reference (84 tools — full verb_noun listing)\n- Realtime event bus (in-memory pub/sub, event types)\n- Prisma schema cheat-sheet\n- Conventions (procedure tiers, ACL, audit logging, file uploads)\n- Known gaps and TODO\n\n## Full content\n\n${req.headers.host ? `https://${req.headers.host}/raw` : "/raw"}\n`;
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(llms);
  } else if (url === "/api-json") {
    // Machine-readable structure summary
    const structure = {
      title: "Cursoar API Reference",
      surfaces: ["tRPC /api/trpc/*", "MCP HTTP /mcp", "REST /api/attachments", "REST /api/oauth", "REST /api/realtime"],
      auth: ["Clerk session cookie", "Bearer mcp_* token", "OAuth 2.0 PKCE"],
      trpc_routers: ["workspace", "portfolio", "project", "task", "comment", "attachment", "clientPortal", "brainDump", "mcpToken", "oauthClient", "user", "notification", "chat", "audit", "reporting", "reportTemplate", "timeEntry", "customField", "sow", "workload", "team"],
      mcp_tool_count: 84,
      mcp_tools: {
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
  } else {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`Cursoar API Docs running on port ${PORT}`);
});
