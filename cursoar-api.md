# Cursoar API Reference

> Per-resource reference for every API surface Cursoar exposes — tRPC (web app),
> MCP HTTP (agents), and REST (auth, attachments, OAuth, realtime). Each resource
> below lists its tRPC procedures, MCP tools, and REST endpoints in one place.
>
> **Source of truth:** the code in `apps/web/src/server/trpc/routers/` and
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

**Conventions used in this doc**

- `Auth:` — required tRPC procedure tier OR REST authentication mode.
- `Input:` — Zod input shape, in TS-ish notation. `?` = optional.
- `Returns:` — short description of the response payload.
- `ACL:` *(MCP only)* — the row-level kind that `enforceToolAcl` checks before the handler runs.

---

## 2. Authentication & authorization

### Clerk (browser sessions)

The web app uses `@clerk/nextjs` with cookie-based sessions. Every page under `(dashboard)/**` and `(portal)/**` is protected by `apps/web/src/middleware.ts`. The route-group layouts (`apps/web/src/app/(dashboard)/layout.tsx`, `(portal)/portal/layout.tsx`) enforce the userType-based redirect: `User.userType === 'CLIENT'` is forced into `/portal`; anyone else is redirected away from it.

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
- `apps/web/src/app/mcp/permissions.ts` maps every tool to a `kind`: `workspace`, `project`, `task`, `tasks_array`, `portfolio`, `section`, `comment`, `notification`, `report`, `time_entry`, `self`, or `authenticated`. The `enforceToolAcl` function does the row-level check before any handler runs.

---

## 3. Workspaces

The top-level container. A workspace owns projects, portfolios, members, teams, custom fields, tags, and audit logs.

### tRPC: `workspace.list`

**Auth:** `teamProcedure`
**Input:** `()`
**Returns:** array of workspaces the caller is a member of, each with member count and project count.

### tRPC: `workspace.byId`

**Auth:** `teamProcedure` + `requireWorkspaceMember`
**Input:** `{ id: string }`
**Returns:** workspace with full members and projects lists.

### tRPC: `workspace.members`

**Auth:** `teamProcedure` + `requireWorkspaceMember`
**Input:** `{ workspaceId: string }`
**Returns:** workspace member list (capped at 500).

### tRPC: `workspace.create`

**Auth:** `protectedProcedure`
**Input:** `{ name: string, description?: string }`
**Returns:** the new workspace. Caller becomes OWNER.

### tRPC: `workspace.update`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ id: string, name?: string, description?: string }`
**Returns:** the updated workspace.

### tRPC: `workspace.delete`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ id: string }`
**Returns:** `{ success: true }`. Cascades through projects, tasks, attachments.

### tRPC: `workspace.invite`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:**
```
{
  workspaceId: string,
  email: string,
  role: 'ADMIN' | 'MEMBER' | 'GUEST' | 'GUEST_CLIENT',
  clientProjectIds?: string[]
}
```
**Returns:** the created `Invitation`. For `GUEST_CLIENT`, `clientProjectIds` are the projects the client will be added to on acceptance — see §13 for the full client-portal flow.

### tRPC: `workspace.getPendingInvitations`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ workspaceId: string }`
**Returns:** outstanding invitations not yet accepted or expired.

### tRPC: `workspace.cancelInvitation`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ invitationId: string }`
**Returns:** `{ success: true }`.

### tRPC: `workspace.removeMember`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ workspaceId: string, userId: string }`
**Returns:** `{ success: true }`.

### MCP: `get_workspace_summary`

**ACL:** `workspace`
**Input:** `{ workspaceId: string }`
**Returns:** workspace overview — counts of projects, members, open tasks, recent activity.

### MCP: `list_workspace_members`

**ACL:** `workspace`
**Input:** `{ workspaceId: string }`
**Returns:** workspace member list.

### MCP: `search_users`

**ACL:** `workspace`
**Input:** `{ workspaceId: string, query: string }`
**Returns:** users matching `query` by name or email, scoped to the workspace.

---

## 4. Portfolios

A portfolio is a curated grouping of projects. One project can belong to multiple portfolios.

### tRPC: `portfolio.list`

**Auth:** `teamProcedure` + `requireWorkspaceMember`
**Input:** `{ workspaceId: string }`
**Returns:** portfolios with their projects + roll-up stats (health, progress, task counts).

### tRPC: `portfolio.byId`

**Auth:** `teamProcedure` + `requirePortfolioAccess`
**Input:** `{ id: string }`
**Returns:** portfolio with member projects, each annotated with health and progress.

### tRPC: `portfolio.create`

**Auth:** `teamProcedure` + `requireWorkspaceMember`
**Input:**
```
{
  workspaceId: string,
  name: string,
  description?: string,
  color?: string,
  icon?: string,
  projectIds?: string[]
}
```
**Returns:** the new portfolio.

