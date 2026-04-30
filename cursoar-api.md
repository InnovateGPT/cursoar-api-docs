# Cursoar API Reference

> Per-resource reference for every API surface Cursoar exposes — tRPC (web app),
> MCP HTTP (agents), and REST (auth, attachments, OAuth, realtime). Each endpoint
> ships with a cURL + JavaScript example and the expected JSON shape.
>
> **Source of truth:** `apps/web/src/server/trpc/routers/` and
> `apps/web/src/app/mcp/route.ts`. Zod input schemas are authoritative — this doc
> is a snapshot.

---

## 1. Surface map

| Surface | Used by | Auth | Where it lives |
|---|---|---|---|
| **tRPC** (`/api/trpc/*`) | The Cursoar web UI | Clerk session cookie | `apps/web/src/server/trpc/routers/` |
| **MCP HTTP** (`/mcp`) | Agents (Claude, cowork, custom MCP clients) | Bearer token (sha256-hashed `mcp_*` or OAuth-issued) | `apps/web/src/app/mcp/route.ts` |
| **REST: attachments** | Browser uploads + downloads (binary) | Clerk session cookie | `apps/web/src/app/api/attachments/**` |
| **REST: OAuth** | Agent enrollment | OAuth 2.0 / PKCE | `apps/web/src/app/api/oauth/**` |
| **REST: webhooks** | Clerk → us | Clerk webhook signing secret | `apps/web/src/app/api/webhooks/**` |
| **REST: realtime** | Browser SSE subscription | Clerk session cookie | `apps/web/src/app/api/realtime/route.ts` |

### Calling tRPC

`GET` for queries (input is URL-encoded JSON) and `POST` for mutations. Wire format is `{ "json": <input> }`; responses are wrapped as `{ "result": { "data": { "json": <output> } } }`.

```bash
curl 'https://app.cursoar.com/api/trpc/workspace.list?input=%7B%22json%22%3Anull%7D' \
  -H 'Cookie: __session=<clerk-session>'
```

```js
const res = await fetch('/api/trpc/workspace.list?input=' +
  encodeURIComponent(JSON.stringify({ json: null })));
const { result: { data: { json: workspaces } } } = await res.json();
```

```json
{
  "result": {
    "data": {
      "json": [
        { "id": "ws_01H...", "name": "Acme", "memberCount": 8, "projectCount": 12 }
      ]
    }
  }
}
```

### Calling MCP HTTP

The `/mcp` route speaks JSON-RPC 2.0 — `tools/list` to discover, `tools/call` to invoke. Bearer token in `Authorization`.

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_xxxxxxxxxxxxxxxx' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"my_tasks","arguments":{}}}'
```

```js
const r = await fetch('https://app.cursoar.com/mcp', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.CURSOAR_MCP_TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'tools/call',
    params: { name: 'my_tasks', arguments: {} }
  })
});
const { result } = await r.json();
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "[{\"id\":\"tsk_01H...\",\"title\":\"Ship docs\"}]" }]
  }
}
```

**Conventions used in this doc**

- `Auth:` — required tRPC procedure tier OR REST authentication mode.
- `Input:` — Zod input shape, in TS-ish notation. `?` = optional.
- `Returns:` — short description of the response payload.
- `ACL:` *(MCP only)* — the row-level kind that `enforceToolAcl` checks before the handler runs.
- Every example uses `https://app.cursoar.com` as the base URL — replace with your own deploy.

---

## 2. Authentication & authorization

### Clerk (browser sessions)

The web app uses `@clerk/nextjs` with cookie-based sessions. Every page under `(dashboard)/**` and `(portal)/**` is protected by `apps/web/src/middleware.ts`. Clients of the tRPC API send the `__session` Clerk cookie automatically when calling same-origin from the browser.

Sandbox mode (`NEXT_PUBLIC_SANDBOX_MODE=true`) swaps Clerk for a single cookie `sandbox_user_id` — same code paths, different auth source.

### tRPC procedure tiers

Defined in `apps/web/src/server/trpc/index.ts`:

| Procedure | Gate |
|---|---|
| `publicProcedure` | None — anyone, including unauthenticated. Almost never used. |
| `protectedProcedure` | Logged-in user with `isActive: true`. |
| `teamProcedure` | `protectedProcedure` + **rejects `userType === 'CLIENT'`**. Use this for every team-router endpoint. |
| `ownerProcedure` | `teamProcedure` + must have `User.role` = `OWNER` or `ADMIN`. |
| `clientPortalProcedure` | `protectedProcedure` + **requires** `userType === 'CLIENT'`. Used only by the `clientPortal` router. |

### Row-level access helpers

Inside a procedure, additional row-level checks come from `apps/web/src/server/trpc/permissions.ts`:

- `requireWorkspaceMember(ctx, workspaceId)`
- `requireWorkspaceAdmin(ctx, workspaceId)` — OWNER or ADMIN of the workspace
- `requireProjectAccess(ctx, projectId)` — workspace member + (admin OR project member)
- `requireProjectAdmin(ctx, projectId)` — workspace admin OR project owner
- `requireTaskAccess(ctx, taskId)` — resolves task → project, then `requireProjectAccess`
- `requirePortfolioAccess(ctx, portfolioId)` / `requirePortfolioAdmin`
- `requireClientPortalTaskAccess(ctx, taskId)` — CLIENT-only path; checks `userType === 'CLIENT'`, `Task.isExternal === true`, and project membership

### MCP token auth

- `mcp_*` raw tokens are issued by `mcpToken.create` (workspace admin only) and shown to the user once.
- DB stores the **sha256 hash** in `McpToken.token`.
- Every MCP request hashes the bearer header and looks it up. Tokens with `revokedAt !== null` are rejected.
- `auditSource = 'BOT'` for raw mcp tokens; `'MCP'` for OAuth-issued tokens.
- `apps/web/src/app/mcp/permissions.ts` maps every tool to a `kind`. The `enforceToolAcl` function does the row-level check before any handler runs.

### Error envelope

tRPC errors follow the standard tRPC v10 shape:

```json
{
  "error": {
    "json": {
      "message": "FORBIDDEN: not a workspace member",
      "code": -32003,
      "data": { "code": "FORBIDDEN", "httpStatus": 403, "path": "workspace.byId" }
    }
  }
}
```

MCP errors use JSON-RPC 2.0:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32602, "message": "Invalid params: projectId required" }
}
```

---

## 3. Workspaces

The top-level container. A workspace owns projects, portfolios, members, teams, custom fields, tags, and audit logs.

### tRPC: `workspace.list`

**Auth:** `teamProcedure` · **Returns:** array of workspaces the caller is a member of.

```bash
curl 'https://app.cursoar.com/api/trpc/workspace.list?input=%7B%22json%22%3Anull%7D' \
  -H 'Cookie: __session=<clerk>'
```

```js
const res = await fetch('/api/trpc/workspace.list?input=' +
  encodeURIComponent(JSON.stringify({ json: null })));
const { result: { data: { json } } } = await res.json();
```

```json
{
  "result": {
    "data": {
      "json": [
        {
          "id": "ws_01HXYZ",
          "name": "Acme",
          "description": "Internal projects",
          "memberCount": 8,
          "projectCount": 12,
          "createdAt": "2026-02-14T08:30:00.000Z"
        }
      ]
    }
  }
}
```

### tRPC: `workspace.byId`

**Auth:** `teamProcedure` + `requireWorkspaceMember` · **Input:** `{ id: string }` · **Returns:** workspace with members + projects.

```bash
curl 'https://app.cursoar.com/api/trpc/workspace.byId?input=%7B%22json%22%3A%7B%22id%22%3A%22ws_01HXYZ%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "ws_01HXYZ",
        "name": "Acme",
        "members": [
          { "userId": "usr_01H...", "role": "OWNER", "user": { "name": "Alex", "email": "alex@acme.com" } }
        ],
        "projects": [
          { "id": "prj_01H...", "name": "Onboarding", "kind": "PROJECT", "status": "ACTIVE" }
        ]
      }
    }
  }
}
```

### tRPC: `workspace.members`

**Auth:** `teamProcedure` + `requireWorkspaceMember` · **Input:** `{ workspaceId: string }` · **Returns:** member list (capped at 500).

```bash
curl 'https://app.cursoar.com/api/trpc/workspace.members?input=%7B%22json%22%3A%7B%22workspaceId%22%3A%22ws_01HXYZ%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        {
          "userId": "usr_01H...",
          "role": "ADMIN",
          "user": { "id": "usr_01H...", "name": "Riley", "email": "riley@acme.com", "userType": "TEAM_MEMBER" }
        }
      ]
    }
  }
}
```

### tRPC: `workspace.create`

**Auth:** `protectedProcedure` · **Input:** `{ name: string, description?: string }` · **Returns:** the new workspace. Caller becomes OWNER.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/workspace.create' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"name":"Acme","description":"Our team"}}'
```

