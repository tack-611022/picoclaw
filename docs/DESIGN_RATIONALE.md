# PicoClaw Design Rationale

Architectural decisions and first-principles reasoning behind PicoClaw's design. This document captures the "why" behind key choices for developers and architects evaluating or extending the system.

## Origin: NanoClaw to PicoClaw

PicoClaw is a serverless adaptation of [NanoClaw](https://github.com/qwibitai/nanoclaw), an always-on multi-channel Claude Agent orchestrator. NanoClaw uses a host process that manages Docker child containers — one per agent session — with channel adapters (WhatsApp, Telegram, etc.) feeding messages through a router.

This architecture works well for persistent, multi-channel deployments but creates friction in serverless environments:

| Concern | NanoClaw (Docker child containers) | PicoClaw (single container) |
|---|---|---|
| Cold start | Host + child container spin-up | Single process boot |
| Resource model | N containers × memory | Single process |
| Scheduling | Internal cron loop | External cron triggers |
| Channel routing | Multi-adapter router | HTTP API only |
| Filesystem | Source tree + container volumes | Mounted volumes at `/data/*` |
| State isolation | Per-container filesystem | Per-conversation SQLite rows |

The core insight: in a serverless (Lambda/FC) context, the platform already provides the execution container. Adding Docker-in-Docker adds latency, complexity, and resource overhead with no isolation benefit — the cloud platform's sandbox is the security boundary.

## Why Single-Container, Same-Process Agent

NanoClaw's Docker child container model spawns a separate container per agent session. The host sends messages via IPC files, and the child runs Claude Code with full filesystem isolation.

PicoClaw eliminates this layer:

1. **The Claude Agent SDK runs in-process.** `query()` spawns a CLI subprocess internally — that's the SDK's own execution model, not something we add. Wrapping it in another Docker container adds a third process layer with no functional benefit.

2. **Filesystem isolation is replaced by volume semantics.** Instead of each container having its own filesystem, PicoClaw mounts three well-defined volumes. The agent's `cwd` is set to `MEMORY_DIR`, and skills are synced to `.claude/skills/` at startup.

3. **Session state moves from container lifecycle to database rows.** NanoClaw ties a session to a container's lifetime. PicoClaw stores `session_id` and `last_assistant_uuid` in SQLite, enabling resume across separate HTTP requests.

## Why SQLite on /tmp (Dual-Database Sync)

### The Problem

Serverless platforms (Lambda, FC) typically provide:

- **Ephemeral local storage** (`/tmp`): fast, SSD-backed, but lost on container recycling.
- **Network-attached persistent storage** (EFS, NAS): durable but with higher latency and SQLite compatibility risks.

SQLite on NFS/EFS has known issues:

- File locking may not work correctly across NFS clients.
- WAL mode can corrupt if multiple processes access the same database file on network storage.
- Latency for frequent small writes (common in chat applications) degrades performance.

### The Solution

PicoClaw uses a **dual-path strategy**:

1. On startup, copy `/data/store/messages.db` → `/tmp/messages.db`.
2. All runtime reads/writes operate on `/tmp/messages.db` (fast local I/O).
3. After each HTTP response: `PRAGMA wal_checkpoint(TRUNCATE)` + file copy back to `/data/store/messages.db`.
4. On shutdown: final sync before process exit.

This gives SQLite its preferred environment (local filesystem with proper locking) while ensuring durability through explicit sync points. The worst-case data loss window is a single in-flight request if the container is forcefully killed.

### Why `wal_checkpoint(TRUNCATE)`

WAL (Write-Ahead Log) mode enables concurrent reads during writes. However, copying a database file while the WAL has uncommitted pages would produce an inconsistent copy. `TRUNCATE` mode checkpoints all WAL pages into the main database file and then truncates the WAL to zero length, ensuring the main `.db` file is self-contained and safe to copy.

## Why MCP Server is a Subprocess

The Claude Agent SDK requires MCP servers to be external processes communicating via stdio (or SSE/HTTP). This is not a design choice — it's a constraint of the SDK's architecture:

```
SDK (sdk.mjs) → spawns CLI (cli.js) → CLI spawns MCP servers (stdio)
```

The CLI process manages MCP server lifecycle. An in-process MCP server would require the SDK to support it natively (which it does via `type: 'sdk'`), but stdio transport is more reliable for PicoClaw because:

1. **The MCP server shares the same SQLite database.** It receives `PICOCLAW_DB_PATH` as an environment variable and opens its own connection. This works because both the main process and MCP subprocess run on the same machine, accessing the same `/tmp/messages.db` file. (Legacy `NANOCLAW_DB_PATH` is accepted as fallback.)

2. **Process isolation prevents MCP crashes from taking down the HTTP server.** If an MCP tool handler throws, only the subprocess is affected.

3. **Subagent inheritance works naturally.** When the SDK spawns subagents (Task tool), those subagents can also access the MCP server because stdio transport is inherited through the process tree.

## Why MessageStream (AsyncIterable Prompt)

PicoClaw wraps the user's prompt in a `MessageStream` (async iterable) instead of passing it as a plain string to `query()`. This is a deliberate design choice driven by how the SDK handles agent lifecycle:

When `query()` receives a **string** prompt, it sets `isSingleUserTurn = true`. After the first `result` message, the SDK closes stdin to the CLI process. This triggers a shutdown cascade that kills any running subagents — even if they're mid-execution.

When `query()` receives an **AsyncIterable**, `isSingleUserTurn = false`. The SDK keeps stdin open, allowing:

- Background agents to complete their work.
- Agent Teams to coordinate through the full lifecycle.
- The caller to control when the session ends (by calling `end()` on the stream).

PicoClaw's `MessageStream` pushes one message and immediately calls `end()`, but the iterable type prevents premature stdin closure during agent execution.

## Why Three Separate Volumes

The three-volume model (`memory`, `org`, `store`) separates concerns:

| Volume | Lifecycle | Write Pattern | Sharing |
|---|---|---|---|
| `memory` | Long-lived | Agent writes (persona, archives, `.claude/` session state) | Shared across deploys |
| `org` | Deploy-time (optional) | Human/CI writes org resources | Read-only at runtime; when `ORG_DIR` is set, provides org persona, skills, and MCP config |
| `store` | Long-lived | Sync from `/tmp` after each request | Shared across deploys |

This separation enables:

- **Org resources as deployment artifacts**: update org persona, skills, or MCP config by mounting a new volume at `/data/org`, no image rebuild.
- **Independent backup policies**: `store` (critical) vs org resources (reproducible).
- **Session state co-located with memory**: `.claude/` lives inside `MEMORY_DIR`, so the agent's skills, session files, and workspace are all on the same volume — simplifying deployment from 4 mounts to 3.

## Why ORG_DIR

Earlier versions of PicoClaw used three separate concepts to manage organization-level resources: a global persona path (`/data/memory/global/CLAUDE.md`), a shared skills volume (`/data/skills`), and ad-hoc org MCP configuration. This created deployment friction and cognitive overhead.

`ORG_DIR` consolidates all org resources under a single environment variable and mount point:

```
$ORG_DIR/
  CLAUDE.md              # Org persona (policies, compliance, shared rules)
  managed-mcp.json       # Org-managed MCP servers (Claude Code native format)
  skills/                # Org skill definitions
```

**Design principles:**

- **Single env var, single mount.** One `ORG_DIR=/data/org` replaces three separate configuration paths. Operators mount one read-only volume for all org resources.
- **Naming: "org" over "global."** "Global" is ambiguous (global to the process? the cluster? the world?). "Org" is semantically precise and forms a natural pair with "user" — org resources are shared across users, user resources are per-user.
- **User skills are additive-only.** User-created skills (from `$MEMORY_DIR/skills/`) are merged with org skills, but user skills cannot override or shadow org skill definitions. This prevents users from circumventing org policies embedded in skills.
- **`managed-mcp.json` is loaded programmatically, not via CLI auto-discovery.** The Claude Code CLI reads `/etc/claude-code/managed-mcp.json` for enterprise MCP servers, but when this file exists, the CLI rejects all programmatic `--mcp-config` servers with _"You cannot dynamically configure MCP servers when an enterprise MCP config is present"_. Since PicoClaw always passes the built-in `picoclaw` server via `--mcp-config`, the two mechanisms are mutually exclusive. PicoClaw reads `$ORG_DIR/managed-mcp.json` into memory at startup (`src/managed-mcp.ts`) and merges all three sources (managed + built-in + per-request) into a single `mcpServers` object for `query()`. This avoids the enterprise exclusion while preserving the same validation and connection behavior.

## Why External Cron for Task Scheduling

NanoClaw runs an internal scheduling loop that checks for due tasks every N seconds. This requires a persistent process — incompatible with serverless.

PicoClaw's `POST /task/check` endpoint inverts the control:

1. External cron (EventBridge, FC timer trigger) calls `/task/check` every minute.
2. The endpoint queries `scheduled_tasks WHERE status = 'active' AND next_run <= NOW()`.
3. Executes at most one task, then returns.

**One task per call** is intentional:

- Prevents a single Lambda invocation from running indefinitely if many tasks are due.
- Allows the platform to manage concurrency and timeout per task execution.
- Backlogs are visible via the `remaining` field in the response.

## Timeout and Abort Design

The agent timeout uses `AbortController` — the standard JavaScript cancellation primitive:

```typescript
const abortController = new AbortController();
const timeoutHandle = setTimeout(() => abortController.abort(), timeoutMs);
```

This is passed directly to `query()`, which threads it through to the CLI subprocess. When aborted:

- The SDK terminates the CLI process.
- Any in-progress API call or tool execution is cancelled.
- PicoClaw catches the `AbortError` and returns `status: "timeout"` with any partial result.

The timeout has two levels:

- **Server-level**: `MAX_EXECUTION_MS` environment variable (default: 300s).
- **Per-request**: `max_execution_ms` in the chat request body, capped at the server-level maximum.

For Lambda deployments, set `MAX_EXECUTION_MS` at least 30 seconds below the Lambda timeout to ensure the sync-and-exit sequence completes.

## Session Resume Mechanics

Cross-request conversation continuity uses the SDK's built-in session resume:

1. First request: `query()` returns a `system/init` message with `session_id`, and `assistant` messages with `uuid` values.
2. PicoClaw stores `session_id` and the last `assistant.uuid` in the `conversations` table.
3. Next request: `query()` receives `resume: session_id` and `resumeSessionAt: last_assistant_uuid`.
4. The SDK locates the session file on disk (in `MEMORY_DIR/.claude/`) and resumes from the specified message.

This is why `MEMORY_DIR` must be persistent — the SDK's session files (stored in `.claude/` within the memory volume) contain the full conversation state needed for resume.

## Security Model Changes

NanoClaw's security relies on Docker container isolation: each agent runs in a sandboxed container with controlled filesystem access. Credential injection uses a proxy that grants temporary tokens.

PicoClaw replaces this with:

1. **HTTP Bearer token authentication** as the primary boundary.
2. **API proxy support** via `ANTHROPIC_BASE_URL`: the SDK reads this from `process.env` to route API calls to a custom endpoint (e.g. third-party proxies, regional endpoints, or self-hosted gateways). Passed through the same `env` object as `ANTHROPIC_API_KEY`.
3. **Environment variable scrubbing** via `PreToolUse` hook: before any Bash command, `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN` are unset.
4. **Container boundary** as the blast radius limit — the agent has full Bash access within the container, but the container itself is the sandbox.
5. **MCP tool ownership**: non-main sessions can only manage tasks belonging to their conversation.

See `docs/SECURITY.md` for the complete trust model.

## NanoClaw to PicoClaw: Module Comparison

For developers familiar with NanoClaw, this section maps how each NanoClaw module was transformed or replaced in PicoClaw.

### Architecture Overview

```
NanoClaw (multi-channel + container isolation):
  Channel Adapters (WhatsApp/Telegram/Slack/...)
    → SQLite (message storage)
    → Polling Loop (2s)
    → GroupQueue (max 5 concurrent)
    → Docker Container (one per group, isolated)
      → Claude Agent SDK query()
      → IPC file communication (input/output)
    → Router (format + send back to channel)

PicoClaw (HTTP API + single process):
  HTTP Request
    → Express Router + Auth
    → SQLite (conversation/message storage)
    → AgentEngine.run()
      → Claude Agent SDK query() (same-process subprocess)
      → MCP Server (stdio subprocess)
    → HTTP Response (JSON / SSE)
```

### Module-by-Module Mapping

| Module | NanoClaw | PicoClaw | Change |
|---|---|---|---|
| Entry point | `index.ts` (598 lines): message loop, trigger detection, group registration, container dispatch | `index.ts` (79 lines): boot + shutdown + start Express | Drastically simplified |
| Agent engine | `container-runner.ts` (707 lines) + `container/agent-runner/src/index.ts` (558 lines) = two-layer architecture | `agent-engine.ts` (~500 lines) = single-layer SDK call | Docker IPC → same-process call |
| Message input | Channel polling → IPC files → MessageStream | HTTP POST → SQLite → XML format → MessageStream | Input source changed; MessageStream pattern preserved |
| Message output | stdout markers → container-runner parse → channel router | query() result → HTTP JSON/SSE response | Output channel simplified |
| Database | 7 tables (messages, chats, registered_groups, sessions, router_state, scheduled_tasks, task_run_logs) | 5 tables (conversations, messages, outbound_messages, scheduled_tasks, task_run_logs) | Removed multi-group tables; added conversations/outbound |
| Task scheduling | Internal 60s polling loop (`startSchedulerLoop`) | External cron calls `POST /task/check` | Push → pull inversion |
| MCP tools | IPC file monitoring (`ipc-mcp-stdio.ts`), filesystem-based communication | SQLite direct access (`mcp-server.ts`), shared database | IPC files → shared SQLite |
| Skills | Container-internal `.claude/skills/` per group | Three-tier sync: built-in → org → user (additive) → `.claude/skills/`, with hot-reload | Enhanced with priority overlay |
| Memory | Per-group CLAUDE.md (`/workspace/group/CLAUDE.md`) + global | Single-user CLAUDE.md (`/data/memory/CLAUDE.md`) + org (`$ORG_DIR/CLAUDE.md`) | Multi-group → single-user |
| Session resume | session_id stored in DB → passed to container | session_id + last_assistant_uuid → SDK `resume` + `resumeSessionAt` | Added precise message-level resume |
| Security | Docker container isolation + Credential Proxy | Bearer Token + Bash env scrubbing + container boundary | OS isolation → process isolation |
| Concurrency | GroupQueue (max 5 concurrent groups) | Per-conversation mutex lock (`conversation-lock.ts`), 409 on conflict | Queue-based → lock-based |

### Code Reuse from NanoClaw

| Component | Reuse | Notes |
|---|---|---|
| `MessageStream` | ~95% | Removed IPC polling logic |
| `PreCompactHook` | ~90% | Archive path adapted to `/data/memory/conversations` |
| `parseTranscript` / `formatTranscriptMarkdown` | ~95% | Nearly identical |
| Skills sync | ~75% | Additive merge replaces priority overlay; org/user tier separation added |
| Task scheduling logic | ~80% | Removed internal loop, kept calculation logic |
| MCP tool definitions | ~70% | Changed from IPC files to SQLite direct access |

### Features Intentionally Not Migrated

| NanoClaw Feature | Reason |
|---|---|
| IPC follow-up messages | Replaced by HTTP multi-turn conversation |
| Container idle timeout | PicoClaw lifecycle controlled by external platform |
| Group management | Single-user model, no group concept |
| Channel adapter system | HTTP API is the only channel |
| Credential Proxy | Environment variables injected directly + Bash hook scrubbing |
| Mount Security | Volume mount boundaries provide equivalent isolation |
| Sender Allowlist | Bearer Token authentication replaces sender validation |

## Why Per-Conversation Locking

SQLite in WAL mode tolerates concurrent reads but requires serialized writes. Since Claude Agent SDK `query()` executes tool calls that modify the database (via the MCP server subprocess), concurrent agent executions on the **same conversation** risk database corruption or inconsistent state.

PicoClaw solves this with a per-conversation mutex lock (`conversation-lock.ts`):

- **Different conversations can run fully in parallel** — the lock granularity is per-conversation, not global.
- **Same-conversation concurrent requests return `409 Conflict` immediately** — the chat route uses `wait: false` to avoid hanging HTTP requests.
- **Lock is always released** — `finally { releaseLock?.() }` ensures the lock is freed even on exceptions.

This is a deliberate trade-off: we sacrifice concurrent writes to the same conversation (which is semantically meaningless anyway — a conversation is inherently sequential) to guarantee database integrity.
