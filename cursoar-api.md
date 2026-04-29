# Cursoar API Reference

> **Audience:** Phil, Jiarong, dev team. Single doc covering every API surface
> the Cursoar app exposes — tRPC (web app), MCP HTTP (agents), and the few
> standalone REST routes (auth, attachments, OAuth, realtime).
>
> **Source of truth:** the code in `apps/web/src/server/trpc/routers/` and
> `apps/web/src/app/mcp/route.ts`. This doc is a snapshot — when in doubt,
> the Zod input schemas in those files are authoritative.

---

## 1. Surface map

| Surface | Used by | Auth | Where it lives |
|---|---|---|---|
| **tRPC** (`/api/trpc/*`) | The Cursoar web UI | Clerk session cookie | `apps/web/src/server/trpc/routers/` |
| **MCP HTTP** (`/mcp`) | Agents (Claude, cowork, custom MCP clients) | Bearer token (sha256-hashed `mcp_*` tokens or OAuth-issued tokens) | `apps/web/src/app/mcp/route.ts` |
| **REST: attachments** | Browser uploads + downloads (binary) | Clerk session cookie | `apps/web/src/app/api/attachments/**` |
| **REST: OAuth** | Agent enrollment | OAuth 2.0 / PKCE | `apps/web/src/app/api/oauth/**` |
| **REST: webhooks** | Clerk → us | Clerk webhook signing secret | `apps/web/src/app/api/webhooks/**` |
| **REST: realtime** | Browser SSE subscription | Clerk session cookie | `apps/web/src/app/api/realtime/route.ts` |
| **Standalone MCP server** | Self-hosted dev only | Bearer token (matches web) | `packages/mcp-server/` — **not deployed in prod**, see §6 |

---

## 2. Authentication & authorization

### Clerk (browser sessions)
- The web app uses `@clerk/nextjs` with cookie-based sessions.
- Every page under `(dashboard)/**` and `(portal)/**` is protected by `apps/web/src/middleware.ts`.
- The route-group layout (`apps/web/src/app/(dashboard)/layout.tsx` and `(portal)/portal/layout.tsx`) does the **userType-based redirect**: a `User.userType === 'CLIENT'` is forced into `/portal`, anyone else away from it.
- Sandbox mode (`NEXT_PUBLIC_SANDBOX_MODE=true`) swaps Clerk for a single cookie `sandbox_user_id` — same code paths, different auth source.

### tRPC procedure tiers
Defined in `apps/web/src/server/trpc/index.ts`:

| Procedure | Gate |
|---|---|
| `publicProcedure` | None — anyone, including unauthenticated. Almost never used. |
| `protectedProcedure` | Logged-in user with `isActive: true`. |
| `teamProcedure` | `protectedProcedure` + **rejects `userType === 'CLIENT'`**. Use this for every team-router endpoint. |
| `ownerProcedure` | `teamProcedure` + must have `User.role` = `OWNER` or `ADMIN`. |
| `clientPortalProcedure` | `protectedProcedure` + **requires** `userType === 'CLIENT'`. Used only by the `clientPortal` router. |

Inside a procedure, additional row-level checks come from helpers in `apps/web/src/server/trpc/permissions.ts`:
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
- Token attribution: `auditSource = 'BOT'` for raw mcp tokens; `'MCP'` for OAuth-issued tokens (the OAuth token is named `OAuth (Claude)` or similar).
- ACL: `apps/web/src/app/mcp/permissions.ts` maps every tool to a `kind`: `workspace`, `project`, `task`, `tasks_array`, `portfolio`, `section`, `comment`, `notification`, `report`, `time_entry`, `self`, or `authenticated`. The `enforceToolAcl` function does the row-level check before any handler runs.

---

## 3. tRPC routers

Registered in `apps/web/src/server/trpc/router.ts`. 20 routers total. Naming convention: lowerCamel router name; procedure names lowercase or lowerCamel.

### `workspace`
- `list()` → user's workspaces with member + project counts
- `byId({ id })` → workspace with members + projects
- `members({ workspaceId })` → workspace member list (capped at 500)
- `create({ name, description? })` → new workspace; caller becomes OWNER
- `update({ id, name?, description? })` *(owner)*
- `delete({ id })` *(owner)*
- `invite({ workspaceId, email, role: 'ADMIN'|'MEMBER'|'GUEST'|'GUEST_CLIENT', clientProjectIds? })` — see §5 for the client-portal invite path
- `getPendingInvitations({ workspaceId })` *(owner/admin)*
- `cancelInvitation({ invitationId })` *(owner/admin)*
- `removeMember({ workspaceId, userId })` *(owner/admin)*