### tRPC: `portfolio.update`

**Auth:** `teamProcedure` + `requirePortfolioAdmin`
**Input:** `{ id: string, name?: string, description?: string, color?: string, icon?: string }`
**Returns:** the updated portfolio.

### tRPC: `portfolio.delete`

**Auth:** `teamProcedure` + `requirePortfolioAdmin`
**Input:** `{ id: string }`
**Returns:** `{ success: true }`. Member projects are unlinked, not deleted.

### tRPC: `portfolio.addProject` / `portfolio.removeProject`

**Auth:** `teamProcedure` + `requirePortfolioAdmin`
**Input:** `{ portfolioId: string, projectId: string }`
**Returns:** updated portfolio.

### tRPC: `portfolio.import`

**Auth:** `teamProcedure` + `requireWorkspaceAdmin`
**Input:** `{ workspaceId: string, json: string }` — JSON validated by `parseExportPayload`.
**Returns:** the new portfolio + imported projects.

### MCP: `list_portfolios`

**ACL:** `workspace`
**Input:** `{ workspaceId: string }`
**Returns:** portfolios with projects + stats.

### MCP: `create_portfolio` / `update_portfolio` / `delete_portfolio`

**ACL:** `workspace` (create), `portfolio` (update/delete)
**Input:** mirrors the tRPC equivalents.

### MCP: `add_project_to_portfolio` / `remove_project_from_portfolio`

**ACL:** `portfolio`
**Input:** `{ portfolioId: string, projectId: string }`

### MCP: `get_portfolio_status`

**ACL:** `portfolio`
**Input:** `{ portfolioId: string }`
**Returns:** roll-up health, progress, on-track/at-risk/off-track project counts.

### MCP: `export_portfolio` / `import_portfolio`

**ACL:** `portfolio` (export), `workspace` (import)
**Input (export):** `{ portfolioId: string }`
**Input (import):** `{ workspaceId: string, json: string }`

---

## 5. Projects

The work container that holds sections, tasks, and members. `Project.kind` is `PROJECT` or `BRAIN_DUMP`; brain dumps are filtered out of `list` by default.

### tRPC: `project.list`

**Auth:** `teamProcedure` + `requireWorkspaceMember`
**Input:**
```
{
  workspaceId: string,
  includeArchived?: boolean,
  includeBrainDumps?: boolean,
  status?: 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'ARCHIVED'
}
```
**Returns:** projects with sections, members, portfolio links, and task summary counts. Brain dumps are filtered unless `includeBrainDumps: true`.

### tRPC: `project.byId`

**Auth:** `teamProcedure` + `requireProjectAccess`
**Input:** `{ id: string }`
**Returns:** full project — sections, tasks, members, custom field defs.

### tRPC: `project.create`

**Auth:** `teamProcedure` + `requireWorkspaceMember`
**Input:** `{ workspaceId: string, name: string, description?: string, color?: string }`
**Returns:** new project. Auto-creates "To Do / In Progress / Done" sections.

### tRPC: `project.update`

**Auth:** `teamProcedure` + `requireProjectAdmin`
**Input:**
```
{
  id: string,
  name?: string,
  description?: string,
  color?: string,
  status?: 'ACTIVE' | 'ON_HOLD' | 'COMPLETED' | 'ARCHIVED',
  health?: 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK',
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT',
  ownerId?: string,
  startDate?: Date,
  dueDate?: Date,
  budget?: number
}
```
**Returns:** updated project.

### tRPC: `project.delete`

**Auth:** `teamProcedure` + `requireProjectAdmin`
**Input:** `{ id: string }`
**Returns:** `{ success: true }`. Cascades through tasks, comments, attachments.

### tRPC: `project.archive` / `project.unarchive`

**Auth:** `teamProcedure` + `requireProjectAdmin`
**Input:** `{ id: string }`

### tRPC: `project.addMember` / `project.removeMember`

**Auth:** `teamProcedure` + `requireProjectAdmin`
**Input:** `{ projectId: string, userId: string }`

### tRPC: `project.getFavorites` / `project.toggleFavorite`

**Auth:** `teamProcedure`
**Input (toggle):** `{ projectId: string }`
**Returns:** caller's favorited projects.

### tRPC: `project.export` / `project.import`

**Auth:** `teamProcedure` + `requireProjectAdmin` (export), `requireWorkspaceAdmin` (import)
**Input (export):** `{ projectId: string }` — returns JSON payload of the project + tasks.
**Input (import):** `{ workspaceId: string, json: string }`.

### tRPC: column-config CRUD *(table view)*

`project.listColumnConfigs`, `project.createColumnConfig`, `project.updateColumnConfig`, `project.deleteColumnConfig` — manage saved table-view layouts per user/project.