```js
await fetch('/api/trpc/workspace.create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ json: { name: 'Acme', description: 'Our team' } })
});
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "ws_01HXYZ",
        "name": "Acme",
        "description": "Our team",
        "createdAt": "2026-04-30T10:00:00.000Z"
      }
    }
  }
}
```

### tRPC: `workspace.update`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin` · **Input:** `{ id, name?, description? }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/workspace.update' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"id":"ws_01HXYZ","name":"Acme Corp"}}'
```

```json
{ "result": { "data": { "json": { "id": "ws_01HXYZ", "name": "Acme Corp" } } } }
```

### tRPC: `workspace.delete`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin` · **Input:** `{ id: string }`. Cascades through projects, tasks, attachments.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/workspace.delete' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"id":"ws_01HXYZ"}}'
```

```json
{ "result": { "data": { "json": { "success": true } } } }
```

### tRPC: `workspace.invite`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ workspaceId, email, role: 'ADMIN'|'MEMBER'|'GUEST'|'GUEST_CLIENT', clientProjectIds?: string[] }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/workspace.invite' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"workspaceId":"ws_01HXYZ","email":"client@example.com","role":"GUEST_CLIENT","clientProjectIds":["prj_01H..."]}}'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "inv_01H...",
        "email": "client@example.com",
        "role": "GUEST_CLIENT",
        "expiresAt": "2026-05-07T10:00:00.000Z",
        "status": "PENDING"
      }
    }
  }
}
```

### tRPC: `workspace.getPendingInvitations`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin` · **Input:** `{ workspaceId: string }`

```bash
curl 'https://app.cursoar.com/api/trpc/workspace.getPendingInvitations?input=%7B%22json%22%3A%7B%22workspaceId%22%3A%22ws_01HXYZ%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        { "id": "inv_01H...", "email": "client@example.com", "role": "GUEST_CLIENT", "expiresAt": "2026-05-07T..." }
      ]
    }
  }
}
```

### tRPC: `workspace.cancelInvitation`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin` · **Input:** `{ invitationId: string }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/workspace.cancelInvitation' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"invitationId":"inv_01H..."}}'
```

```json
{ "result": { "data": { "json": { "success": true } } } }
```

### tRPC: `workspace.removeMember`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin` · **Input:** `{ workspaceId, userId }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/workspace.removeMember' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"workspaceId":"ws_01HXYZ","userId":"usr_01H..."}}'
```

```json
{ "result": { "data": { "json": { "success": true } } } }
```

### MCP: `get_workspace_summary`

**ACL:** `workspace` · **Input:** `{ workspaceId: string }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_workspace_summary","arguments":{"workspaceId":"ws_01HXYZ"}}}'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"projects\":12,\"members\":8,\"openTasks\":47,\"recentActivity\":18}"
    }]
  }
}
```

### MCP: `list_workspace_members`

**ACL:** `workspace` · **Input:** `{ workspaceId: string }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_workspace_members","arguments":{"workspaceId":"ws_01HXYZ"}}}'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "[{\"userId\":\"usr_01H...\",\"role\":\"ADMIN\",\"name\":\"Riley\",\"email\":\"riley@acme.com\"}]" }]
  }
}
```

### MCP: `search_users`

**ACL:** `workspace` · **Input:** `{ workspaceId, query }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_users","arguments":{"workspaceId":"ws_01HXYZ","query":"riley"}}}'
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "[{\"id\":\"usr_01H...\",\"name\":\"Riley Park\",\"email\":\"riley@acme.com\"}]" }]
  }
}
```

---

## 4. Portfolios

A curated grouping of projects. One project can belong to multiple portfolios.

### tRPC: `portfolio.list`

**Auth:** `teamProcedure` + `requireWorkspaceMember` · **Input:** `{ workspaceId: string }`

```bash
curl 'https://app.cursoar.com/api/trpc/portfolio.list?input=%7B%22json%22%3A%7B%22workspaceId%22%3A%22ws_01HXYZ%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        {
          "id": "pf_01H...",
          "name": "Q2 Initiatives",
          "color": "#7CFF00",
          "projects": [
            { "id": "prj_01H...", "name": "Onboarding", "health": "ON_TRACK", "progress": 0.42 }
          ]
        }
      ]
    }
  }
}
```

### tRPC: `portfolio.byId`

**Auth:** `teamProcedure` + `requirePortfolioAccess` · **Input:** `{ id: string }`

```bash
curl 'https://app.cursoar.com/api/trpc/portfolio.byId?input=%7B%22json%22%3A%7B%22id%22%3A%22pf_01H...%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "pf_01H...",
        "name": "Q2 Initiatives",
        "projects": [
          { "id": "prj_01H...", "name": "Onboarding", "health": "ON_TRACK", "progress": 0.42, "openTasks": 14 }
        ]
      }
    }
  }
}
```

### tRPC: `portfolio.create`

**Auth:** `teamProcedure` + `requireWorkspaceMember` · **Input:** `{ workspaceId, name, description?, color?, icon?, projectIds? }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/portfolio.create' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"workspaceId":"ws_01HXYZ","name":"Q2 Initiatives","color":"#7CFF00","projectIds":["prj_01H..."]}}'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "pf_01H...",
        "name": "Q2 Initiatives",
        "color": "#7CFF00",
        "createdAt": "2026-04-30T10:00:00.000Z"
      }
    }
  }
}
```

### tRPC: `portfolio.update`

**Auth:** `teamProcedure` + `requirePortfolioAdmin` · **Input:** `{ id, name?, description?, color?, icon? }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/portfolio.update' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"id":"pf_01H...","name":"Q2 — Refreshed"}}'
```

```json
{ "result": { "data": { "json": { "id": "pf_01H...", "name": "Q2 — Refreshed" } } } }
```

### tRPC: `portfolio.delete`

**Auth:** `teamProcedure` + `requirePortfolioAdmin` · **Input:** `{ id: string }`. Member projects are unlinked, not deleted.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/portfolio.delete' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"id":"pf_01H..."}}'
```

```json
{ "result": { "data": { "json": { "success": true } } } }
```

### tRPC: `portfolio.addProject` / `portfolio.removeProject`

**Auth:** `teamProcedure` + `requirePortfolioAdmin` · **Input:** `{ portfolioId, projectId }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/portfolio.addProject' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"portfolioId":"pf_01H...","projectId":"prj_01H..."}}'
```

```json
{ "result": { "data": { "json": { "id": "pf_01H...", "projectIds": ["prj_01H...", "prj_02H..."] } } } }
```

### tRPC: `portfolio.import`

**Auth:** `teamProcedure` + `requireWorkspaceAdmin` · **Input:** `{ workspaceId, json: string }` — JSON validated by `parseExportPayload`.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/portfolio.import' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"workspaceId":"ws_01HXYZ","json":"{...export payload...}"}}'
```

```json
{
  "result": {
    "data": {
      "json": {
        "portfolio": { "id": "pf_01H...", "name": "Imported" },
        "projects": [{ "id": "prj_01H...", "name": "Onboarding" }]
      }
    }
  }
}
```

### MCP: `list_portfolios`

**ACL:** `workspace` · **Input:** `{ workspaceId: string }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_portfolios","arguments":{"workspaceId":"ws_01HXYZ"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "[{\"id\":\"pf_01H...\",\"name\":\"Q2 Initiatives\",\"projectCount\":4}]" }] }
}
```

### MCP: `get_portfolio_status`

**ACL:** `portfolio` · **Input:** `{ portfolioId: string }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_portfolio_status","arguments":{"portfolioId":"pf_01H..."}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "{\"onTrack\":3,\"atRisk\":1,\"offTrack\":0,\"progress\":0.58}" }] }
}
```

> Other MCP portfolio tools (`create_portfolio`, `update_portfolio`, `delete_portfolio`, `add_project_to_portfolio`, `remove_project_from_portfolio`, `export_portfolio`, `import_portfolio`) follow the same JSON-RPC envelope; their `arguments` mirror the tRPC input shapes documented above.

---

## 5. Projects

Holds sections, tasks, and members. `Project.kind` is `PROJECT` or `BRAIN_DUMP`; brain dumps are filtered out of `list` by default.

### tRPC: `project.list`

**Auth:** `teamProcedure` + `requireWorkspaceMember`
**Input:** `{ workspaceId, includeArchived?, includeBrainDumps?, status? }`

