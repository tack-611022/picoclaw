# PicoClaw Serverless API & Deployment Guide

> Target audience: Operations teams, platform engineers, downstream API consumers

## 1. Document Purpose

This guide covers:

- API usage (authentication, SSE streaming, multi-turn conversations, task scheduling)
- Container deployment (local, AWS Lambda, Alibaba Cloud FC)
- Runtime architecture and data persistence
- Operations, troubleshooting, and go-live checklist

### 1.1 API Artifacts

The repository includes importable API artifacts:

- `docs/api/openapi.yaml` (OpenAPI 3.0.3 source)
- `docs/api/openapi.json` (OpenAPI JSON export)
- `docs/api/postman_collection.json` (Postman Collection)

Recommended workflow:

1. Read this document to understand runtime and operational constraints.
2. Import `docs/api/openapi.yaml` or `docs/api/openapi.json` into your API tooling.
3. Use `docs/api/postman_collection.json` for integration smoke testing.

## 2. Architecture Overview

### 2.1 Execution Model

PicoClaw uses a **single-container, request-driven** model:

- No message polling or internal long-running scheduler loops.
- Each HTTP request triggers one processing cycle (chat or task).
- Claude Agent SDK `query()` is the core execution engine.
- MCP Server runs as a stdio child process managed by the SDK (not an in-process module).

### 2.2 Request Lifecycle

```
HTTP Request
      |
      v
  Express Router + Auth Middleware
      |
      |  1. Resolve/create conversation
      v
    SQLite (/tmp/messages.db)  <----+
      |                             |
      |  2. Invoke agent            |  4. MCP tools write back
      v                             |
  AgentEngine                       |
  (Claude Agent SDK query())        |
      |                             |
      |  3. Spawns subprocess       |
      v                             |
  MCP Server (stdio) -------->-----+
  - send_message
  - schedule_task
  - list/pause/cancel_task
      .
      .  5. After response
      v
  syncDatabaseToVolume()
  /tmp/messages.db  -->  /data/store/messages.db
```

### 2.3 Data Paths

Persistent volumes (must be mounted on durable storage for cross-request state):

| Path | Env Var | Purpose |
|---|---|---|
| `/data/memory` | `MEMORY_DIR` | CLAUDE.md persona, conversation archives, working directory, `.claude/` SDK session state |
| `/data/org` | `ORG_DIR` | Org CLAUDE.md, managed-mcp.json, org skills (optional, read-only) |
| `/data/store` | `STORE_DIR` | Persistent SQLite database — stores conversations, messages, scheduled tasks, and task run logs. Runtime operates on `/tmp/messages.db`; synced here via `wal_checkpoint(TRUNCATE)` + file copy after every HTTP response and on shutdown. |

Derived / ephemeral paths (not mounted separately):

| Path | Env Var | Purpose |
|---|---|---|
| `$ORG_DIR/skills` | `SKILLS_DIR` | Org skill definitions (derived from `ORG_DIR`; legacy fallback: `/data/skills`) |
| `/tmp/messages.db` | `LOCAL_DB_PATH` | Local runtime database (ephemeral, synced to `STORE_DIR` after each request) |

**Auto-memory (non-functional):** Claude Code's auto-memory feature (`MEMORY.md` auto-generation) is gated behind an internal CLI feature flag (`tengu_herring_clock`, default `false`). In SDK/non-interactive mode, the auto-memory system prompt is never injected, so `MEMORY.md` is never automatically written — regardless of the `CLAUDE_CODE_DISABLE_AUTO_MEMORY` setting. The `entrypoint.sh` script sets up a symlink from the SDK's internal auto-memory path to `/data/memory/` as a forward-compatibility measure, but the feature is currently inert. If cross-session memory is needed, instruct the agent via the persona (`CLAUDE.md`) to explicitly read/write files in `/data/memory/`.

**Empty directory startup:** All `/data/*` volumes can be mounted as empty directories. The container creates the necessary internal structures (`.claude/` directory, database, skill sync) automatically at startup. No `CLAUDE.md` is required — the agent runs with the default Claude Code system prompt. Adding a `CLAUDE.md` persona is recommended but optional.

### 2.4 Persona & System Prompt

PicoClaw assembles the agent's system prompt from a **two-tier CLAUDE.md** model. This determines the agent's identity, capabilities, and behavioral rules.

**Tier 1 — User persona** (`/data/memory/CLAUDE.md`):

The Claude Agent SDK's `query()` is called with `cwd: MEMORY_DIR` and `settingSources: ['project', 'user']`. The `'project'` setting source tells the SDK to discover and load `CLAUDE.md` from the working directory (`/data/memory/`). This is standard Claude Code behavior — any `CLAUDE.md` in the project root is loaded as project-level context.