### MCP: `list_projects`

**ACL:** `workspace`
**Input:** `{ workspaceId: string }`
**Returns:** active projects (brain dumps excluded) with section summaries.

### MCP: `list_archived_projects`

**ACL:** `workspace`
**Input:** `{ workspaceId: string }`

### MCP: `create_project`

**ACL:** `workspace`
**Input:** `{ workspaceId: string, name: string, description?: string, color?: string }`

### MCP: `update_project`

**ACL:** `project`
**Input:** mirrors `project.update` tRPC input minus `id` (uses `projectId`).

### MCP: `delete_project`

**ACL:** `project`
**Input:** `{ projectId: string }`

### MCP: `archive_project` / `unarchive_project`

**ACL:** `project`
**Input:** `{ projectId: string }`

### MCP: `add_project_member` / `remove_project_member`

**ACL:** `project`
**Input:** `{ projectId: string, userId: string }`

### MCP: `list_project_members`

**ACL:** `project`
**Input:** `{ projectId: string }`

### MCP: `export_project` / `import_project`

**ACL:** `project` (export), `workspace` (import)
**Input (export):** `{ projectId: string }` → JSON payload.
**Input (import):** `{ workspaceId: string, json: string }`

---

## 6. Sections

Columns within a project's kanban. Auto-seeded as "To Do / In Progress / Done" on `project.create`.

### MCP: `list_sections`

**ACL:** `project`
**Input:** `{ projectId: string }`
**Returns:** ordered sections with task counts.

### MCP: `create_section`

**ACL:** `project`
**Input:** `{ projectId: string, name: string, position?: number }`

### MCP: `delete_section`

**ACL:** `section`
**Input:** `{ sectionId: string }`
**Returns:** `{ success: true }`. Tasks in the deleted section are reassigned to the project's first remaining section (orphan recovery is also available via `task.fixOrphanSections`).

> Section CRUD on tRPC lives inside the `project` router (`project.createSection`, `project.updateSection`, `project.deleteSection`, `project.reorderSections`) — same auth tier (`teamProcedure` + `requireProjectAdmin`).

---

## 7. Tasks

The biggest router. The unit of work — every task belongs to a project and a section.

### tRPC: `task.list`

**Auth:** `teamProcedure` + `requireProjectAccess`
**Input:**
```
{
  projectId: string,
  status?: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED',
  sectionId?: string,
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT',
  search?: string,
  includeSubtasks?: boolean,
  externality?: 'INTERNAL_ONLY' | 'EXTERNAL_ONLY' | 'BOTH'
}
```
**Returns:** tasks with assignees, tag list, comment count, subtask count.

### tRPC: `task.byId`

**Auth:** `teamProcedure` + `requireTaskAccess`
**Input:** `{ id: string }`
**Returns:** full task — comments, attachments, subtasks, dependencies, time entries, custom field values.

### tRPC: `task.myTasks`

**Auth:** `teamProcedure`
**Input:** `()`
**Returns:** caller's open tasks across every workspace they're in.

### tRPC: `task.create`

**Auth:** `teamProcedure` + `requireProjectAccess`
**Input:**
```
{
  projectId: string,
  title: string,
  description?: string,
  status?: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED',
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT',
  sectionId?: string,
  dueDate?: Date,
  assigneeIds?: string[]
}
```
**Returns:** the new task. Assignees who aren't yet on the project are auto-added as project members.

### tRPC: `task.update`

**Auth:** `teamProcedure` + `requireTaskAccess`
**Input:**
```
{
  id: string,
  title?: string,
  description?: string,
  status?: 'TODO' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED',
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT',
  sectionId?: string,
  startDate?: Date,
  dueDate?: Date,
  estimatedMinutes?: number,
  actualMinutes?: number,
  showDescriptionOnCard?: boolean,
  showSubtasksOnCard?: boolean,
  isExternal?: boolean
}
```
**Returns:** updated task.

### tRPC: `task.delete`

**Auth:** `teamProcedure` + `requireTaskAccess`
**Input:** `{ id: string }`

### tRPC: `task.move`

**Auth:** `teamProcedure` + `requireTaskAccess`
**Input:**
```
{
  taskId: string,
  sectionId: string,
  position: number,
  columnTaskIds?: string[],
  sourceColumnTaskIds?: string[],
  sourceSectionId?: string
}
```
**Returns:** moved task. **Validates every supplied taskId belongs to the same project** to prevent cross-project drag-drop tampering.

### tRPC: `task.bulkUpdate`

**Auth:** `teamProcedure` + `requireProjectAccess` *(per-task scoped)*
**Input:**
```
{
  taskIds: string[],
  status?: ...,
  priority?: ...,
  dueDate?: Date,
  startDate?: Date,
  sectionId?: string,
  assigneeId?: string
}
```
**Returns:** `{ updated: number }`. Used by the brain-dump bulk toolbar.