```bash
curl 'https://app.cursoar.com/api/trpc/project.list?input=%7B%22json%22%3A%7B%22workspaceId%22%3A%22ws_01HXYZ%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```js
const input = { workspaceId: 'ws_01HXYZ', status: 'ACTIVE' };
const res = await fetch('/api/trpc/project.list?input=' +
  encodeURIComponent(JSON.stringify({ json: input })));
const { result: { data: { json: projects } } } = await res.json();
```

```json
{
  "result": {
    "data": {
      "json": [
        {
          "id": "prj_01HABC",
          "name": "Onboarding",
          "kind": "PROJECT",
          "status": "ACTIVE",
          "health": "ON_TRACK",
          "color": "#7CFF00",
          "sections": [
            { "id": "sec_01H...", "name": "To Do", "position": 0 }
          ],
          "members": [{ "userId": "usr_01H...", "role": "OWNER" }],
          "taskSummary": { "total": 28, "open": 14, "done": 14 }
        }
      ]
    }
  }
}
```

### tRPC: `project.byId`

**Auth:** `teamProcedure` + `requireProjectAccess` · **Input:** `{ id: string }`

```bash
curl 'https://app.cursoar.com/api/trpc/project.byId?input=%7B%22json%22%3A%7B%22id%22%3A%22prj_01HABC%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "prj_01HABC",
        "name": "Onboarding",
        "sections": [{ "id": "sec_01H...", "name": "To Do" }],
        "tasks": [{ "id": "tsk_01H...", "title": "Kick off", "status": "TODO" }],
        "members": [{ "userId": "usr_01H...", "role": "MEMBER" }],
        "customFields": [{ "id": "cf_01H...", "name": "Effort", "type": "NUMBER" }]
      }
    }
  }
}
```

### tRPC: `project.create`

**Auth:** `teamProcedure` + `requireWorkspaceMember` · **Input:** `{ workspaceId, name, description?, color? }`. Auto-creates "To Do / In Progress / Done" sections.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/project.create' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"workspaceId":"ws_01HXYZ","name":"Onboarding","color":"#7CFF00"}}'
```

```js
await fetch('/api/trpc/project.create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ json: { workspaceId: 'ws_01HXYZ', name: 'Onboarding' } })
});
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "prj_01HABC",
        "name": "Onboarding",
        "kind": "PROJECT",
        "status": "ACTIVE",
        "sections": [
          { "id": "sec_01H1", "name": "To Do", "position": 0 },
          { "id": "sec_01H2", "name": "In Progress", "position": 1 },
          { "id": "sec_01H3", "name": "Done", "position": 2 }
        ]
      }
    }
  }
}
```

### tRPC: `project.update`

**Auth:** `teamProcedure` + `requireProjectAdmin`
**Input:** `{ id, name?, description?, color?, status?, health?, priority?, ownerId?, startDate?, dueDate?, budget? }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/project.update' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"id":"prj_01HABC","status":"ON_HOLD","health":"AT_RISK"}}'
```

```json
{ "result": { "data": { "json": { "id": "prj_01HABC", "status": "ON_HOLD", "health": "AT_RISK" } } } }
```

### tRPC: `project.delete` / `project.archive` / `project.unarchive`

**Auth:** `teamProcedure` + `requireProjectAdmin` · **Input:** `{ id: string }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/project.archive' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"id":"prj_01HABC"}}'
```

```json
{ "result": { "data": { "json": { "id": "prj_01HABC", "status": "ARCHIVED" } } } }
```

### tRPC: `project.addMember` / `project.removeMember`

**Auth:** `teamProcedure` + `requireProjectAdmin` · **Input:** `{ projectId, userId }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/project.addMember' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"projectId":"prj_01HABC","userId":"usr_01H..."}}'
```

```json
{ "result": { "data": { "json": { "projectId": "prj_01HABC", "userId": "usr_01H...", "role": "MEMBER" } } } }
```

### tRPC: `project.export` / `project.import`

```bash
curl 'https://app.cursoar.com/api/trpc/project.export?input=%7B%22json%22%3A%7B%22projectId%22%3A%22prj_01HABC%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": {
        "version": 1,
        "project": { "name": "Onboarding", "sections": [...], "tasks": [...] }
      }
    }
  }
}
```

### MCP: `list_projects`

**ACL:** `workspace` · **Input:** `{ workspaceId: string }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_projects","arguments":{"workspaceId":"ws_01HXYZ"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "[{\"id\":\"prj_01HABC\",\"name\":\"Onboarding\",\"status\":\"ACTIVE\",\"openTasks\":14}]" }]
  }
}
```

### MCP: `create_project`

**ACL:** `workspace` · **Input:** `{ workspaceId, name, description?, color? }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_project","arguments":{"workspaceId":"ws_01HXYZ","name":"Onboarding"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "{\"id\":\"prj_01HABC\",\"name\":\"Onboarding\",\"sections\":[{\"id\":\"sec_01H1\",\"name\":\"To Do\"}]}" }] }
}
```

> Other MCP project tools (`update_project`, `delete_project`, `archive_project`, `unarchive_project`, `add_project_member`, `remove_project_member`, `list_project_members`, `list_archived_projects`, `export_project`, `import_project`) follow the same envelope. The `arguments` object mirrors the equivalent tRPC input — substitute `projectId` for `id` where the procedure uses `id`.

---

## 6. Sections

Columns within a project's kanban. Auto-seeded as "To Do / In Progress / Done" on `project.create`.

### MCP: `list_sections`

**ACL:** `project` · **Input:** `{ projectId: string }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_sections","arguments":{"projectId":"prj_01HABC"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "[{\"id\":\"sec_01H1\",\"name\":\"To Do\",\"position\":0,\"taskCount\":7},{\"id\":\"sec_01H2\",\"name\":\"In Progress\",\"position\":1,\"taskCount\":4}]" }]
  }
}
```

### MCP: `create_section`

**ACL:** `project` · **Input:** `{ projectId, name, position? }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_section","arguments":{"projectId":"prj_01HABC","name":"Backlog"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "{\"id\":\"sec_01H...\",\"name\":\"Backlog\",\"position\":3}" }] }
}
```

### MCP: `delete_section`

**ACL:** `section` · **Input:** `{ sectionId: string }`. Tasks move to the project's first remaining section.

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delete_section","arguments":{"sectionId":"sec_01H..."}}}'
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"success\":true,\"reassignedTaskCount\":4}" }] } }
```

> Section CRUD on tRPC lives inside the `project` router (`project.createSection`, `project.updateSection`, `project.deleteSection`, `project.reorderSections`) — same auth tier (`teamProcedure` + `requireProjectAdmin`).

---

## 7. Tasks

The biggest router. Every task belongs to a project and a section.

### tRPC: `task.list`

**Auth:** `teamProcedure` + `requireProjectAccess`
**Input:** `{ projectId, status?, sectionId?, priority?, search?, includeSubtasks?, externality? }`

```bash
curl 'https://app.cursoar.com/api/trpc/task.list?input=%7B%22json%22%3A%7B%22projectId%22%3A%22prj_01HABC%22%2C%22status%22%3A%22TODO%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```js
const res = await fetch('/api/trpc/task.list?input=' +
  encodeURIComponent(JSON.stringify({ json: { projectId: 'prj_01HABC', status: 'TODO' } })));
```

```json
{
  "result": {
    "data": {
      "json": [
        {
          "id": "tsk_01HD",
          "title": "Kick off project",
          "description": null,
          "status": "TODO",
          "priority": "MEDIUM",
          "sectionId": "sec_01H1",
          "dueDate": "2026-05-10T00:00:00.000Z",
          "isExternal": false,
          "assignees": [{ "userId": "usr_01H...", "user": { "name": "Alex" } }],
          "commentCount": 2,
          "subtaskCount": 3
        }
      ]
    }
  }
}
```

### tRPC: `task.byId`

**Auth:** `teamProcedure` + `requireTaskAccess` · **Input:** `{ id: string }`

```bash
curl 'https://app.cursoar.com/api/trpc/task.byId?input=%7B%22json%22%3A%7B%22id%22%3A%22tsk_01HD%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "tsk_01HD",
        "title": "Kick off project",
        "status": "TODO",
        "comments": [{ "id": "cmt_01H...", "content": "Let's go!" }],
        "attachments": [{ "id": "att_01H...", "filename": "brief.pdf" }],
        "subtasks": [],
        "dependencies": [],
        "timeEntries": [],
        "customFieldValues": []
      }
    }
  }
}
```

### tRPC: `task.myTasks`

**Auth:** `teamProcedure` · **Returns:** caller's open tasks across every workspace.

```bash
curl 'https://app.cursoar.com/api/trpc/task.myTasks?input=%7B%22json%22%3Anull%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        { "id": "tsk_01H...", "title": "Review PRs", "projectName": "Platform", "dueDate": "2026-05-01T00:00:00Z" }
      ]
    }
  }
}
```

### tRPC: `task.create`

**Auth:** `teamProcedure` + `requireProjectAccess`
**Input:** `{ projectId, title, description?, status?, priority?, sectionId?, dueDate?, assigneeIds? }`. Assignees not yet on the project are auto-added.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/task.create' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"projectId":"prj_01HABC","title":"Ship docs","priority":"HIGH","assigneeIds":["usr_01H..."]}}'
```