This file defines the agent's identity (name, role), capabilities, communication style, and user-specific rules. It is the primary persona file — recommended but not required. If absent, the agent runs with the default Claude Code system prompt.

**Tier 2 — Org persona** (`$ORG_DIR/CLAUDE.md`, optional):

PicoClaw's `loadOrgClaudeMd()` function reads this file and passes it as `systemPrompt: { type: 'preset', preset: 'claude_code', append: orgClaudeMd }`. This appends organization-wide instructions to the Claude Code system prompt before the user persona takes effect.

Use this for shared policies (compliance, output format standards, tool usage rules) that should apply to all users in a multi-user deployment. If this file does not exist, no org overlay is applied and the SDK uses the default Claude Code preset.

**Assembly order (default):**

```
1. Claude Code preset system prompt (built-in, always present)
2. Org CLAUDE.md content (appended via systemPrompt.append, if file exists)
3. User CLAUDE.md content (loaded by SDK/CLI from cwd, standard Claude Code discovery)
```

**Full override mode:** Set `SYSTEM_PROMPT_OVERRIDE` to completely replace the Claude Code preset + org CLAUDE.md with a custom system prompt string. Step 3 (user CLAUDE.md) still loads on top. This is useful when you want full control over the system prompt without inheriting Claude Code's built-in instructions. Note: overriding removes the built-in tool usage guidelines, safety rules, and formatting instructions — ensure your custom prompt covers these if needed.

**Example user persona** (`/data/memory/CLAUDE.md`):

```markdown
# Pico

You are Pico, a helpful assistant for the engineering team.

## Communication Style

- Be concise — one or two sentences max
- Use bullet points for lists

## Tools

- `mcp__picoclaw__send_message` — send a message to the caller
- `mcp__picoclaw__schedule_task` — create a scheduled task
```

See `docs/SKILLS_AND_PERSONA_GUIDE.md` for detailed persona authoring guidance.

### 2.5 Cloud Storage Mount Scheme (OSS / EFS / NAS)

When deploying with cloud object storage or network-attached filesystems, map the org-level and user-specific storage to PicoClaw volumes:

```
Org storage (shared, read-only):
└── org/              → mount to /data/org:ro
    ├── CLAUDE.md                              (org persona)
    ├── managed-mcp.json                       (org MCP servers)
    └── skills/                                (org skills)

User storage (per-user, read/write):
└── users/{user_id}/
    ├── memory/       → mount to /data/memory  (persona, agent workspace, SDK state)
    │   ├── CLAUDE.md                          (user persona, recommended)
    │   ├── skills/                            (user-created skills — additive)
    │   ├── .claude/                           (SDK session state)
    │   │   ├── settings.json
    │   │   ├── skills/                        (three-tier skill sync destination)
    │   │   └── sessions/                      (SDK session files)
    │   └── [agent-managed files]              (no enforced structure)
    └── store/        → mount to /data/store   (persistent SQLite)
        └── messages.db
```

#### Persona loading order

PicoClaw uses a **two-tier persona** model. Both files are optional, but at least the user persona is recommended:

| Tier | Path | Mechanism | Purpose |
|---|---|---|---|
| Org | `$ORG_DIR/CLAUDE.md` | `loadOrgClaudeMd()` → `systemPrompt.append` | Organization-wide policies, shared rules |
| User | `/data/memory/CLAUDE.md` | SDK auto-discovery via `cwd` + `settingSources: ['project', 'user']` | Agent identity, user-specific instructions |

The effective system prompt is assembled as: **Claude Code preset** → **org CLAUDE.md** (appended) → **user CLAUDE.md** (loaded by CLI). This mirrors NanoClaw's global + per-group persona stacking, adapted for PicoClaw's single-user model.

For multi-user deployments, mount the org directory from shared storage as read-only. The user persona at `/data/memory/CLAUDE.md` can be customized per user.

Docker mount example with cloud storage paths:

```bash
docker run --rm -it \
  -p 9000:9000 \
  -v /oss/org:/data/org:ro \
  -v /oss/users/${USER_ID}/memory:/data/memory \
  -v /oss/users/${USER_ID}/store:/data/store \
  -e ORG_DIR=/data/org \
  -e API_TOKEN=${GENERATED_TOKEN} \
  -e ANTHROPIC_BASE_URL=${API_BASE} \
  -e ANTHROPIC_API_KEY=${API_KEY} \
  picoclaw:latest
```

The `memory` directory does not enforce a subdirectory structure beyond the persona file. The `conversations/` subdirectory is created on-demand by the PreCompact hook when context compaction occurs, though this rarely happens in practice (compaction only fires within a single query execution). The `skills/` subdirectory is auto-discovered for user-created skills.