### `portfolio`
- `list({ workspaceId })` → portfolios with their projects + stats
- `byId({ id })` → portfolio + projects with health/progress
- `create({ workspaceId, name, description?, color?, icon?, projectIds? })`
- `update({ id, ... })`
- `delete({ id })`
- `addProject({ portfolioId, projectId })` / `removeProject({ portfolioId, projectId })`
- `import({ workspaceId, json })` — accepts a `parseExportPayload`-validated JSON

### `project`
- `list({ workspaceId, includeArchived?, includeBrainDumps?, status? })` → projects with sections, members, portfolio links, task summaries. **Brain dumps are filtered out by default**; pass `includeBrainDumps: true` to include them.
- `byId({ id })` → full project (sections, tasks, members, custom fields)
- `create({ workspaceId, name, description?, color? })` — auto-creates "To Do / In Progress / Done" sections
- `update({ id, name?, description?, color?, status?, health?, priority?, ownerId?, startDate?, dueDate?, budget? })`
- `delete({ id })` *(project admin)*
- `archive`, `unarchive`, `addMember`, `removeMember`, `getFavorites`, `toggleFavorite`, `export`, `import`, plus column-config CRUD for the table view

### `task`
The biggest router. Highlights:
- `list({ projectId, status?, sectionId?, priority?, search?, includeSubtasks?, externality? })`
- `byId({ id })`
- `myTasks()` — caller's open tasks across all workspaces (uses `myTasksMcp` style behavior)
- `create({ projectId, title, description?, status?, priority?, sectionId?, dueDate?, assigneeIds? })` — auto-adds assignees as project members
- `update({ id, title?, description?, status?, priority?, sectionId?, startDate?, dueDate?, estimatedMinutes?, actualMinutes?, showDescriptionOnCard?, showSubtasksOnCard?, isExternal? })`
- `delete({ id })`
- `move({ taskId, sectionId, position, columnTaskIds?, sourceColumnTaskIds?, sourceSectionId? })` — drag-and-drop on the kanban; **validates every supplied taskId belongs to the same project**
- `bulkUpdate({ taskIds, status?, priority?, dueDate?, startDate?, sectionId?, assigneeId? })` — used by the brain-dump bulk toolbar
- `bulkDelete({ taskIds })`
- `bulkMove({ taskIds, sectionId, ... })`
- Subtasks: `createSubtask`, `listSubtasks`, `reorderSubtasks`, `reparent`
- Dependencies: `getDependencies`, `addDependency`, `removeDependency`
- `timeline({ projectId })` — Gantt data
- `fixOrphanSections({ workspaceId })` *(owner)* — one-shot cleanup

### `comment`
- `list({ taskId })`, `create({ taskId, content, mentionedUserIds? })`, `update`, `delete`

### `attachment`
Metadata only — uploads + downloads are REST handlers (see §4).
- `list({ taskId })` → never selects the blob bytes
- `delete({ attachmentId })` — workspace admin / project member / original uploader can delete

### `clientPortal` *(client-portal users only)*
- `myTasks()` — all `isExternal: true` tasks across the client's projects
- `taskById({ taskId })` — task detail w/ comments + attachments (visibility-checked)
- `workspaceById({ workspaceId })` — minimal workspace info for the portal chrome
- `commentCreate({ taskId, content })` — posts a comment + writes Notification rows for every internal team member on the project

### `brainDump`
- `list({ workspaceId })` → workspace's brain dumps with active task counts
- `create({ workspaceId, name, color? })` → new brain-dump-kind Project
- `byId({ id })` → metadata + active/backlog counts
- `getActive({ id })` / `getBacklog({ id })`
- `addTask({ id, title, assigneeId? })` — bare-bones quick-add; refuses CLIENT assignees
- `triage({ taskId, targetProjectId })` — moves task to a real PROJECT-kind project; preserves `brainDumpOriginId` so backlog still surfaces it
- `bulkTriage({ taskIds, targetProjectId })` — batch triage with one transactional updateMany
- `endMeeting({ id })` — bulk-archive every active task; clears the active view to backlog
- `allActive({ workspaceId })` — every active task across every brain dump in workspace (powers `/brain-dumps/all`)

### `mcpToken` *(owner)*
- `list()`, `create({ workspaceId, name })`, `revoke({ tokenId })`