### tRPC: `task.bulkDelete`

**Auth:** `teamProcedure`
**Input:** `{ taskIds: string[] }`
**Returns:** `{ deleted: number }`.

### tRPC: `task.bulkMove`

**Auth:** `teamProcedure`
**Input:** `{ taskIds: string[], sectionId: string, ... }`

### tRPC: `task.timeline`

**Auth:** `teamProcedure` + `requireProjectAccess`
**Input:** `{ projectId: string }`
**Returns:** Gantt-shaped data: tasks with `startDate`, `dueDate`, dependency edges.

### tRPC: `task.fixOrphanSections`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ workspaceId: string }`
**Returns:** count of repaired tasks. One-shot cleanup for tasks whose `sectionId` doesn't exist anymore.

### MCP: `create_task`

**ACL:** `project`
**Input:** mirrors `task.create` tRPC.

### MCP: `update_task`

**ACL:** `task`
**Input:** `{ taskId: string, ...same fields as task.update }`

### MCP: `list_tasks`

**ACL:** `project`
**Input:** mirrors `task.list`.

### MCP: `get_task`

**ACL:** `task`
**Input:** `{ taskId: string }`

### MCP: `assign_task` / `unassign_task`

**ACL:** `task`
**Input:** `{ taskId: string, userId: string }`

### MCP: `bulk_update_tasks`

**ACL:** `tasks_array` — every task ID in the array is verified to belong to a workspace the caller can access.
**Input:** `{ taskIds: string[], updates: { status?, priority?, dueDate?, sectionId?, assigneeId? } }`

### MCP: `move_task_to_section`

**ACL:** `task`
**Input:** `{ taskId: string, sectionId: string, position?: number }`

### MCP: `attach_file_to_task`

**ACL:** `task`
**Input:** `{ taskId: string, filename: string, contentType: string, base64Body: string }`
**Returns:** new attachment metadata (the blob is stored in `attachment_blobs` — see §10 for the size/type allowlist).

---

## 8. Subtasks & dependencies

### tRPC: `task.createSubtask` / `task.listSubtasks` / `task.reorderSubtasks` / `task.reparent`

**Auth:** `teamProcedure` + `requireTaskAccess`
**Inputs:**
- `createSubtask`: `{ parentId: string, title: string, ...same fields as task.create minus projectId }`
- `listSubtasks`: `{ parentId: string }`
- `reorderSubtasks`: `{ parentId: string, subtaskIds: string[] }`
- `reparent`: `{ taskId: string, newParentId: string | null }` — null detaches.

### MCP: `create_subtask`

**ACL:** `task`
**Input:** `{ parentTaskId: string, title: string, ...optional task fields }`

### MCP: `list_subtasks`

**ACL:** `task`
**Input:** `{ parentTaskId: string }`

### tRPC: `task.getDependencies` / `task.addDependency` / `task.removeDependency`

**Auth:** `teamProcedure` + `requireTaskAccess`
**Inputs:**
- `getDependencies`: `{ taskId: string }`
- `addDependency`: `{ taskId: string, dependsOnTaskId: string }`
- `removeDependency`: `{ taskId: string, dependsOnTaskId: string }`

### MCP: `add_dependency` / `remove_dependency` / `list_dependencies`

**ACL:** `task`
**Input:** matches the tRPC inputs.

---

## 9. Comments

### tRPC: `comment.list`

**Auth:** `teamProcedure` + `requireTaskAccess`
**Input:** `{ taskId: string }`
**Returns:** comments ordered by `createdAt`, each with author + mentions resolved.

### tRPC: `comment.create`

**Auth:** `teamProcedure` + `requireTaskAccess`
**Input:** `{ taskId: string, content: string, mentionedUserIds?: string[] }`
**Returns:** new comment. Writes a `Notification` row for each mentioned user.

### tRPC: `comment.update`

**Auth:** `teamProcedure` + author check
**Input:** `{ commentId: string, content: string }`

### tRPC: `comment.delete`

**Auth:** `teamProcedure` + (author OR project admin)
**Input:** `{ commentId: string }`

### MCP: `add_comment`

**ACL:** `task`
**Input:** `{ taskId: string, content: string, mentionedUserIds?: string[] }`

### MCP: `list_comments`

**ACL:** `task`
**Input:** `{ taskId: string }`

---

## 10. Attachments

Metadata is exposed on tRPC; binary upload/download happens via REST so the request body can stream. Blobs live in Postgres `attachment_blobs` (BYTEA) — there is no S3.

### tRPC: `attachment.list`

**Auth:** `teamProcedure` + `requireTaskAccess`
**Input:** `{ taskId: string }`
**Returns:** attachment metadata only — never selects the blob bytes.