## 3. Lifecycle & State

### 3.1 Conversation State

Conversations are tracked in the SQLite `conversations` table:

| Column | Purpose |
|---|---|
| `id` | Conversation identifier (e.g., `conv-abc123`) |
| `session_id` | Claude SDK session ID (for resume) |
| `last_assistant_uuid` | Last assistant message UUID (for `resumeSessionAt`) |
| `status` | `idle` or `running` |
| `message_count` | Total messages in conversation |

Behavior:

- `POST /chat` without `conversation_id`: creates a new conversation.
- `POST /chat` with `conversation_id`: resumes the existing conversation. Returns `404` if not found.
- Session resume uses `session_id` + `last_assistant_uuid` to restore SDK state across requests.

### 3.2 Task State

Scheduled tasks are tracked in the `scheduled_tasks` table:

| Field | Values |
|---|---|
| `schedule_type` | `cron`, `interval`, `once` |
| `context_mode` | `group` (shared conversation) or `isolated` (fresh each run) |
| `status` | `active`, `paused`, `completed` |

Key rules:

- `POST /task/check` executes at most **one** due task per call.
- `once` tasks set `next_run = null` and transition to `completed` after execution.
- `isolated` tasks create a temporary conversation per run to avoid foreign key violations.

### 3.3 Database Sync

The dual-database strategy optimizes for both performance and durability:

- **Runtime**: all reads/writes go to `/tmp/messages.db` (local filesystem, fast I/O).
- **After each HTTP response**: `wal_checkpoint(TRUNCATE)` flushes WAL, then file copy to `/data/store/messages.db`.
- **On shutdown** (`SIGTERM`, `SIGINT`, or `POST /control/stop`): final sync before process exit.

This avoids SQLite-on-NFS corruption risks while ensuring data survives container recycling.

### 3.4 Data Lifecycle & Automatic Cleanup

PicoClaw automatically prunes stale data during each database sync (after every HTTP response and on shutdown). Two cleanup policies run inside `cleanupStaleData()`:

| Policy | Env Var | Default | Behavior |
|---|---|---|---|
| Outbound message TTL | `OUTBOUND_TTL_DAYS` | `7` | Delivered outbound messages older than N days are deleted |
| Task run log retention | `TASK_LOG_RETENTION` | `100` | Per-task, only the most recent N run log entries are kept |

**When to tune these values:**

- **High-traffic deployments** with frequent `send_message` calls may accumulate outbound messages quickly. Reduce `OUTBOUND_TTL_DAYS` (e.g., `3`) to keep the database smaller.
- **Long-running deployments** with many recurring tasks can accumulate run logs. Reduce `TASK_LOG_RETENTION` (e.g., `50`) if storage is constrained, or increase it (e.g., `500`) if you need deeper task execution history for debugging.
- **Short-lived containers** (e.g., single-session Lambda) can safely leave defaults — cleanup runs automatically and the data volume is minimal.

**Configuration example:**

```bash
docker run ... \
  -e OUTBOUND_TTL_DAYS=3 \
  -e TASK_LOG_RETENTION=50 \
  picoclaw:latest
```

These settings only affect automatic cleanup. Undelivered outbound messages are never deleted by TTL. Active (non-delivered) data is always preserved.

### 3.5 SDK Version Alignment

| Package | Version | Notes |
|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | `0.2.86` | Core agent runtime |
| `@modelcontextprotocol/sdk` | `1.28.0` | MCP server framework |

Do not downgrade these packages. Upgrades should include compatibility regression testing.

## 4. Environment Variables

### 4.1 Required

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (or equivalent OAuth token) |

### 4.2 Optional