```js
await fetch('/api/trpc/task.create', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    json: {
      projectId: 'prj_01HABC',
      title: 'Ship docs',
      priority: 'HIGH',
      dueDate: '2026-05-15T00:00:00Z',
      assigneeIds: ['usr_01H...']
    }
  })
});
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "tsk_01HD",
        "title": "Ship docs",
        "status": "TODO",
        "priority": "HIGH",
        "sectionId": "sec_01H1",
        "position": 0,
        "createdAt": "2026-04-30T10:00:00.000Z"
      }
    }
  }
}
```

### tRPC: `task.update`

**Auth:** `teamProcedure` + `requireTaskAccess`
**Input:** `{ id, title?, description?, status?, priority?, sectionId?, startDate?, dueDate?, estimatedMinutes?, actualMinutes?, showDescriptionOnCard?, showSubtasksOnCard?, isExternal? }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/task.update' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"id":"tsk_01HD","status":"IN_PROGRESS","isExternal":true}}'
```

```json
{ "result": { "data": { "json": { "id": "tsk_01HD", "status": "IN_PROGRESS", "isExternal": true } } } }
```

### tRPC: `task.delete`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/task.delete' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"id":"tsk_01HD"}}'
```

```json
{ "result": { "data": { "json": { "success": true } } } }
```

### tRPC: `task.move`

**Input:** `{ taskId, sectionId, position, columnTaskIds?, sourceColumnTaskIds?, sourceSectionId? }`. **Validates every supplied taskId belongs to the same project.**

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/task.move' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"taskId":"tsk_01HD","sectionId":"sec_01H2","position":0,"columnTaskIds":["tsk_01HD","tsk_01HE"]}}'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "tsk_01HD",
        "sectionId": "sec_01H2",
        "position": 0
      }
    }
  }
}
```

### tRPC: `task.bulkUpdate`

**Input:** `{ taskIds, status?, priority?, dueDate?, startDate?, sectionId?, assigneeId? }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/task.bulkUpdate' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"taskIds":["tsk_01HD","tsk_01HE"],"priority":"URGENT"}}'
```

```json
{ "result": { "data": { "json": { "updated": 2 } } } }
```

### tRPC: `task.bulkDelete` / `task.bulkMove`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/task.bulkDelete' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"taskIds":["tsk_01HD","tsk_01HE"]}}'
```

```json
{ "result": { "data": { "json": { "deleted": 2 } } } }
```

### tRPC: `task.timeline`

**Input:** `{ projectId: string }` — returns Gantt-shaped data.

```bash
curl 'https://app.cursoar.com/api/trpc/task.timeline?input=%7B%22json%22%3A%7B%22projectId%22%3A%22prj_01HABC%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": {
        "tasks": [
          { "id": "tsk_01HD", "title": "Kick off", "startDate": "2026-05-01", "dueDate": "2026-05-03" }
        ],
        "edges": [
          { "from": "tsk_01HD", "to": "tsk_01HE" }
        ]
      }
    }
  }
}
```

### tRPC: `task.fixOrphanSections` *(owner)*

**Input:** `{ workspaceId: string }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/task.fixOrphanSections' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"workspaceId":"ws_01HXYZ"}}'
```

```json
{ "result": { "data": { "json": { "repaired": 3 } } } }
```

### MCP: `create_task`

**ACL:** `project` · **Input:** mirrors `task.create` tRPC.

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_task","arguments":{"projectId":"prj_01HABC","title":"Ship docs","priority":"HIGH"}}}'
```

```js
await fetch('https://app.cursoar.com/mcp', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.CURSOAR_MCP_TOKEN}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1,
    method: 'tools/call',
    params: { name: 'create_task', arguments: { projectId: 'prj_01HABC', title: 'Ship docs', priority: 'HIGH' } }
  })
});
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "{\"id\":\"tsk_01HD\",\"title\":\"Ship docs\",\"status\":\"TODO\",\"priority\":\"HIGH\"}" }]
  }
}
```

### MCP: `update_task`

**ACL:** `task` · **Input:** `{ taskId, ...same fields as task.update }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_task","arguments":{"taskId":"tsk_01HD","status":"DONE"}}}'
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"id\":\"tsk_01HD\",\"status\":\"DONE\"}" }] } }
```

### MCP: `list_tasks` / `get_task`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tasks","arguments":{"projectId":"prj_01HABC","status":"TODO"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "[{\"id\":\"tsk_01HD\",\"title\":\"Ship docs\",\"status\":\"TODO\"}]" }] }
}
```

### MCP: `assign_task` / `unassign_task`

**Input:** `{ taskId, userId }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"assign_task","arguments":{"taskId":"tsk_01HD","userId":"usr_01H..."}}}'
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"taskId\":\"tsk_01HD\",\"assigneeIds\":[\"usr_01H...\"]}" }] } }
```

### MCP: `bulk_update_tasks`

**ACL:** `tasks_array` — every task ID is verified against the caller's accessible workspaces.

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"bulk_update_tasks","arguments":{"taskIds":["tsk_01HD","tsk_01HE"],"updates":{"priority":"URGENT"}}}}'
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"updated\":2}" }] } }
```

### MCP: `move_task_to_section`

**Input:** `{ taskId, sectionId, position? }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"move_task_to_section","arguments":{"taskId":"tsk_01HD","sectionId":"sec_01H2"}}}'
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"id\":\"tsk_01HD\",\"sectionId\":\"sec_01H2\"}" }] } }
```

### MCP: `attach_file_to_task`

**Input:** `{ taskId, filename, contentType, base64Body }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"attach_file_to_task","arguments":{"taskId":"tsk_01HD","filename":"brief.pdf","contentType":"application/pdf","base64Body":"JVBERi0xLjQKJ..."}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "{\"id\":\"att_01H...\",\"filename\":\"brief.pdf\",\"size\":12345,\"contentType\":\"application/pdf\"}" }] }
}
```

---

## 8. Subtasks & dependencies

### tRPC: `task.createSubtask`

**Input:** `{ parentId, title, ...same fields as task.create minus projectId }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/task.createSubtask' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"parentId":"tsk_01HD","title":"Draft outline"}}'
```

```json
{ "result": { "data": { "json": { "id": "tsk_01HSUB", "parentId": "tsk_01HD", "title": "Draft outline" } } } }
```

### tRPC: `task.listSubtasks` / `task.reorderSubtasks` / `task.reparent`

```bash
curl 'https://app.cursoar.com/api/trpc/task.listSubtasks?input=%7B%22json%22%3A%7B%22parentId%22%3A%22tsk_01HD%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        { "id": "tsk_01HSUB", "title": "Draft outline", "status": "TODO", "position": 0 }
      ]
    }
  }
}
```

### MCP: `create_subtask` / `list_subtasks`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_subtask","arguments":{"parentTaskId":"tsk_01HD","title":"Draft outline"}}}'
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"id\":\"tsk_01HSUB\",\"parentId\":\"tsk_01HD\"}" }] } }
```

### tRPC: `task.addDependency` / `task.removeDependency` / `task.getDependencies`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/task.addDependency' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"taskId":"tsk_01HD","dependsOnTaskId":"tsk_01HE"}}'
```

```json
{ "result": { "data": { "json": { "taskId": "tsk_01HD", "dependsOnTaskId": "tsk_01HE" } } } }
```