### tRPC: `attachment.delete`

**Auth:** `teamProcedure` + (workspace admin OR project member-uploader OR original uploader)
**Input:** `{ attachmentId: string }`

### REST: `POST /api/attachments/upload`

**Auth:** Clerk session cookie
**Body:** `multipart/form-data` with fields:
- `taskId` *(string, required)*
- `file` *(binary, required)*

**Limits:**
- 25 MB hard cap (Content-Length is pre-checked at 30 MB)
- Content-type allowlist: `png/jpg/gif/webp/svg`, `pdf`, common Office docs, `text/plain`, `text/csv`, `application/zip`

**Response:** `200 { id, filename, contentType, size, uploadedAt }` — see `apps/web/src/lib/upload-policy.ts` for the canonical type/size logic.

### REST: `GET /api/attachments/[id]/download`

**Auth:** Clerk session cookie. CLIENT users gated on `Task.isExternal === true` AND project membership.
**Response:** binary body with proper `Content-Type` and `Content-Disposition: attachment; filename*=UTF-8''<filename>`.

---

## 11. Brain dumps

A brain dump is a `Project` with `kind = BRAIN_DUMP`. Its tasks are split into "active" (not archived) and "backlog" (archived).

### tRPC: `brainDump.list`

**Auth:** `teamProcedure` + `requireWorkspaceMember`
**Input:** `{ workspaceId: string }`
**Returns:** brain dumps with active task counts.

### tRPC: `brainDump.create`

**Auth:** `teamProcedure` + `requireWorkspaceMember`
**Input:** `{ workspaceId: string, name: string, color?: string }`
**Returns:** new BRAIN_DUMP-kind project.

### tRPC: `brainDump.byId`

**Auth:** `teamProcedure` + `requireProjectAccess`
**Input:** `{ id: string }`
**Returns:** brain dump metadata + active/backlog counts.

### tRPC: `brainDump.getActive` / `brainDump.getBacklog`

**Auth:** `teamProcedure` + `requireProjectAccess`
**Input:** `{ id: string }`

### tRPC: `brainDump.addTask`

**Auth:** `teamProcedure` + `requireProjectAccess`
**Input:** `{ id: string, title: string, assigneeId?: string }`
**Returns:** new task. Refuses CLIENT assignees (brain dumps are internal).

### tRPC: `brainDump.triage`

**Auth:** `teamProcedure` + `requireTaskAccess`
**Input:** `{ taskId: string, targetProjectId: string }`
**Returns:** moved task. Preserves `brainDumpOriginId` so the source brain dump's backlog still surfaces it.

### tRPC: `brainDump.bulkTriage`

**Auth:** `teamProcedure`
**Input:** `{ taskIds: string[], targetProjectId: string }`
**Returns:** `{ moved: number }`. One transactional `updateMany`.

### tRPC: `brainDump.endMeeting`

**Auth:** `teamProcedure` + `requireProjectAccess`
**Input:** `{ id: string }`
**Returns:** `{ archived: number }`. Archives every active task; clears the active view to the backlog.

### tRPC: `brainDump.allActive`

**Auth:** `teamProcedure` + `requireWorkspaceMember`
**Input:** `{ workspaceId: string }`
**Returns:** active tasks across every brain dump in the workspace. Powers `/brain-dumps/all`.

### MCP: `list_brain_dumps`

**ACL:** `workspace`
**Input:** `{ workspaceId: string }`

### MCP: `create_brain_dump`

**ACL:** `workspace`
**Input:** `{ workspaceId: string, name: string, color?: string }`

### MCP: `add_brain_dump_task`

**ACL:** `project`
**Input:** `{ brainDumpId: string, title: string, assigneeId?: string }`

### MCP: `triage_brain_dump_task`

**ACL:** `task`
**Input:** `{ taskId: string, targetProjectId: string }`

---

## 12. Time tracking

### MCP: `start_timer`

**ACL:** `task`
**Input:** `{ taskId: string }`
**Returns:** the active `TimeEntry` row. Closes any other open timer the caller has.

### MCP: `stop_timer`

**ACL:** `time_entry`
**Input:** `{ timeEntryId?: string }` — defaults to caller's currently-active timer.

### MCP: `get_active_timer`

**ACL:** `self`
**Input:** `()`
**Returns:** the open timer, if any.

### MCP: `list_time_entries`

**ACL:** `task`
**Input:** `{ taskId: string }`
**Returns:** time entries on the task with author + duration.

### MCP: `add_time_entry`

**ACL:** `task`
**Input:** `{ taskId: string, minutes: number, startedAt?: Date, note?: string }`

### MCP: `delete_time_entry`

**ACL:** `time_entry`
**Input:** `{ timeEntryId: string }`

> tRPC equivalents live in the `timeEntry` router with the same fields, gated by `teamProcedure` + `requireTaskAccess`.