| Variable | Default | Description |
|---|---|---|
| `API_TOKEN` | _(empty)_ | Bearer token for HTTP API authentication. When unset, authentication is disabled — all endpoints are publicly accessible. Recommended for production; omit for local dev or trusted-network deployments (e.g. FC behind SLB). |
| `ANTHROPIC_BASE_URL` | (empty; SDK uses `https://api.anthropic.com`) | Anthropic API base URL. Only needed for third-party API proxies. |
| `APP_VERSION` | `1.0.0` | Application version; overridden by `BUILD_VERSION` Docker build arg |
| `PORT` | `9000` | HTTP server port |
| `MAX_EXECUTION_MS` | `300000` | Agent execution timeout in ms (5 minutes) |
| `ASSISTANT_NAME` | `Pico` | Agent display name |
| `TZ` | System timezone | Timezone for cron expression parsing |
| `LOG_LEVEL` | `info` | Pino log level (`debug`, `info`, `warn`, `error`) |
| `SDK_LOG_LEVEL` | `off` | Claude Agent SDK stderr output: `off` (default) or `debug` (pipes through pino at debug level) |
| `STORE_DIR` | `/data/store` | Persistent database volume |
| `MEMORY_DIR` | `/data/memory` | Memory and persona volume |
| `ORG_DIR` | (empty) | Org directory path (CLAUDE.md, managed-mcp.json, skills/) |
| `SKILLS_DIR` | `$ORG_DIR/skills` or `/data/skills` | Org skills directory (canonical: `$ORG_DIR/skills`; `/data/skills` is legacy fallback) |
| `LOCAL_DB_PATH` | `/tmp/messages.db` | Local runtime database path |
| `SESSION_END_MARKER` | `[[PICOCLAW_SESSION_END]]` | Marker string for session completion |
| `BUILD_COMMIT` | `unknown` | Git short commit hash, injected at Docker build time |
| `BUILD_TIME` | `unknown` | ISO 8601 UTC build timestamp, injected at Docker build time |
| `CLAUDE_MODEL` | (empty; CLI default) | Model for agent execution (full ID like `claude-opus-4-6` or short name like `opus`) |
| `CLAUDE_FALLBACK_MODEL` | (empty) | Fallback model when primary fails (rate limit, unavailable) |
| `SYSTEM_PROMPT_OVERRIDE` | (empty) | When set, fully replaces the Claude Code preset + org CLAUDE.md with this string. User CLAUDE.md still loads on top. |
| `PICOCLAW_MCP_SERVER_PATH` | `dist/mcp-server.js` | Custom MCP server executable path (legacy `NANOCLAW_MCP_SERVER_PATH` accepted as fallback) |
| `OUTBOUND_TTL_DAYS` | `7` | Days to keep delivered outbound messages before automatic cleanup |
| `TASK_LOG_RETENTION` | `100` | Maximum task run log entries retained per task (oldest pruned) |

## 5. Authentication & Request Tracking

When `API_TOKEN` is set, all endpoints except `GET /health` require:

```http
Authorization: Bearer <API_TOKEN>
```

Error responses (when `API_TOKEN` is set):

| Code | Condition |
|---|---|
| `401 Unauthorized` | Token missing or invalid |

**Auth-free mode:** When `API_TOKEN` is not set (empty or unset), authentication is
disabled — all endpoints are accessible without a token. A warning is logged at startup.
This is intended for local development or deployments behind a trusted network boundary
(e.g. Alibaba Cloud FC behind SLB, AWS Lambda behind API Gateway with its own auth layer).

### 5.1 Request ID

Every response includes an `X-Request-ID` header for log correlation:

```http
X-Request-ID: req-a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

If the caller sends an `X-Request-ID` header, the same value is echoed back. Otherwise, a new `req-<UUID>` is generated. Use this to correlate API requests with server-side logs.

### 5.2 Build Metadata Headers

Every response includes build metadata headers:

```http
X-Build-Version: 1.2.17
X-Build-Commit: abc1234
```

These are set at Docker build time via `BUILD_VERSION` and `BUILD_COMMIT` build args. Use them to identify which version of the code is running in production.

## 6. API Reference

Base URL: `http://localhost:9000` (or your deployment URL)

### 6.1 Health Check

`GET /health`

No authentication required.

```json
{
  "status": "ok",
  "version": "1.2.16",
  "commit": "abc1234",
  "build_time": "2026-03-12T10:00:00Z",
  "max_execution_ms": 300000,
  "database": {
    "ok": true,
    "conversations": 5,
    "tasks": 2
  },
  "volumes": {
    "memory": true,
    "skills": true,
    "sessions": true,
    "store": true
  }
}
```

> **Note:** The `sessions` field checks `$MEMORY_DIR/.claude/` (SDK session state inside the memory volume). It is not a separate mount — the field name is kept for API backward compatibility.

`status` values:

| Value | Meaning |
|---|---|
| `ok` | All backing resources healthy |
| `degraded` | HTTP server is running but database or volumes are unhealthy |

The `database` field verifies SQLite connectivity and returns conversation/task counts. The `volumes` field checks writability of each `/data/*` mount directory (`skills` only checks existence since it may be read-only).

### 6.2 Send / Continue a Conversation

`POST /chat`

Request body:

```json
{
  "message": "What is 1 + 1?",
  "conversation_id": "conv-xxx",
  "sender": "user-1",
  "sender_name": "Alice",
  "stream": false,
  "max_execution_ms": 120000
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | string | Yes | User message text |
| `conversation_id` | string | No | Existing conversation ID (creates new if omitted) |
| `sender` | string | No | Sender identifier (default: `user`) |
| `sender_name` | string | No | Display name (default: same as sender) |
| `stream` | boolean | No | Enable SSE streaming (default: `false`) |
| `max_execution_ms` | number | No | Per-request timeout, capped at server `MAX_EXECUTION_MS` |
| `thinking` | boolean | No | Enable extended thinking (default: `false`) |
| `max_thinking_tokens` | number | No | Max thinking tokens when thinking is enabled (default: `10000`) |
| `show_tool_use` | boolean | No | Stream tool invocation events (default: `false`) |
| `mcp_servers` | object | No | Per-request MCP servers (see Dynamic MCP Servers below) |
| `mcp_context` | object | No | Per-request auth context for MCP servers (see below) |

Non-streaming response:

```json
{
  "status": "success",
  "conversation_id": "conv-0df6...",
  "message_id": "msg-3aaf...",
  "result": "2",
  "session_id": "3e49...",
  "duration_ms": 6701,
  "outbound_messages": [],
  "session_end_marker": "[[PICOCLAW_SESSION_END]]",
  "session_end_marker_detected": false
}
```

`status` values:

| Value | Meaning |
|---|---|
| `success` | Agent completed normally |
| `timeout` | Agent hit execution time limit (partial result may be available) |
| `error` | Agent encountered an error |

Session end fields:

- `session_end_marker`: the configured marker string the runtime looks for.
- `session_end_marker_detected`: `true` if the agent's response contains the marker, signaling the conversation is complete.

### 6.3 SSE Streaming

When `stream: true`, the response uses `Content-Type: text/event-stream`. Text is streamed per-token as the model generates it (via SDK `includePartialMessages`):

| Event | Data | When |
|---|---|---|
| `start` | `{"conversation_id", "message_id"}` | Agent begins processing |
| `thinking` | `{"text": "..."}` | Extended thinking output (requires `thinking: true`) |
| `tool_use` | `{"tool": "...", "input": {...}}` | Tool invocation (requires `show_tool_use: true`) |
| `chunk` | `{"text": "..."}` | Incremental text output (per-token granularity) |
| `done` | Full response object | Agent finished |
| `error` | `{"error": "..."}` | Processing failed |

Example stream (with thinking and tool use enabled):

```text
event: start
data: {"conversation_id":"conv-...","message_id":"msg-..."}

event: thinking
data: {"text":"Let me reason about this..."}

event: tool_use
data: {"tool":"WebSearch","input":{"query":"example"}}

event: chunk
data: {"text":"partial output"}