### MCP: `add_dependency` / `remove_dependency` / `list_dependencies`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_dependencies","arguments":{"taskId":"tsk_01HD"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "{\"dependsOn\":[{\"id\":\"tsk_01HE\",\"title\":\"Setup repo\"}],\"blockedBy\":[]}" }] }
}
```

---

## 9. Comments

### tRPC: `comment.list`

**Auth:** `teamProcedure` + `requireTaskAccess` · **Input:** `{ taskId: string }`

```bash
curl 'https://app.cursoar.com/api/trpc/comment.list?input=%7B%22json%22%3A%7B%22taskId%22%3A%22tsk_01HD%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        {
          "id": "cmt_01H...",
          "taskId": "tsk_01HD",
          "content": "Looks good!",
          "author": { "id": "usr_01H...", "name": "Alex" },
          "mentions": [],
          "createdAt": "2026-04-30T09:30:00.000Z"
        }
      ]
    }
  }
}
```

### tRPC: `comment.create`

**Input:** `{ taskId, content, mentionedUserIds? }`. Writes a `Notification` row for each mentioned user.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/comment.create' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"taskId":"tsk_01HD","content":"@alex thoughts?","mentionedUserIds":["usr_01H..."]}}'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "cmt_01H...",
        "taskId": "tsk_01HD",
        "content": "@alex thoughts?",
        "createdAt": "2026-04-30T10:00:00.000Z"
      }
    }
  }
}
```

### tRPC: `comment.update` / `comment.delete`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/comment.update' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"commentId":"cmt_01H...","content":"Updated text"}}'
```

```json
{ "result": { "data": { "json": { "id": "cmt_01H...", "content": "Updated text", "updatedAt": "2026-04-30T10:01:00Z" } } } }
```

### MCP: `add_comment` / `list_comments`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add_comment","arguments":{"taskId":"tsk_01HD","content":"Done."}}}'
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"id\":\"cmt_01H...\",\"taskId\":\"tsk_01HD\"}" }] } }
```

---

## 10. Attachments

Metadata is exposed on tRPC; binary upload/download happens via REST. Blobs live in Postgres `attachment_blobs` (BYTEA) — no S3.

### tRPC: `attachment.list`

**Input:** `{ taskId: string }` · Never selects the blob bytes.

```bash
curl 'https://app.cursoar.com/api/trpc/attachment.list?input=%7B%22json%22%3A%7B%22taskId%22%3A%22tsk_01HD%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        {
          "id": "att_01H...",
          "filename": "brief.pdf",
          "contentType": "application/pdf",
          "size": 1245789,
          "uploadedAt": "2026-04-30T10:00:00.000Z",
          "uploadedBy": { "id": "usr_01H...", "name": "Alex" }
        }
      ]
    }
  }
}
```

### tRPC: `attachment.delete`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/attachment.delete' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"attachmentId":"att_01H..."}}'
```

```json
{ "result": { "data": { "json": { "success": true } } } }
```

### REST: `POST /api/attachments/upload`

**Auth:** Clerk session cookie · **Body:** `multipart/form-data` — `taskId` + `file`. 25 MB cap; type allowlist enforced by `apps/web/src/lib/upload-policy.ts`.

```bash
curl -X POST 'https://app.cursoar.com/api/attachments/upload' \
  -H 'Cookie: __session=<clerk>' \
  -F 'taskId=tsk_01HD' \
  -F 'file=@./report.pdf'
```

```js
const fd = new FormData();
fd.append('taskId', 'tsk_01HD');
fd.append('file', fileInput.files[0]);
const res = await fetch('/api/attachments/upload', { method: 'POST', body: fd });
const { id, filename, size } = await res.json();
```

```json
{
  "id": "att_01H...",
  "filename": "report.pdf",
  "contentType": "application/pdf",
  "size": 1245789,
  "uploadedAt": "2026-04-30T10:00:00.000Z"
}
```

### REST: `GET /api/attachments/[id]/download`

**Auth:** Clerk session. CLIENT users gated on `Task.isExternal === true` AND project membership. Response is the raw bytes with `Content-Disposition: attachment`.

```bash
curl -O -J 'https://app.cursoar.com/api/attachments/att_01H.../download' \
  -H 'Cookie: __session=<clerk>'
```

```http
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Disposition: attachment; filename*=UTF-8''report.pdf
Content-Length: 1245789

<binary blob>
```

---

## 11. Brain dumps

A brain dump is a `Project` with `kind = BRAIN_DUMP`. Tasks split into "active" (not archived) and "backlog" (archived).

### tRPC: `brainDump.list`

```bash
curl 'https://app.cursoar.com/api/trpc/brainDump.list?input=%7B%22json%22%3A%7B%22workspaceId%22%3A%22ws_01HXYZ%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        { "id": "prj_01HBD", "name": "Standup notes 04/30", "kind": "BRAIN_DUMP", "activeCount": 7 }
      ]
    }
  }
}
```

### tRPC: `brainDump.create`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/brainDump.create' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"workspaceId":"ws_01HXYZ","name":"Standup notes 04/30","color":"#7CFF00"}}'
```

```json
{ "result": { "data": { "json": { "id": "prj_01HBD", "name": "Standup notes 04/30", "kind": "BRAIN_DUMP" } } } }
```

### tRPC: `brainDump.byId` / `brainDump.getActive` / `brainDump.getBacklog`

```bash
curl 'https://app.cursoar.com/api/trpc/brainDump.getActive?input=%7B%22json%22%3A%7B%22id%22%3A%22prj_01HBD%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        { "id": "tsk_01H...", "title": "Try Linear-style backlog", "archivedAt": null }
      ]
    }
  }
}
```

### tRPC: `brainDump.addTask`

**Input:** `{ id, title, assigneeId? }`. Refuses CLIENT assignees.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/brainDump.addTask' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"id":"prj_01HBD","title":"Try Linear-style backlog"}}'
```

```json
{ "result": { "data": { "json": { "id": "tsk_01H...", "title": "Try Linear-style backlog", "projectId": "prj_01HBD" } } } }
```

### tRPC: `brainDump.triage` / `brainDump.bulkTriage`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/brainDump.bulkTriage' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"taskIds":["tsk_01H1","tsk_01H2"],"targetProjectId":"prj_01HABC"}}'
```

```json
{ "result": { "data": { "json": { "moved": 2 } } } }
```

### tRPC: `brainDump.endMeeting`

Archives every active task — clears the active view to backlog.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/brainDump.endMeeting' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"id":"prj_01HBD"}}'
```

```json
{ "result": { "data": { "json": { "archived": 7 } } } }
```

### tRPC: `brainDump.allActive`

```bash
curl 'https://app.cursoar.com/api/trpc/brainDump.allActive?input=%7B%22json%22%3A%7B%22workspaceId%22%3A%22ws_01HXYZ%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        { "id": "tsk_01H...", "title": "Try Linear-style backlog", "brainDumpId": "prj_01HBD", "brainDumpName": "Standup 04/30" }
      ]
    }
  }
}
```

### MCP: `list_brain_dumps` / `create_brain_dump` / `add_brain_dump_task` / `triage_brain_dump_task`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add_brain_dump_task","arguments":{"brainDumpId":"prj_01HBD","title":"Try Linear-style backlog"}}}'
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"id\":\"tsk_01H...\",\"title\":\"Try Linear-style backlog\"}" }] } }
```

---

## 12. Time tracking

### MCP: `start_timer` / `stop_timer` / `get_active_timer`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"start_timer","arguments":{"taskId":"tsk_01HD"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "{\"id\":\"te_01H...\",\"taskId\":\"tsk_01HD\",\"startedAt\":\"2026-04-30T10:00:00Z\"}" }] }
}
```

### MCP: `list_time_entries`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_time_entries","arguments":{"taskId":"tsk_01HD"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "[{\"id\":\"te_01H...\",\"minutes\":42,\"author\":{\"name\":\"Alex\"}}]" }] }
}
```

### MCP: `add_time_entry`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add_time_entry","arguments":{"taskId":"tsk_01HD","minutes":30,"note":"Pairing session"}}}'
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"id\":\"te_01H...\",\"minutes\":30}" }] } }
```

> tRPC equivalents live in the `timeEntry` router, gated by `teamProcedure` + `requireTaskAccess`. Same input shapes as the MCP tools (drop the `te_` prefix in URL paths).

---

## 13. Client portal

CLIENT-userType users see a separate UI at `/portal` and a tightly-scoped tRPC router. **Three independent gates, all server-enforced:**

1. **`User.userType === 'CLIENT'`** — checked by `clientPortalProcedure`.
2. **`Task.isExternal === true`** — joined on every portal query.
3. **`ProjectMember`** — the client must be on the project.

Cross-workspace safety: invite paths refuse to flip an existing `TEAM_MEMBER` to `CLIENT` if they have other team workspace memberships. CLIENT users **can't issue `mcp_*` tokens** — `mcpToken.create` is `ownerProcedure`.

### tRPC: `clientPortal.myTasks`

```bash
curl 'https://app.cursoar.com/api/trpc/clientPortal.myTasks?input=%7B%22json%22%3Anull%7D' \
  -H 'Cookie: __session=<clerk-client>'