### `oauthClient` *(owner)*
- Pre-registered OAuth clients (alternative to DCR). `list / create / revoke`.

### Other routers
- `user` — `me`, `updateWorkspaceMemberRole`, etc.
- `notification` — `list`, `markRead`, `markAllRead`, `delete`
- `chat` — agentic chat conversations (workspace-scoped)
- `audit` — audit log search
- `reporting` / `reportTemplate` — generated reports + scheduled templates
- `timeEntry` — time tracking
- `customField` — workspace-scoped custom field definitions + values
- `sow` — SOW upload + parse + project bootstrap
- `workload` — capacity planning
- `team` (via `team` member of workspace) — team CRUD

---

## 4. REST endpoints

### Attachments

**`POST /api/attachments/upload`** *(Clerk session)*
Multipart form: `taskId` + `file`. 25 MB cap (Content-Length pre-checked at 30 MB). Content-type allowlist: png/jpg/gif/webp/svg, pdf, office docs, plain text, csv, zip. Streams into Postgres `attachment_blobs` table — no S3.

**`GET /api/attachments/[id]/download`** *(Clerk session)*
Streams bytes back with proper `Content-Type` and `Content-Disposition: attachment; filename*=UTF-8''<filename>`. CLIENT users are gated on `Task.isExternal === true` AND project membership.

### OAuth (for agent enrollment)

| Path | Method | Purpose |
|---|---|---|
| `/.well-known/oauth-authorization-server` | GET | OAuth metadata discovery |
| `/.well-known/oauth-protected-resource` | GET | RFC 9728 protected-resource metadata |
| `/api/oauth/register` | POST | Dynamic Client Registration (RFC 7591) |
| `/api/oauth/authorize` | POST | Issue auth code (PKCE only). Records `oauthClientId` on the code if a registered client is named. |
| `/api/oauth/token` | POST | Exchange auth code for an `mcp_*` bearer token. Validates PKCE, redirect_uri, code expiry, AND **re-checks the issuing client's `revokedAt` at redeem time**. |
| `/oauth/authorize` | GET | Browser consent UI (renders the authorize prompt) |

### Webhooks
- `POST /api/webhooks/clerk` — Clerk user lifecycle (sync to internal User table). Verifies the `svix-signature` header.

### Realtime
- `GET /api/realtime` — SSE stream of `task.*` / `project.*` / `comment.created` / `notification.created` events. Subscribers filter client-side. Single-server only (in-memory event bus, no Redis).

### Other
- `/api/sandbox/login` / `logout` / `me` — sandbox-mode auth (`NEXT_PUBLIC_SANDBOX_MODE=true` only)
- `/api/cron/send-reports` — scheduled report sender (Railway cron hits this)
- `/api/agents/register` / `me` — agent self-registration (issues an `mcp_*` token)

---

## 5. Client portal: who sees what

Three independent gates, **all enforced server-side**:

1. **`User.userType === 'CLIENT'`** — checked by `clientPortalProcedure`. Team routers go through `teamProcedure` which rejects clients.
2. **`Task.isExternal === true`** — every portal query/mutation joins on this. Default-private; the team explicitly toggles it on per task in `TaskDetail.tsx`.
3. **`ProjectMember` row** — the client must be on the project.

Cross-workspace safety guard: the `workspace.invite` and `accept-invite` paths refuse to flip an existing `TEAM_MEMBER` to `CLIENT` if they have other team workspace memberships — prevents global lockout.

MCP surface for clients: **none**. CLIENT users can't issue `mcp_*` tokens (`mcpToken.create` is `ownerProcedure` which extends `teamProcedure`), and the `/mcp` route doesn't currently check `userType` at the auth boundary — so if you ever hand a CLIENT a token directly, treat it as a hole and fix the MCP auth check.

---

## 6. MCP tool reference (84 tools)

All defined in `apps/web/src/app/mcp/route.ts`. Naming convention: `verb_noun` (snake_case).

**Tasks:** `create_task`, `update_task`, `list_tasks`, `get_task`, `assign_task`, `unassign_task`, `bulk_update_tasks`, `move_task_to_section`, `attach_file_to_task`

**Subtasks:** `create_subtask`, `list_subtasks`

**Comments:** `add_comment`, `list_comments`

**Sections:** `list_sections`, `create_section`, `delete_section`

**Projects:** `create_project`, `update_project`, `delete_project`, `list_projects`, `list_archived_projects`, `archive_project`, `unarchive_project`, `add_project_member`, `remove_project_member`, `list_project_members`, `export_project`, `import_project`