---

## 13. Client portal

CLIENT-userType users see a separate UI at `/portal` and a tightly-scoped tRPC router. **Three independent gates, all enforced server-side:**

1. **`User.userType === 'CLIENT'`** — checked by `clientPortalProcedure`. Team routers go through `teamProcedure` which rejects clients.
2. **`Task.isExternal === true`** — every portal query/mutation joins on this flag. Default-private; the team explicitly toggles it on per task in `TaskDetail.tsx`.
3. **`ProjectMember` row** — the client must be on the project.

Cross-workspace safety: `workspace.invite` and `accept-invite` refuse to flip an existing `TEAM_MEMBER` to `CLIENT` if they have other team workspace memberships — prevents global lockout.

**MCP exposure for clients: none.** CLIENT users can't issue `mcp_*` tokens (`mcpToken.create` is `ownerProcedure`).

### tRPC: `clientPortal.myTasks`

**Auth:** `clientPortalProcedure`
**Input:** `()`
**Returns:** all `isExternal: true` tasks across the client's projects.

### tRPC: `clientPortal.taskById`

**Auth:** `clientPortalProcedure` + `requireClientPortalTaskAccess`
**Input:** `{ taskId: string }`
**Returns:** task detail with comments and attachments (visibility-checked).

### tRPC: `clientPortal.workspaceById`

**Auth:** `clientPortalProcedure`
**Input:** `{ workspaceId: string }`
**Returns:** minimal workspace info for portal chrome (name, logo, color).

### tRPC: `clientPortal.commentCreate`

**Auth:** `clientPortalProcedure` + `requireClientPortalTaskAccess`
**Input:** `{ taskId: string, content: string }`
**Returns:** new comment + writes `Notification` rows for every internal team member on the project.

---

## 14. Reports

### MCP: `generate_report`

**ACL:** `report`
**Input:**
```
{
  workspaceId: string,
  type: 'STATUS' | 'WEEKLY' | 'CUSTOM',
  scope: { projectId?: string, portfolioId?: string, userId?: string },
  rangeStart?: Date,
  rangeEnd?: Date
}
```
**Returns:** structured report payload — sections, metrics, narrative.

### MCP: `generate_ai_report`

**ACL:** `report`
**Input:** same as `generate_report` plus `prompt?: string` for steering the LLM summary.

### MCP: `send_report_email`

**ACL:** `report`
**Input:** `{ reportId: string, to: string[], subject?: string }`

### MCP: `list_reports`

**ACL:** `workspace`
**Input:** `{ workspaceId: string, limit?: number }`

### MCP: `get_user_activity`

**ACL:** `workspace`
**Input:** `{ workspaceId: string, userId: string, rangeStart?: Date, rangeEnd?: Date }`
**Returns:** the user's task activity rolled up by day.

> Cron: `GET /api/cron/send-reports` is hit by Railway scheduled-jobs; iterates `ReportTemplate` rows whose `nextRunAt <= now` and emits the rendered report. Auth is by Railway's internal request — the route checks `Authorization: Bearer ${process.env.CRON_SECRET}`.

---

## 15. SOW (Statement of Work)

Upload a SOW document, parse it, then bootstrap a project from the structured output.

### MCP: `parse_sow`

**ACL:** `workspace`
**Input:** `{ workspaceId: string, filename: string, contentType: string, base64Body: string }`
**Returns:** parsed SOW — `{ title, scope, deliverables[], milestones[], assumptions[] }`. Caches the parse on the SOW row so `create_project_from_sow` can reuse it.

### MCP: `create_project_from_sow`

**ACL:** `workspace`
**Input:** `{ sowId: string, projectName?: string }`
**Returns:** new project with sections seeded from the SOW's milestones and tasks from the deliverables.

> tRPC `sow` router exposes the same flow with `parse`, `byId`, and `createProject` procedures, gated by `teamProcedure` + `requireWorkspaceMember`.

---

## 16. Custom fields

Workspace-scoped custom field definitions, plus per-task values.

### MCP: `list_custom_fields`

**ACL:** `workspace`
**Input:** `{ workspaceId: string }`
**Returns:** field definitions — `{ id, name, type: 'TEXT'|'NUMBER'|'DATE'|'SELECT'|'MULTI_SELECT', options? }`.

### MCP: `create_custom_field`

**ACL:** `workspace`
**Input:** `{ workspaceId: string, name: string, type: ..., options?: string[] }`

### MCP: `set_custom_field_value`

**ACL:** `task`
**Input:** `{ taskId: string, customFieldId: string, value: string | number | string[] | Date }`

> tRPC `customField` router has the same shape with `list`, `create`, `update`, `delete`, and `setValue` procedures.

---

## 17. Workload

### MCP: `get_user_availability`