```

```json
{
  "result": {
    "data": {
      "json": [
        {
          "id": "tsk_01HEXT",
          "title": "Approve creative concept",
          "isExternal": true,
          "project": { "id": "prj_01H...", "name": "Brand refresh" },
          "dueDate": "2026-05-05T00:00:00.000Z"
        }
      ]
    }
  }
}
```

### tRPC: `clientPortal.taskById`

```bash
curl 'https://app.cursoar.com/api/trpc/clientPortal.taskById?input=%7B%22json%22%3A%7B%22taskId%22%3A%22tsk_01HEXT%22%7D%7D' \
  -H 'Cookie: __session=<clerk-client>'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "tsk_01HEXT",
        "title": "Approve creative concept",
        "comments": [{ "id": "cmt_01H...", "content": "Round 2 ready" }],
        "attachments": [{ "id": "att_01H...", "filename": "concept.pdf" }]
      }
    }
  }
}
```

### tRPC: `clientPortal.workspaceById`

```bash
curl 'https://app.cursoar.com/api/trpc/clientPortal.workspaceById?input=%7B%22json%22%3A%7B%22workspaceId%22%3A%22ws_01HXYZ%22%7D%7D' \
  -H 'Cookie: __session=<clerk-client>'
```

```json
{ "result": { "data": { "json": { "id": "ws_01HXYZ", "name": "Acme", "logoUrl": null, "color": "#7CFF00" } } } }
```

### tRPC: `clientPortal.commentCreate`

Posts a comment + writes `Notification` rows for every internal team member on the project.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/clientPortal.commentCreate' \
  -H 'Cookie: __session=<clerk-client>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"taskId":"tsk_01HEXT","content":"Approved!"}}'
```

```json
{ "result": { "data": { "json": { "id": "cmt_01H...", "taskId": "tsk_01HEXT", "content": "Approved!" } } } }
```

---

## 14. Reports

### MCP: `generate_report`

**Input:** `{ workspaceId, type: 'STATUS'|'WEEKLY'|'CUSTOM', scope: { projectId?, portfolioId?, userId? }, rangeStart?, rangeEnd? }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_report","arguments":{"workspaceId":"ws_01HXYZ","type":"WEEKLY","scope":{"projectId":"prj_01HABC"}}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"id\":\"rpt_01H...\",\"type\":\"WEEKLY\",\"sections\":[{\"title\":\"Completed\",\"items\":[\"Ship docs\",\"Fix login\"]}]}"
    }]
  }
}
```

### MCP: `generate_ai_report`

Same as `generate_report` plus optional `prompt` for steering the LLM summary.

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"generate_ai_report","arguments":{"workspaceId":"ws_01HXYZ","type":"WEEKLY","scope":{},"prompt":"Highlight at-risk projects"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "{\"id\":\"rpt_01H...\",\"narrative\":\"Two projects are at risk this week...\"}" }] }
}
```

### MCP: `send_report_email`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_report_email","arguments":{"reportId":"rpt_01H...","to":["client@example.com"],"subject":"Weekly status"}}}'
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"sent\":true,\"recipients\":1}" }] } }
```

### MCP: `list_reports` / `get_user_activity`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_user_activity","arguments":{"workspaceId":"ws_01HXYZ","userId":"usr_01H...","rangeStart":"2026-04-01","rangeEnd":"2026-04-30"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "{\"days\":[{\"date\":\"2026-04-29\",\"completed\":3,\"updated\":7}]}" }] }
}
```

> Cron: `GET /api/cron/send-reports` is hit by Railway's scheduled jobs. Auth: `Authorization: Bearer ${CRON_SECRET}`. Returns `{"processed": <n>}`.

---

## 15. SOW (Statement of Work)

Upload a SOW document, parse it, then bootstrap a project from the structured output.

### MCP: `parse_sow`

**Input:** `{ workspaceId, filename, contentType, base64Body }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"parse_sow","arguments":{"workspaceId":"ws_01HXYZ","filename":"sow.pdf","contentType":"application/pdf","base64Body":"JVBER..."}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"sowId\":\"sow_01H...\",\"title\":\"Brand refresh — Acme\",\"deliverables\":[{\"name\":\"Logo concepts\"}],\"milestones\":[{\"name\":\"M1: Discovery\",\"date\":\"2026-05-15\"}]}"
    }]
  }
}
```

### MCP: `create_project_from_sow`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_project_from_sow","arguments":{"sowId":"sow_01H...","projectName":"Acme — Brand refresh"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "{\"projectId\":\"prj_01HSOW\",\"sectionsCreated\":3,\"tasksCreated\":12}" }]
  }
}
```

---

## 16. Custom fields

Workspace-scoped field definitions plus per-task values.

### MCP: `list_custom_fields`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_custom_fields","arguments":{"workspaceId":"ws_01HXYZ"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "[{\"id\":\"cf_01H...\",\"name\":\"Effort\",\"type\":\"NUMBER\"},{\"id\":\"cf_02H...\",\"name\":\"Stage\",\"type\":\"SELECT\",\"options\":[\"Discovery\",\"Build\",\"QA\"]}]" }]
  }
}
```

### MCP: `create_custom_field`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_custom_field","arguments":{"workspaceId":"ws_01HXYZ","name":"Effort","type":"NUMBER"}}}'
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"id\":\"cf_01H...\",\"name\":\"Effort\",\"type\":\"NUMBER\"}" }] } }
```

### MCP: `set_custom_field_value`

**Input:** `{ taskId, customFieldId, value: string | number | string[] | Date }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"set_custom_field_value","arguments":{"taskId":"tsk_01HD","customFieldId":"cf_01H...","value":5}}}'
```

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "content": [{ "type": "text", "text": "{\"taskId\":\"tsk_01HD\",\"customFieldId\":\"cf_01H...\",\"value\":5}" }] } }
```

> tRPC `customField` router has the same shape — `list`, `create`, `update`, `delete`, `setValue` procedures.

---

## 17. Workload

### MCP: `get_user_availability`

**Input:** `{ workspaceId, userId, rangeStart, rangeEnd }` — daily capacity vs assigned-task estimated minutes.

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_user_availability","arguments":{"workspaceId":"ws_01HXYZ","userId":"usr_01H...","rangeStart":"2026-05-01","rangeEnd":"2026-05-07"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"days\":[{\"date\":\"2026-05-01\",\"capacityMinutes\":480,\"assignedMinutes\":360,\"utilization\":0.75}]}"
    }]
  }
}
```

> tRPC `workload` router exposes broader views (utilization heatmaps, per-project capacity) under `teamProcedure` + `requireWorkspaceMember`.

---

## 18. Search & "self" tools

### MCP: `search_tasks`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search_tasks","arguments":{"workspaceId":"ws_01HXYZ","query":"docs","limit":10}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "[{\"id\":\"tsk_01HD\",\"title\":\"Ship docs\",\"projectName\":\"Onboarding\",\"score\":0.91}]" }]
  }
}
```

### MCP: `list_tasks_due`

**Input:** `{ workspaceId, before?, after? }`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_tasks_due","arguments":{"workspaceId":"ws_01HXYZ","before":"2026-05-07"}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "[{\"id\":\"tsk_01HD\",\"title\":\"Ship docs\",\"dueDate\":\"2026-05-05\"}]" }] }
}
```

### MCP: `list_tasks_for_user` / `list_stale_tasks`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_stale_tasks","arguments":{"workspaceId":"ws_01HXYZ","daysSinceUpdated":14}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": { "content": [{ "type": "text", "text": "[{\"id\":\"tsk_01H...\",\"title\":\"Old TODO\",\"updatedAt\":\"2026-04-10\"}]" }] }
}
```

### MCP: `my_tasks` / `whoami`

**ACL:** `self`

```bash
curl -X POST 'https://app.cursoar.com/mcp' \
  -H 'Authorization: Bearer mcp_...' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"whoami","arguments":{}}}'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "content": [{
      "type": "text",
      "text": "{\"userId\":\"usr_01H...\",\"name\":\"Alex\",\"email\":\"alex@acme.com\",\"auditSource\":\"BOT\",\"agentName\":\"claude-desktop\"}"
    }]
  }
}
```

---

## 19. Notifications

### tRPC: `notification.list`

**Input:** `{ unreadOnly?: boolean, limit?: number }`

```bash
curl 'https://app.cursoar.com/api/trpc/notification.list?input=%7B%22json%22%3A%7B%22unreadOnly%22%3Atrue%2C%22limit%22%3A20%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        {
          "id": "ntf_01H...",
          "type": "MENTION",
          "taskId": "tsk_01HD",
          "actor": { "id": "usr_01H...", "name": "Alex" },
          "readAt": null,
          "createdAt": "2026-04-30T10:00:00.000Z"
        }
      ]
    }
  }
}
```

### tRPC: `notification.markRead` / `notification.markAllRead` / `notification.delete`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/notification.markAllRead' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":null}'
```