**Portfolios:** `create_portfolio`, `update_portfolio`, `delete_portfolio`, `list_portfolios`, `add_project_to_portfolio`, `remove_project_from_portfolio`, `get_portfolio_status`, `export_portfolio`, `import_portfolio`

**Workspace:** `get_workspace_summary`, `list_workspace_members`, `search_users`

**Brain dumps:** `list_brain_dumps`, `create_brain_dump`, `add_brain_dump_task`, `triage_brain_dump_task`

**Reports:** `generate_report`, `generate_ai_report`, `send_report_email`, `list_reports`, `get_user_activity`

**SOW:** `parse_sow`, `create_project_from_sow`

**Time tracking:** `start_timer`, `stop_timer`, `get_active_timer`, `list_time_entries`, `add_time_entry`, `delete_time_entry`

**Custom fields:** `list_custom_fields`, `set_custom_field_value`, `create_custom_field`

**Dependencies:** `add_dependency`, `remove_dependency`, `list_dependencies`

**Workload:** `get_user_availability`

**Search:** `search_tasks`, `list_tasks_due`, `list_tasks_for_user`, `list_stale_tasks`

**Self:** `my_tasks`, `whoami`

Each tool has:
- A Zod input schema (the source of truth for required/optional fields)
- A JSON-schema `inputSchema` in the `toolDefinitions` array (what agents see)
- A handler in `toolHandlers`
- An entry in `TOOL_ACL` (`apps/web/src/app/mcp/permissions.ts`) determining the row-level check

**Standalone MCP server (`packages/mcp-server/`)** — exists as a documented self-host option but **production deploys only run the web `/mcp` route** (per `scripts/start.sh`). The standalone server has a smaller tool set (subset of the web route).

---

## 7. Realtime event bus

In-memory pub/sub at `apps/web/src/lib/event-bus.ts`. Event types:
`task.updated`, `task.created`, `task.deleted`, `task.moved`, `task.subtasksReordered`, `comment.created`, `project.updated`, `project.sectionsReordered`, `notification.created`, `timer.started`, `timer.stopped`.

Payload always includes `projectId` and/or `taskId` so subscribers can filter. Single-server only — events are lost on deploy + don't fan out across instances. If we ever scale to multiple replicas, swap this for Redis pub/sub.

---

## 8. Schema cheat-sheet

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
 └── brainDumpOriginatedTasks (back-relation)

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

## 9. Conventions to follow

- **New tRPC procedure?** Default to `teamProcedure`. Use `ownerProcedure` for destructive workspace-wide ops. Use `clientPortalProcedure` only inside the `clientPortal` router.
- **New row?** If it's user-specific or workspace-specific, scope it via the equivalent `requireXxxAccess` helper at the top of the procedure.
- **New MCP tool?** Add to four places: Zod schema, `toolDefinitions` array, `toolHandlers` map, AND `TOOL_ACL` map in `permissions.ts`. Forgetting the ACL entry defaults to `authenticated` (loose); we should add a startup assertion catching this.
- **Audit logging?** Use `createAuditLog` from `@/lib/audit`. For MCP-originated mutations, pass `source: ctx?.auditSource ?? 'MCP'` and `agent: ctx?.agentName`.
- **File uploads?** Reuse `apps/web/src/lib/upload-policy.ts` (`isContentTypeAllowed`, `maxBytesFor`) — don't roll your own allowlist.
- **Realtime?** `eventBus.publish(...)` in any mutation that changes state visible to other users. Always include `projectId` so subscribers can filter.

---

## 10. What's missing / known gaps

- No automated test coverage on the audit-fixed P0 paths (token revocation, JSON.parse validation, bulk_update_tasks workspace check, OAuth client revocation). Worth backfilling regression tests.
- `TOOL_ACL` has no startup assertion — adding an MCP tool without an entry silently defaults to `authenticated`.
- OAuth client secrets are hashed with unsalted SHA-256 — should be HMAC-SHA-256 with a server-side pepper, or `argon2id`.
- Realtime is single-server in-memory — won't fan out across replicas.
- Pre-existing typecheck errors live in `chat.ts`, `chat-tools.ts`, `oauthClient.ts`, `ProjectHealthCell.tsx`, `ProjectPriorityCell.tsx`, `(dashboard)/tasks/page.tsx` (`FunnelStatus`/`FunnelPriority` undefined names). `next.config.ts` has `typescript.ignoreBuildErrors: true` so they don't block deploy, but they should get cleaned up.