event: done
data: {"status":"success","conversation_id":"conv-...","session_end_marker":"[[PICOCLAW_SESSION_END]]","session_end_marker_detected":false}
```

### 6.3.1 Dynamic MCP Servers

The `mcp_servers` field allows callers to attach additional MCP servers to a specific request. These are merged with the built-in `picoclaw` MCP server and passed to the Claude Agent SDK's `query()`.

Supported transports:

| Transport | Required fields | Optional |
|---|---|---|
| `http` (default) | `url` | `headers` |
| `sse` | `url` | `headers` |
| `stdio` | `command` | `args`, `env` |

If `type` is omitted, it defaults to `http`.

Example:

```json
{
  "message": "分析最近一周的支出",
  "mcp_servers": {
    "finance": {
      "type": "http",
      "url": "http://example.com/mcp-server/mcp"
    }
  }
}
```

The agent will see tools from all MCP servers as `mcp__<name>__<tool>`. Invalid entries (missing required fields) are silently ignored.

### 6.3.2 Per-Request MCP Context

The `mcp_context` field injects dynamic auth headers or environment variables into existing MCP servers without re-defining their full config. Context is applied after the three-way server merge.

```json
{
  "message": "查询我的订单",
  "mcp_context": {
    "finance": {
      "headers": {
        "Authorization": "Bearer user-token-123",
        "X-Tenant-Id": "tenant-abc"
      }
    }
  }
}
```

| Field | Applies to | Behavior |
|---|---|---|
| `headers` | http/sse | Merged with static headers (context overrides same-key) |
| `env` | stdio | Merged with static env (context overrides same-key) |
| `args` | stdio | Appended to existing args |

Warnings are returned for non-existent server names, reserved names (`picoclaw`), and type mismatches.

### 6.4 List All Conversations

`GET /chat`

```json
{
  "conversations": [
    {
      "conversation_id": "conv-0df6...",
      "session_id": "3e49...",
      "message_count": 4,
      "last_activity": "2026-03-08T01:57:18.082Z",
      "status": "idle"
    }
  ]
}
```

### 6.5 Get Conversation Messages

`GET /chat/:conversation_id/messages`

```json
{
  "conversation_id": "conv-0df6...",
  "messages": [
    {
      "id": "msg-abc",
      "conversation_id": "conv-0df6...",
      "role": "user",
      "sender": "user",
      "sender_name": "Alice",
      "content": "Hello",
      "created_at": "2026-03-08T01:57:18.082Z"
    }
  ]
}
```

Returns `404` if the conversation does not exist.

### 6.6 Delete a Conversation

`DELETE /chat/:conversation_id`

Returns `204 No Content` on success. Deletes all associated messages, outbound messages, and tasks (CASCADE).

Returns `404` if the conversation does not exist. Returns `409` if the conversation is currently running.

### 6.7 Get Conversation Metadata

`GET /chat/:conversation_id`

```json
{
  "conversation_id": "conv-0df6...",
  "session_id": "3e49...",
  "message_count": 4,
  "last_activity": "2026-03-08T01:57:18.082Z",
  "status": "idle"
}
```

Returns `404` if the conversation does not exist.

### 6.8 Create a Scheduled Task

`POST /task`

```json
{
  "id": "daily-report",
  "prompt": "Generate the daily report",
  "schedule_type": "cron",
  "schedule_value": "0 9 * * 1-5",
  "context_mode": "isolated",
  "conversation_id": "conv-xxx"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | No | Custom task ID (auto-generated if omitted) |
| `prompt` | string | Yes | Instruction for the agent |
| `schedule_type` | string | Yes | `cron`, `interval`, or `once` |
| `schedule_value` | string | Yes | Schedule expression (see below) |
| `context_mode` | string | No | `group` or `isolated` (default: `isolated`) |
| `conversation_id` | string | No | Target conversation (auto-created if omitted) |

Schedule value formats:

| Type | Format | Example |
|---|---|---|
| `cron` | 5-field cron expression | `0 9 * * 1-5` (weekdays at 9am) |
| `interval` | Milliseconds as string | `3600000` (every hour) |
| `once` | Local time string (no `Z` or timezone offset) | `2026-03-15T14:00:00` |

### 6.9 List All Tasks

`GET /tasks`

```json
{
  "tasks": [
    {
      "id": "daily-report",
      "conversation_id": "conv-xxx",
      "prompt": "...",
      "schedule_type": "cron",
      "schedule_value": "0 9 * * 1-5",
      "context_mode": "isolated",
      "next_run": "2026-03-09T01:00:00.000Z",
      "last_run": null,
      "last_result": null,
      "status": "active",
      "created_at": "2026-03-08T02:00:00.000Z"
    }
  ]
}
```

### 6.10 Update a Task

`PUT /task/:task_id`

Supports partial updates of: `prompt`, `schedule_type`, `schedule_value`, `context_mode`, `status`, `conversation_id`.

If `schedule_type` or `schedule_value` changes, `next_run` is recalculated automatically.

### 6.11 Delete a Task

`DELETE /task/:task_id`

Returns `204 No Content` on success.

### 6.12 Manually Trigger a Task

`POST /task/trigger`

```json
{
  "task_id": "daily-report"
}
```

Response:

```json
{
  "status": "success",
  "task_id": "daily-report",
  "result": "Report generated successfully.",
  "duration_ms": 4874,
  "next_run": null
}
```

### 6.13 Check and Execute Due Tasks

`POST /task/check`

No due tasks:

```json
{
  "checked": 0,
  "message": "No due tasks"
}
```

With due tasks:

```json
{
  "checked": 3,
  "executed": {
    "status": "success",
    "task_id": "task-1",
    "result": "...",
    "duration_ms": 3500,
    "next_run": "2026-03-08T02:10:00.000Z"
  },
  "remaining": 2
}
```

Each call executes at most **one** due task. Call repeatedly or increase external cron frequency for backlogs.

### 6.14 Reload Skills

`POST /admin/reload-skills`

Re-syncs skills from all three tiers (built-in, org, user) to `.claude/skills/`.

```json
{
  "status": "reloaded",
  "skills": {
    "builtIn": ["agent-browser"],
    "org": ["math-skill"],
    "user": ["custom-skill"],
    "effective": ["agent-browser", "custom-skill", "math-skill"]
  }
}
```

### 6.15 Get Skills Summary

`GET /admin/skills`

Returns the current skills from all three tiers (built-in, org, user).

### 6.16 Graceful Shutdown

`POST /control/stop`

Request body (optional):

```json
{
  "reason": "end-of-session"
}
```

Response:

```json
{
  "status": "stopping",
  "reason": "end-of-session",
  "message": "Shutdown accepted. The runtime will sync data and exit gracefully."
}
```

Typical caller flow:

1. Send messages via `POST /chat`.
2. Check `session_end_marker_detected` in each response.
3. If `true`, call `POST /control/stop` to trigger graceful shutdown (sync + exit).
4. Alternatively, the serverless platform sends `SIGTERM` — the same sync-and-exit sequence runs.

## 7. Deployment Guide

### 7.1 One-Click Script

The repository includes `picoclaw.sh` for automated setup:

```bash
./picoclaw.sh          # Full: env setup → build → docker run → smoke test
./picoclaw.sh up       # Build and start (skip smoke test)
./picoclaw.sh test     # Smoke test a running instance
./picoclaw.sh stop-api # Graceful stop via POST /control/stop
./picoclaw.sh logs     # Tail container logs
./picoclaw.sh down     # Docker stop
```

The script prompts for `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY`, generates an `API_TOKEN`, and writes `.env`.

### 7.2 Local Node.js

```bash
npm ci
npm run build
API_TOKEN=dev-token ANTHROPIC_BASE_URL=https://api.anthropic.com ANTHROPIC_API_KEY=sk-ant-xxx npm start
```

### 7.3 Local Docker

The Dockerfile uses a multi-stage build — TypeScript is compiled inside Docker, so no local Node.js is needed.

Build:

```bash
docker build --platform linux/amd64 -t picoclaw:latest .
```

Run:

```bash
docker run --rm -it \
  -p 9000:9000 \
  -e API_TOKEN=dev-token \
  -e ANTHROPIC_BASE_URL=https://api.anthropic.com \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  -v $(pwd)/dev-data/memory:/data/memory \
  -v $(pwd)/dev-data/store:/data/store \
  picoclaw:latest
```

Or use the Makefile:

```bash
make docker-build
make docker-run
```

### 7.4 Docker Compose

```bash
# Copy .env.example or create .env with ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, and API_TOKEN
docker compose up --build
```

### 7.5 Pre-built Images (GHCR)

Pre-built images are published to GitHub Container Registry. Public pull — no authentication required:

```bash
# Standard image (latest release)
docker pull ghcr.io/breakcafe/picoclaw:latest

# Specific version
docker pull ghcr.io/breakcafe/picoclaw:1.2.16

# Version + commit (for exact build provenance)
docker pull ghcr.io/breakcafe/picoclaw:1.2.16-abc1234

# Lambda variant
docker pull ghcr.io/breakcafe/picoclaw:latest-lambda
```

Dev images are published from non-main branches:

```bash
docker pull ghcr.io/breakcafe/picoclaw:dev
docker pull ghcr.io/breakcafe/picoclaw:dev-abc1234
docker pull ghcr.io/breakcafe/picoclaw:dev-my-feature
```

Run a pre-built image:

```bash
docker run --rm -it \
  -p 9000:9000 \
  -e API_TOKEN=your-token \
  -e ANTHROPIC_BASE_URL=https://api.anthropic.com \
  -e ANTHROPIC_API_KEY=sk-ant-xxx \
  -v $(pwd)/dev-data/memory:/data/memory \
  -v $(pwd)/dev-data/store:/data/store \
  ghcr.io/breakcafe/picoclaw:latest
```

### 7.6 AWS Lambda (Container Image)

**Recommended configuration:**

| Setting | Value |
|---|---|
| Runtime | Container Image |
| Memory | 4096 MB minimum |
| Timeout | `MAX_EXECUTION_MS + 30s` (e.g., 330s for 5-min agent) |
| Storage | EFS mounted at `/data` |

Build the Lambda-adapted image:

```bash
docker build --platform linux/amd64 \
  --build-arg ENABLE_LAMBDA_ADAPTER=true \
  -t picoclaw:lambda .
```

The `ENABLE_LAMBDA_ADAPTER=true` build arg installs the [AWS Lambda Web Adapter](https://github.com/awslabs/aws-lambda-web-adapter) which proxies Lambda invoke events to the Express HTTP server.

**Task scheduling:** Use Amazon EventBridge Scheduler to invoke `POST /task/check` every minute via the Lambda function URL or API Gateway.

**Environment variables:** Inject `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, and `API_TOKEN` via Lambda environment variables or AWS Secrets Manager.

### 7.7 Alibaba Cloud Function Compute (FC)

**Recommended configuration:**

| Setting | Value |
|---|---|
| Runtime | Custom Container |
| Listening port | `9000` |
| Storage | NAS mounted at `/data` |
| Timeout | Greater than `MAX_EXECUTION_MS` |

**Task scheduling:** Configure a timer trigger to call `POST /task/check` at the desired frequency.

## 8. Operations

### 8.1 Security

- Inject `API_TOKEN`, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_API_KEY` via secret management systems — never bake into the image.
- Place PicoClaw behind an API Gateway or WAF for network-level protection.
- Enable request-level audit logging and rate limiting at the gateway layer.
- See `docs/SECURITY.md` for the full trust model.

### 8.2 Concurrency

- The runtime uses SQLite on a local path (`/tmp/messages.db`). SQLite does not support multi-writer concurrency across processes.
- Cloud platform concurrency controls should limit to **one active instance** per conversation scope.
- For strong consistency requirements, implement idempotency and retry logic at the gateway layer.

### 8.3 Scheduled Tasks

- PicoClaw has **no internal scheduler**. Task execution depends entirely on external cron calling `POST /task/check`.
- Each call executes at most one due task. For high-frequency task needs, trigger every 1 minute.
- Monitor the `remaining` field in `/task/check` responses to detect backlog buildup.

### 8.4 Shutdown Strategy

| Method | Trigger | Use Case |
|---|---|---|
| `POST /control/stop` | API call | Programmatic shutdown after session end marker detected |
| `SIGTERM` | Platform signal | Serverless container recycling |
| `SIGINT` | Ctrl+C | Local development |

All three paths execute the same sequence: `syncDatabaseToVolume()` → `closeDatabase()` → process exit.

### 8.5 Backup & Recovery

Recommended backup targets:

| Path | Priority | Contains |
|---|---|---|
| `/data/store/messages.db` | Critical | All conversations, messages, tasks |
| `/data/memory` | High | Persona, archives, `.claude/` SDK session state, agent workspace |
| `/data/org` | Medium | Org persona, MCP config, skills (can be redeployed from shared storage) |

On restore, ensure version compatibility and restore `store` + `memory` together for consistent session resume.

### 8.6 Logging & Monitoring

PicoClaw uses structured JSON logging via `pino`.

Recommended metrics to monitor:

| Metric | Source | Alert Threshold |
|---|---|---|
| Request latency | HTTP response time | P95 > `MAX_EXECUTION_MS` |
| `status=timeout` rate | Chat response `status` field | > 10% |
| `status=error` rate | Chat response `status` field | > 5% |
| Task backlog | `/task/check` `remaining` field | Sustained > 0 |
| `401` rate | HTTP status codes | Spike detection |

## 9. Troubleshooting

### 9.1 `401 Unauthorized`

- Verify the `Authorization: Bearer <token>` header is present.
- Confirm the token matches the server's `API_TOKEN` environment variable exactly.
- If you intend to run without authentication (e.g. local dev), ensure `API_TOKEN` is completely unset (not set to an empty string in a `.env` file).

### 9.2 `conversation_id not found` (404)

- The specified `conversation_id` does not exist in the database.
- Omit `conversation_id` to create a new conversation, or use an existing ID.

### 9.3 `MCP server not found ... dist/mcp-server.js`

- For local Node.js: TypeScript has not been compiled. Run `npm run build` before starting.
- For Docker: the multi-stage build compiles TypeScript during image creation. Rebuild the image if source changed.

### 9.4 `schedule_value` validation errors

| Type | Requirement |
|---|---|
| `interval` | Positive integer in milliseconds (as a string) |
| `cron` | Valid 5-field cron expression |
| `once` | Local timestamp string without `Z` or timezone offset |

### 9.5 Data loss after forced termination

If the container is killed before `syncDatabaseToVolume()` completes, the last request's data may be lost.

Mitigations:

- Set platform timeout with sufficient buffer beyond `MAX_EXECUTION_MS`.
- The runtime syncs after every HTTP response, so only the in-flight request is at risk.

### 9.6 Session end marker not detected

- Check that the agent's response text actually contains `[[PICOCLAW_SESSION_END]]`.
- The marker is configurable via `SESSION_END_MARKER` env var.
- The persona (CLAUDE.md) must instruct the agent when to emit this marker.

## 10. Go-Live Checklist

- [ ] `GET /health` returns `200`
- [ ] `POST /chat` creates a new conversation successfully
- [ ] `POST /chat` with `conversation_id` resumes correctly (multi-turn)
- [ ] `GET /chat` lists conversations
- [ ] `GET /chat/:conversation_id/messages` returns message history
- [ ] `DELETE /chat/:conversation_id` deletes conversation (204)
- [ ] `session_end_marker_detected` triggers as expected
- [ ] `POST /task` + `POST /task/check` execute scheduled tasks
- [ ] `POST /admin/reload-skills` reloads skills from all tiers
- [ ] `GET /admin/skills` returns skills summary
- [ ] `POST /control/stop` syncs data and exits cleanly
- [ ] All `/data/*` volumes are mounted and writable (`memory`, `store`; `org` is optional/read-only)
- [ ] External cron is configured to call `POST /task/check`
- [ ] Logging, alerting, and rate limiting are configured
- [ ] Secrets (`API_TOKEN`, `ANTHROPIC_API_KEY`) are injected via secret manager, not in image or repository
- [ ] Concurrency controls limit to one active instance per conversation scope