```json
{ "result": { "data": { "json": { "marked": 14 } } } }
```

> No MCP exposure — notifications are inherently a UI concept.

---

## 20. Users

### tRPC: `user.me`

```bash
curl 'https://app.cursoar.com/api/trpc/user.me?input=%7B%22json%22%3Anull%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "usr_01H...",
        "name": "Alex",
        "email": "alex@acme.com",
        "userType": "TEAM_MEMBER",
        "role": "OWNER",
        "workspaceMemberships": [
          { "workspaceId": "ws_01HXYZ", "role": "OWNER" }
        ]
      }
    }
  }
}
```

### tRPC: `user.updateWorkspaceMemberRole`

**Input:** `{ workspaceId, userId, role: 'OWNER'|'ADMIN'|'MEMBER'|'GUEST'|'GUEST_CLIENT' }`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/user.updateWorkspaceMemberRole' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"workspaceId":"ws_01HXYZ","userId":"usr_01H...","role":"ADMIN"}}'
```

```json
{ "result": { "data": { "json": { "workspaceId": "ws_01HXYZ", "userId": "usr_01H...", "role": "ADMIN" } } } }
```

### tRPC: `user.update`

**Input:** `{ name?, avatarUrl?, timezone? }` — caller only.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/user.update' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"name":"Alex P.","timezone":"America/Los_Angeles"}}'
```

```json
{ "result": { "data": { "json": { "id": "usr_01H...", "name": "Alex P.", "timezone": "America/Los_Angeles" } } } }
```

---

## 21. MCP tokens

### tRPC: `mcpToken.list`

```bash
curl 'https://app.cursoar.com/api/trpc/mcpToken.list?input=%7B%22json%22%3A%7B%22workspaceId%22%3A%22ws_01HXYZ%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        {
          "id": "mt_01H...",
          "name": "Claude Desktop",
          "prefix": "mcp_xxxxxxxx",
          "lastUsedAt": "2026-04-30T09:00:00.000Z",
          "revokedAt": null,
          "createdAt": "2026-04-01T00:00:00.000Z"
        }
      ]
    }
  }
}
```

### tRPC: `mcpToken.create`

**Returns:** `{ id, name, token: 'mcp_...' }` — the only call that returns the raw token. UI shows it once.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/mcpToken.create' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"workspaceId":"ws_01HXYZ","name":"Claude Desktop"}}'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "mt_01H...",
        "name": "Claude Desktop",
        "token": "mcp_8f3j2k1l4m5n6o7p8q9r0s1t2u3v4w5x"
      }
    }
  }
}
```

### tRPC: `mcpToken.revoke`

Sets `revokedAt = now()`. Subsequent MCP requests bearing the token are rejected at auth.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/mcpToken.revoke' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"tokenId":"mt_01H..."}}'
```

```json
{ "result": { "data": { "json": { "success": true } } } }
```

---

## 22. OAuth clients

Pre-registered OAuth clients are an alternative to RFC 7591 Dynamic Client Registration.

### tRPC: `oauthClient.list`

```bash
curl 'https://app.cursoar.com/api/trpc/oauthClient.list?input=%7B%22json%22%3A%7B%22workspaceId%22%3A%22ws_01HXYZ%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        {
          "id": "oac_01H...",
          "name": "Internal CLI",
          "clientId": "cur_01H...",
          "redirectUris": ["http://localhost:8888/callback"],
          "revokedAt": null
        }
      ]
    }
  }
}
```

### tRPC: `oauthClient.create`

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/oauthClient.create' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"workspaceId":"ws_01HXYZ","name":"Internal CLI","redirectUris":["http://localhost:8888/callback"]}}'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "oac_01H...",
        "clientId": "cur_01H...",
        "clientSecret": "cur_secret_xxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

### tRPC: `oauthClient.revoke`

The token endpoint **re-checks the client's `revokedAt` at code-redeem time**, so existing auth codes are invalidated.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/oauthClient.revoke' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"clientId":"cur_01H..."}}'
```

```json
{ "result": { "data": { "json": { "success": true } } } }
```

---

## 23. Chat, audit, teams, report templates

### `chat`

Workspace-scoped agentic chat conversations. Procedures: `list`, `byId`, `create`, `sendMessage`, `delete`. Auth: `teamProcedure` + `requireWorkspaceMember`.

```bash
curl 'https://app.cursoar.com/api/trpc/chat.list?input=%7B%22json%22%3A%7B%22workspaceId%22%3A%22ws_01HXYZ%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": [
        { "id": "cv_01H...", "title": "Triage 04/30", "messageCount": 24, "createdAt": "2026-04-30T08:00:00Z" }
      ]
    }
  }
}
```

### `audit`

`audit.search({ workspaceId, actorId?, source?, kind?, rangeStart?, rangeEnd?, cursor? })` — cursor-paginated audit log. Auth: `ownerProcedure` + `requireWorkspaceAdmin`. Source values: `USER`, `MCP`, `BOT`, `SYSTEM`.

```bash
curl 'https://app.cursoar.com/api/trpc/audit.search?input=%7B%22json%22%3A%7B%22workspaceId%22%3A%22ws_01HXYZ%22%2C%22source%22%3A%22MCP%22%7D%7D' \
  -H 'Cookie: __session=<clerk>'
```

```json
{
  "result": {
    "data": {
      "json": {
        "items": [
          {
            "id": "al_01H...",
            "actor": { "id": "usr_01H...", "name": "Alex" },
            "source": "MCP",
            "agentName": "claude-desktop",
            "kind": "TASK_UPDATED",
            "targetId": "tsk_01HD",
            "createdAt": "2026-04-30T09:55:00.000Z"
          }
        ],
        "nextCursor": "al_01H..."
      }
    }
  }
}
```

### `team`

Workspace-scoped sub-teams. Procedures: `list`, `byId`, `create`, `update`, `delete`, `addMember`, `removeMember`.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/team.create' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"workspaceId":"ws_01HXYZ","name":"Design"}}'
```

```json
{ "result": { "data": { "json": { "id": "tm_01H...", "name": "Design", "memberCount": 0 } } } }
```

### `reportTemplate`

`list / create / update / delete / runNow` — scheduled report templates iterated by `/api/cron/send-reports`.

```bash
curl -X POST 'https://app.cursoar.com/api/trpc/reportTemplate.create' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"json":{"workspaceId":"ws_01HXYZ","name":"Weekly client digest","cron":"0 9 * * MON","scope":{"projectId":"prj_01HABC"},"recipients":["client@example.com"]}}'
```

```json
{
  "result": {
    "data": {
      "json": {
        "id": "rt_01H...",
        "name": "Weekly client digest",
        "cron": "0 9 * * MON",
        "nextRunAt": "2026-05-04T09:00:00.000Z"
      }
    }
  }
}
```

---