**ACL:** `workspace`
**Input:** `{ workspaceId: string, userId: string, rangeStart: Date, rangeEnd: Date }`
**Returns:** capacity vs. assigned-task estimated minutes per day.

> tRPC `workload` router exposes broader views — utilization heatmaps, per-project capacity — under `teamProcedure` + `requireWorkspaceMember`.

---

## 18. Search & "self" tools

### MCP: `search_tasks`

**ACL:** `workspace`
**Input:** `{ workspaceId: string, query: string, limit?: number }`
**Returns:** tasks matching `query` by title/description, ranked by recency.

### MCP: `list_tasks_due`

**ACL:** `workspace`
**Input:** `{ workspaceId: string, before?: Date, after?: Date }`
**Returns:** tasks with `dueDate` in the given window.

### MCP: `list_tasks_for_user`

**ACL:** `workspace`
**Input:** `{ workspaceId: string, userId: string, status?: ... }`

### MCP: `list_stale_tasks`

**ACL:** `workspace`
**Input:** `{ workspaceId: string, daysSinceUpdated?: number }`
**Returns:** tasks not updated in `daysSinceUpdated` (default 14) and not in `DONE`.

### MCP: `my_tasks`

**ACL:** `self`
**Input:** `()`
**Returns:** caller's open tasks across every workspace they belong to.

### MCP: `whoami`

**ACL:** `self`
**Input:** `()`
**Returns:** caller's `User` row + token attribution (`auditSource`, `agentName`).

---

## 19. Notifications

### tRPC: `notification.list`

**Auth:** `protectedProcedure`
**Input:** `{ unreadOnly?: boolean, limit?: number }`
**Returns:** caller's notifications ordered desc by `createdAt`.

### tRPC: `notification.markRead` / `notification.markAllRead`

**Auth:** `protectedProcedure`
**Input (markRead):** `{ id: string }`

### tRPC: `notification.delete`

**Auth:** `protectedProcedure`
**Input:** `{ id: string }`

> No MCP exposure — notifications are inherently a UI concept.

---

## 20. Users

### tRPC: `user.me`

**Auth:** `protectedProcedure`
**Input:** `()`
**Returns:** caller's profile + workspace memberships.

### tRPC: `user.updateWorkspaceMemberRole`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:**
```
{
  workspaceId: string,
  userId: string,
  role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'GUEST' | 'GUEST_CLIENT'
}
```
**Returns:** updated `WorkspaceMember`.

### tRPC: `user.update`

**Auth:** `protectedProcedure`
**Input:** `{ name?: string, avatarUrl?: string, timezone?: string }` — applies to the caller only.

---

## 21. MCP tokens

### tRPC: `mcpToken.list`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ workspaceId: string }`
**Returns:** issued tokens — name, prefix, `lastUsedAt`, `revokedAt`. The raw `mcp_*` value is never returned after creation.

### tRPC: `mcpToken.create`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ workspaceId: string, name: string }`
**Returns:** **`{ id, name, token: 'mcp_...' }`** — the only call that returns the raw token. UI shows it once and warns to copy it.

### tRPC: `mcpToken.revoke`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ tokenId: string }`
**Returns:** `{ success: true }`. Sets `revokedAt = now()`. Subsequent MCP requests bearing that token are rejected at auth.

---

## 22. OAuth clients

Pre-registered OAuth clients are an alternative to Dynamic Client Registration (DCR) for trusted integrations.

### tRPC: `oauthClient.list`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ workspaceId: string }`

### tRPC: `oauthClient.create`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ workspaceId: string, name: string, redirectUris: string[] }`
**Returns:** `{ clientId, clientSecret }` (secret is shown once).

### tRPC: `oauthClient.revoke`

**Auth:** `ownerProcedure` + `requireWorkspaceAdmin`
**Input:** `{ clientId: string }`
**Returns:** `{ success: true }`. Sets `revokedAt = now()`. The token endpoint **re-checks the client's `revokedAt` at code-redeem time**, so existing auth codes are invalidated.

---

## 23. Chat, audit, teams, tags

### `chat` *(agentic chat)*

Workspace-scoped agentic chat conversations. Procedures: `list`, `byId`, `create`, `sendMessage`, `delete`. Auth: `teamProcedure` + `requireWorkspaceMember`. Pre-existing typecheck noise lives in `chat.ts` and `chat-tools.ts` — see §28.

### `audit`

`audit.search({ workspaceId, actorId?, source?, kind?, rangeStart?, rangeEnd?, cursor? })` — returns audit log entries with cursor pagination. Auth: `ownerProcedure` + `requireWorkspaceAdmin`. Source values: `USER`, `MCP`, `BOT`, `SYSTEM`.

### `team`