## 24. REST: OAuth (agent enrollment)

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/oauth-authorization-server` | OAuth server metadata |
| GET | `/.well-known/oauth-protected-resource` | RFC 9728 protected-resource metadata |
| POST | `/api/oauth/register` | Dynamic Client Registration (RFC 7591) |
| GET | `/oauth/authorize` | Browser consent UI |
| POST | `/api/oauth/authorize` | Issue auth code (PKCE only) |
| POST | `/api/oauth/token` | Exchange auth code for `mcp_*` bearer |

### GET `/.well-known/oauth-authorization-server`

```bash
curl 'https://app.cursoar.com/.well-known/oauth-authorization-server'
```

```json
{
  "issuer": "https://app.cursoar.com",
  "authorization_endpoint": "https://app.cursoar.com/oauth/authorize",
  "token_endpoint": "https://app.cursoar.com/api/oauth/token",
  "registration_endpoint": "https://app.cursoar.com/api/oauth/register",
  "code_challenge_methods_supported": ["S256"],
  "grant_types_supported": ["authorization_code"],
  "response_types_supported": ["code"]
}
```

### POST `/api/oauth/register`

**Auth:** none (per RFC 7591 unauthenticated DCR).

```bash
curl -X POST 'https://app.cursoar.com/api/oauth/register' \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"My Agent","redirect_uris":["http://localhost:8888/cb"],"grant_types":["authorization_code"],"response_types":["code"],"token_endpoint_auth_method":"none"}'
```

```json
{
  "client_id": "cur_01H...",
  "client_id_issued_at": 1714467600,
  "redirect_uris": ["http://localhost:8888/cb"],
  "grant_types": ["authorization_code"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "none"
}
```

### POST `/api/oauth/authorize`

**Auth:** Clerk session (the user must be logged in to consent).

```bash
curl -X POST 'https://app.cursoar.com/api/oauth/authorize' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"cur_01H...","redirect_uri":"http://localhost:8888/cb","code_challenge":"<S256>","code_challenge_method":"S256","state":"xyz"}'
```

```http
HTTP/1.1 302 Found
Location: http://localhost:8888/cb?code=ac_01H...&state=xyz
```

### POST `/api/oauth/token`

**Auth:** none (PKCE-verified). Validates redirect_uri, code expiry, AND **re-checks the issuing client's `revokedAt`**.

```bash
curl -X POST 'https://app.cursoar.com/api/oauth/token' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=authorization_code&code=ac_01H...&redirect_uri=http://localhost:8888/cb&code_verifier=<verifier>&client_id=cur_01H...'
```

```json
{
  "access_token": "mcp_8f3j2k1l4m5n6o7p8q9r0s1t2u3v4w5x",
  "token_type": "Bearer",
  "expires_in": 31536000
}
```

---

## 25. REST: webhooks, realtime, sandbox, agents

### POST `/api/webhooks/clerk`

**Auth:** Clerk webhook signing secret — verified via `svix-signature` header. Syncs to internal `User` table.

```bash
# Sent by Clerk, not callers — shape is Clerk's standard webhook envelope.
```

```json
{
  "type": "user.created",
  "data": {
    "id": "user_2abc...",
    "email_addresses": [{ "email_address": "new@acme.com" }]
  }
}
```

### GET `/api/realtime`

**Auth:** Clerk session. SSE stream emitting `task.*`, `project.*`, `comment.created`, `notification.created`, `timer.*`.

```bash
curl -N 'https://app.cursoar.com/api/realtime' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Accept: text/event-stream'
```

```js
const es = new EventSource('/api/realtime', { withCredentials: true });
es.addEventListener('task.updated', e => {
  const payload = JSON.parse(e.data);
  console.log('task changed', payload.taskId, payload.projectId);
});
```

```http
event: task.updated
data: {"taskId":"tsk_01HD","projectId":"prj_01HABC","status":"DONE","actorId":"usr_01H..."}

event: comment.created
data: {"commentId":"cmt_01H...","taskId":"tsk_01HD","projectId":"prj_01HABC"}
```

### Sandbox auth (only when `NEXT_PUBLIC_SANDBOX_MODE=true`)

```bash
curl -X POST 'https://app.cursoar.com/api/sandbox/login' \
  -H 'Content-Type: application/json' \
  -d '{"userId":"usr_01H..."}' \
  -c cookies.txt

curl 'https://app.cursoar.com/api/sandbox/me' -b cookies.txt
```

```json
{ "userId": "usr_01H..." }
```

### Agent self-registration

```bash
curl -X POST 'https://app.cursoar.com/api/agents/register' \
  -H 'Cookie: __session=<clerk>' \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"ws_01HXYZ","agentName":"my-cli","scopes":[]}'
```

```json
{
  "agentId": "agt_01H...",
  "agentName": "my-cli",
  "token": "mcp_8f3j2k1l4m5n6o7p8q9r0s1t2u3v4w5x"
}
```

### Cron

```bash
curl 'https://app.cursoar.com/api/cron/send-reports' \
  -H "Authorization: Bearer ${CRON_SECRET}"
```

```json
{ "processed": 7, "skipped": 2 }
```

---

## 26. Realtime event bus

In-memory pub/sub at `apps/web/src/lib/event-bus.ts`. Event types:

`task.updated`, `task.created`, `task.deleted`, `task.moved`, `task.subtasksReordered`, `comment.created`, `project.updated`, `project.sectionsReordered`, `notification.created`, `timer.started`, `timer.stopped`.

Payload always includes `projectId` and/or `taskId` so subscribers can filter. Single-server only — events are lost on deploy + don't fan out across instances. If we ever scale to multiple replicas, swap this for Redis pub/sub.

```js
// Server-side publish
import { eventBus } from '@/lib/event-bus';
eventBus.publish('task.moved', {
  taskId: task.id,
  projectId: task.projectId,
  fromSectionId: prevSection,
  toSectionId: task.sectionId,
  actorId: ctx.userId
});
```

```json
{
  "type": "task.moved",
  "taskId": "tsk_01HD",
  "projectId": "prj_01HABC",
  "fromSectionId": "sec_01H1",
  "toSectionId": "sec_01H2",
  "actorId": "usr_01H..."
}
```

---

## 27. Schema cheat-sheet

`packages/database/prisma/schema.prisma` is the source of truth. Quick map:

```
User
 ├── userType: TEAM_MEMBER | CLIENT       ← drives portal redirect
 ├── role: OWNER | ADMIN | TEAM_MEMBER | GUEST   ← legacy system role
 └── many: WorkspaceMember, ProjectMember, TaskAssignee, Notification, AuditLog, Attachment

Workspace
 ├── members: WorkspaceMember (role: OWNER | ADMIN | MEMBER | GUEST | GUEST_CLIENT)
 └── projects, portfolios, teams, invitations, customFields, tags, auditLogs

Project
 ├── kind: PROJECT | BRAIN_DUMP            ← brain dumps are Projects
 ├── status: ACTIVE | ON_HOLD | COMPLETED | ARCHIVED
 ├── visibility: PRIVATE | TEAM_ONLY | PUBLIC
 ├── sections, tasks, members
 └── brainDumpOriginatedTasks (back-relation) ├── clientsCanSeeAllTasks                       (auto-added)

Task
 ├── isExternal: bool                       ← client-portal exposure flag
 ├── isMilestone: bool
 ├── brainDumpOriginId: FK → Project        ← survives triage
 ├── archivedAt: DateTime?                  ← brain-dump active vs backlog
 ├── status, priority, dueDate, position, sectionId, parentId
 └── assignees, comments, attachments, tags, customFieldValues, dependencies, timeEntries

Attachment
 ├── contentType, size, source: TEAM | CLIENT
 ├── uploadedById → User
 └── blob: AttachmentBlob (1:1, BYTEA — Postgres-only, no S3)

McpToken
 ├── token: sha256 hash (raw shown to user once at creation)
 ├── revokedAt
 └── audit attribution flows from this

McpOAuthCode
 └── oauthClientId → OAuthClient (re-checked at token redeem)
```

---

## 28. Conventions & gaps

### When adding new code

- **New tRPC procedure?** Default to `teamProcedure`. Use `ownerProcedure` for destructive workspace-wide ops. Use `clientPortalProcedure` only inside the `clientPortal` router.
- **New row?** If it's user-specific or workspace-specific, scope it via the equivalent `requireXxxAccess` helper at the top of the procedure.
- **New MCP tool?** Add to four places: Zod schema, `toolDefinitions` array, `toolHandlers` map, AND `TOOL_ACL` map in `permissions.ts`. Forgetting the ACL entry defaults to `authenticated` (loose).
- **Audit logging?** Use `createAuditLog` from `@/lib/audit`. For MCP-originated mutations, pass `source: ctx?.auditSource ?? 'MCP'` and `agent: ctx?.agentName`.
- **File uploads?** Reuse `apps/web/src/lib/upload-policy.ts` (`isContentTypeAllowed`, `maxBytesFor`) — don't roll your own allowlist.
- **Realtime?** `eventBus.publish(...)` in any mutation that changes state visible to other users. Always include `projectId` so subscribers can filter.

### Known gaps

- No automated test coverage on the audit-fixed P0 paths (token revocation, JSON.parse validation, bulk_update_tasks workspace check, OAuth client revocation). Worth backfilling regression tests.
- `TOOL_ACL` has no startup assertion — adding an MCP tool without an entry silently defaults to `authenticated`.
- OAuth client secrets are hashed with unsalted SHA-256 — should be HMAC-SHA-256 with a server-side pepper, or `argon2id`.
- Realtime is single-server in-memory — won't fan out across replicas.
- Pre-existing typecheck errors live in `chat.ts`, `chat-tools.ts`, `oauthClient.ts`, `ProjectHealthCell.tsx`, `ProjectPriorityCell.tsx`, `(dashboard)/tasks/page.tsx`. `next.config.ts` has `typescript.ignoreBuildErrors: true` so they don't block deploy, but they should get cleaned up.
- Standalone MCP server in `packages/mcp-server/` exists for self-hosting but **production deploys only run the web `/mcp` route** (per `scripts/start.sh`). The standalone server has a smaller, subset toolset.