Workspace-scoped sub-teams (a team is a named subset of workspace members). Procedures: `list`, `byId`, `create`, `update`, `delete`, `addMember`, `removeMember`. Auth: `teamProcedure` + `requireWorkspaceAdmin` for mutations.

### `reportTemplate`

`reportTemplate.list / create / update / delete / runNow` — scheduled report templates that the cron job at `/api/cron/send-reports` iterates. Auth: `teamProcedure` + `requireWorkspaceAdmin`.

---

## 24. REST: OAuth (agent enrollment)

| Method | Path | Purpose |
|---|---|---|
| GET | `/.well-known/oauth-authorization-server` | OAuth server metadata |
| GET | `/.well-known/oauth-protected-resource` | RFC 9728 protected-resource metadata |
| POST | `/api/oauth/register` | Dynamic Client Registration (RFC 7591) |
| GET | `/oauth/authorize` | Browser consent UI (renders the authorize prompt) |
| POST | `/api/oauth/authorize` | Issue auth code (PKCE only). Records `oauthClientId` on the code if a registered client is named. |
| POST | `/api/oauth/token` | Exchange auth code for an `mcp_*` bearer token. Validates PKCE, redirect_uri, code expiry, AND **re-checks the issuing client's `revokedAt` at redeem time**. |

### POST `/api/oauth/register`

**Auth:** none (per RFC 7591 unauthenticated DCR).
**Body:** `{ client_name, redirect_uris[], grant_types?, response_types?, token_endpoint_auth_method? }`
**Response:** `{ client_id, client_secret, ... }`. Secret is hashed at rest with SHA-256 (see §28 — should be HMAC or argon2id).

### POST `/api/oauth/authorize`

**Auth:** Clerk session cookie (the user must be logged in to consent).
**Body:** `{ client_id, redirect_uri, code_challenge, code_challenge_method: 'S256', state, scope? }`
**Response:** `302` redirect to `redirect_uri` with `?code=...&state=...`.

### POST `/api/oauth/token`

**Auth:** none (PKCE-verified).
**Body:** `{ grant_type: 'authorization_code', code, redirect_uri, code_verifier, client_id }`
**Response:** `{ access_token: 'mcp_...', token_type: 'Bearer', expires_in }`.

---

## 25. REST: webhooks, realtime, sandbox, agents

### POST `/api/webhooks/clerk`

**Auth:** Clerk webhook signing secret — verified via `svix-signature` header.
**Body:** Clerk webhook event (user.created, user.updated, user.deleted).
**Effect:** syncs to internal `User` table.

### GET `/api/realtime`

**Auth:** Clerk session cookie.
**Response:** `text/event-stream`. Emits events of type `task.*`, `project.*`, `comment.created`, `notification.created`, `timer.*`. Subscribers filter client-side. **Single-server only** (in-memory event bus, no Redis).

### Sandbox auth (only when `NEXT_PUBLIC_SANDBOX_MODE=true`)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/sandbox/login` | Sets `sandbox_user_id` cookie. Body: `{ userId: string }`. |
| POST | `/api/sandbox/logout` | Clears `sandbox_user_id`. |
| GET | `/api/sandbox/me` | Returns `{ userId }` from the cookie. |

### Agent self-registration

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/agents/register` | Registers an agent identity, returns an `mcp_*` token. Body: `{ workspaceId, agentName, scopes? }`. Auth: Clerk session (the human-on-behalf-of-whom the agent runs). |
| GET | `/api/agents/me` | Returns the registered agent's metadata. Auth: bearer `mcp_*`. |

### Cron

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/cron/send-reports` | Railway-scheduled sender. Auth: `Authorization: Bearer ${CRON_SECRET}`. |

---

## 26. Realtime event bus

In-memory pub/sub at `apps/web/src/lib/event-bus.ts`. Event types:

`task.updated`, `task.created`, `task.deleted`, `task.moved`, `task.subtasksReordered`, `comment.created`, `project.updated`, `project.sectionsReordered`, `notification.created`, `timer.started`, `timer.stopped`.

Payload always includes `projectId` and/or `taskId` so subscribers can filter. Single-server only — events are lost on deploy + don't fan out across instances. If we ever scale to multiple replicas, swap this for Redis pub/sub.

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
- Pre-existing typecheck errors live in `chat.ts`, `chat-tools.ts`, `oauthClient.ts`, `ProjectHealthCell.tsx`, `ProjectPriorityCell.tsx`, `(dashboard)/tasks/page.tsx` (`FunnelStatus`/`FunnelPriority` undefined names). `next.config.ts` has `typescript.ignoreBuildErrors: true` so they don't block deploy, but they should get cleaned up.
- Standalone MCP server in `packages/mcp-server/` exists for self-hosting but **production deploys only run the web `/mcp` route** (per `scripts/start.sh`). The standalone server has a smaller, subset toolset.
