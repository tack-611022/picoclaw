# PicoClaw Configuration Reference

Quick-reference for all configuration surfaces. For detailed explanations, see the linked docs.

## 1. Environment Variables

### Required

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key (scrubbed from agent Bash environment) |

### Runtime

| Variable | Default | Purpose |
|---|---|---|
| `API_TOKEN` | _(empty)_ | Bearer token for HTTP API authentication. When unset, authentication is disabled — all endpoints are publicly accessible. Set for production; omit for local dev or trusted-network deployments. |
| `ANTHROPIC_BASE_URL` | _(empty; SDK uses `api.anthropic.com`)_ | API proxy URL. Only needed for third-party proxies. |
| `PORT` | `9000` | HTTP server port |
| `MAX_EXECUTION_MS` | `300000` | Agent execution timeout (ms) |
| `ASSISTANT_NAME` | `Pico` | Display name in messages and transcript archives |
| `SESSION_END_MARKER` | `[[PICOCLAW_SESSION_END]]` | Agent emits this to signal conversation complete |
| `CLAUDE_MODEL` | _(empty; CLI default)_ | Model for agent execution (full ID or short name) |
| `CLAUDE_FALLBACK_MODEL` | _(empty)_ | Fallback model on primary failure |
| `SYSTEM_PROMPT_OVERRIDE` | _(empty)_ | Replaces Claude Code preset + org CLAUDE.md entirely |
| `LOG_LEVEL` | `info` | Pino log level (`debug` / `info` / `warn` / `error`) |
| `SDK_LOG_LEVEL` | `off` | Claude Agent SDK stderr output: `off` (default) or `debug` (pipes through pino at debug level) |
| `TZ` | System timezone | Timezone for cron expressions |

### Paths

| Variable | Default | Purpose |
|---|---|---|
| `MEMORY_DIR` | `/data/memory` | Agent cwd, persona, `.claude/` session state |
| `STORE_DIR` | `/data/store` | Persistent SQLite sync target |
| `ORG_DIR` | _(empty)_ | Org resources (CLAUDE.md, skills/, managed-mcp.json); read-only |
| `SKILLS_DIR` | `$ORG_DIR/skills` or `/data/skills` | Org skills directory |
| `BUILT_IN_SKILLS_DIR` | `/app/built-in-skills` | Built-in skills (Docker image internal) |
| `LOCAL_DB_PATH` | `/tmp/messages.db` | Ephemeral runtime SQLite |

### Cleanup

| Variable | Default | Purpose |
|---|---|---|
| `OUTBOUND_TTL_DAYS` | `7` | Days to keep delivered outbound messages |
| `TASK_LOG_RETENTION` | `100` | Max run logs per task |

### Performance

| Variable | Default | Purpose |
|---|---|---|
| `NODE_COMPILE_CACHE` | `/tmp/node-compile-cache` | V8 bytecode cache directory. Reduces CLI subprocess parse time by ~140ms once warm (Node.js 22+). Set by `entrypoint.sh`; override to disable or relocate. |

### MCP Subprocess (legacy stdio mode, not used by default)

The built-in picoclaw MCP server now runs in-process (`type: 'sdk'`). These env vars
are only relevant when using the legacy stdio mode via `PICOCLAW_MCP_SERVER_PATH`.

| Variable | Default | Purpose |
|---|---|---|
| `PICOCLAW_DB_PATH` | `/tmp/messages.db` | Shared SQLite path for MCP tools (stdio mode) |
| `PICOCLAW_CONVERSATION_ID` | per-request | Current conversation scope (stdio mode) |
| `PICOCLAW_IS_MAIN` | `1` | Enables cross-conversation task management (stdio mode) |
| `PICOCLAW_MCP_SERVER_PATH` | _(unset)_ | When set, forces stdio subprocess mode for the built-in MCP server |

### Removed

| Variable | Status |
|---|---|
| `SESSIONS_DIR` | Removed. SDK session state now lives at `$MEMORY_DIR/.claude/`. |

### SDK Internal Settings

Written to `.claude/settings.json` by `entrypoint.sh` at startup. Not user-configurable.

| Setting | Value | Purpose |
|---|---|---|
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `1` | Enable multi-agent team collaboration |
| `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` | `1` | Discover CLAUDE.md in skill directories |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `0` | Auto-memory toggle (gated by internal feature flag, currently inert) |

### Docker Build Args

| Build Arg | Maps To | Default | Purpose |
|---|---|---|---|
| `BUILD_VERSION` | `APP_VERSION` | `unknown` | Semantic version → health response + `X-Build-Version` header |
| `BUILD_COMMIT` | `BUILD_COMMIT` | `unknown` | Git hash → health response + `X-Build-Commit` header |
| `BUILD_TIME` | `BUILD_TIME` | `unknown` | ISO 8601 timestamp → health response |
| `ENABLE_LAMBDA_ADAPTER` | _(build only)_ | `false` | Install AWS Lambda Web Adapter |

---

## 2. Volumes

### Persistent (mount to durable storage)

| Mount Point | Env Var | R/W | Purpose |
|---|---|---|---|
| `/data/memory` | `MEMORY_DIR` | RW | Agent workspace, persona, `.claude/` SDK state, user skills |
| `/data/store` | `STORE_DIR` | RW | Persistent SQLite database — stores conversations, messages, scheduled tasks, and task run logs. Runtime operates on `/tmp/messages.db` for fast local I/O; `wal_checkpoint(TRUNCATE)` + file copy syncs to this volume after every HTTP response and on shutdown. |
| `/data/org` | `ORG_DIR` | RO | Org persona, skills, managed-mcp.json (optional) |

### Auto-created inside MEMORY_DIR

| Path | Created By | Purpose |
|---|---|---|
| `.claude/` | entrypoint.sh | SDK session state, symlinked to `~/.claude` |
| `.claude/settings.json` | entrypoint.sh | SDK config (agent teams, CLAUDE.md discovery) |
| `.claude/skills/` | entrypoint.sh | Effective skill set (three-tier sync destination) |
| `skills/` | entrypoint.sh | User skills (persistent source, hot-reloadable) |
| `conversations/` | agent-engine.ts | Archived transcripts (on-demand, rare) |

### Ephemeral

| Path | Env Var | Purpose |
|---|---|---|
| `/tmp/messages.db` | `LOCAL_DB_PATH` | Runtime SQLite (fast local I/O) |

---

## 3. API Endpoints

All except `/health` require `Authorization: Bearer <API_TOKEN>`.

### System

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Health check (no auth) — status, version, database, volumes |
| POST | `/control/stop` | Graceful shutdown — sync DB, exit |

### Conversations

| Method | Path | Purpose |
|---|---|---|
| POST | `/chat` | Send message (create or resume conversation) |
| GET | `/chat` | List all conversations |
| GET | `/chat/:conversation_id` | Get conversation metadata |
| GET | `/chat/:conversation_id/messages` | Get message history |
| DELETE | `/chat/:conversation_id` | Delete conversation + related data |

### Tasks

| Method | Path | Purpose |
|---|---|---|
| POST | `/task` | Create scheduled task |
| GET | `/tasks` | List all tasks |
| PUT | `/task/:task_id` | Update task |
| DELETE | `/task/:task_id` | Delete task |
| POST | `/task/trigger` | Execute specific task immediately |
| POST | `/task/check` | Execute next due task (for external cron) |

### Admin

| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/reload-skills` | Re-sync skills from all tiers |
| GET | `/admin/skills` | Get skills summary |

---

## 4. POST /chat Options

| Field | Type | Default | Purpose |
|---|---|---|---|
| `message` | string | _(required)_ | User message text |
| `conversation_id` | string | _(auto-create)_ | Resume existing conversation |
| `sender` | string | `user` | Sender identifier |
| `sender_name` | string | = sender | Display name |
| `stream` | boolean | `false` | Enable SSE streaming |
| `max_execution_ms` | number | server max | Per-request timeout (capped at `MAX_EXECUTION_MS`) |
| `thinking` | boolean | `false` | Enable extended thinking |
| `max_thinking_tokens` | number | `10000` | Max thinking tokens |
| `show_tool_use` | boolean | `false` | Stream tool invocation events |
| `model` | string | _(omit recommended)_ | Model override (full ID or short name). Omit to follow CLI default — avoids locking to a specific version |
| `mcp_servers` | object | — | Per-request MCP servers (see §8) |
| `mcp_context` | object | — | Per-request auth context for MCP servers (see §8) |

**Not yet exposed:** `max_turns` (turn limit), `max_budget_usd` (budget cap). These exist in the Claude Agent SDK but PicoClaw does not pass them through.

**Model precedence:** per-request `model` > `CLAUDE_MODEL` env var > CLI default. Recommended: omit both to let the CLI track the latest default model automatically.

### SSE Events (when `stream: true`)

| Event | Payload | Condition |
|---|---|---|
| `start` | `{conversation_id, message_id}` | Always |
| `thinking` | `{text}` | `thinking: true` |
| `tool_use` | `{tool, input}` | `show_tool_use: true` |
| `chunk` | `{text}` | Always (per-token) |
| `done` | Full response | Always |
| `error` | `{error}` | On failure |

---

## 5. POST /task Options

| Field | Type | Default | Purpose |
|---|---|---|---|
| `id` | string | _(auto-generate)_ | Custom task ID |
| `prompt` | string | _(required)_ | Task instruction for the agent |
| `schedule_type` | string | _(required)_ | `cron`, `interval`, or `once` |
| `schedule_value` | string | _(required)_ | Schedule expression (see below) |
| `context_mode` | string | `isolated` | `group` (shared conversation) or `isolated` (fresh each run) |
| `conversation_id` | string | _(auto-create)_ | Target conversation (required for `group` mode) |

### Schedule expression formats

| Type | Format | Example |
|---|---|---|
| `cron` | 5-field cron (affected by `TZ`) | `0 9 * * 1-5` (weekdays 9am) |
| `interval` | Milliseconds as string | `3600000` (every hour) |
| `once` | Local time string (no `Z` or timezone offset) | `2026-03-15T14:00:00` |

`PUT /task/:task_id` supports partial updates of all fields above plus `status` (`active` / `paused` / `completed`).

---

## 6. Persona & System Prompt

Assembly order (top = base, bottom = highest priority):

```
┌─────────────────────────────────────┐
│ Claude Code preset (built-in)       │  Always present
├─────────────────────────────────────┤
│ Org CLAUDE.md                       │  $ORG_DIR/CLAUDE.md (appended, optional)
├─────────────────────────────────────┤
│ User CLAUDE.md                      │  $MEMORY_DIR/CLAUDE.md (SDK auto-discovery)
└─────────────────────────────────────┘
```

- `SYSTEM_PROMPT_OVERRIDE` replaces the first two layers; user CLAUDE.md still loads on top.
- Both files are optional. Empty `/data/*` volumes work — agent runs with default prompt.

---

## 7. Skills

### Three-Tier Merge (load order)

| Tier | Source | Override Behavior | Reload |
|---|---|---|---|
| Built-in | `$BUILT_IN_SKILLS_DIR` | Base layer | Container restart |
| Org | `$SKILLS_DIR` | Overrides built-in of same name | `POST /admin/reload-skills` |
| User | `$MEMORY_DIR/skills/` | Additive only (cannot override org/built-in) | `POST /admin/reload-skills` |

### Effective destination

`$MEMORY_DIR/.claude/skills/` — cleared and rebuilt on each sync.

### Runtime-created skills

Skills created by the agent during chat (written to `.claude/skills/`) are automatically persisted to `$MEMORY_DIR/skills/` before the next sync, so they survive container restarts.

---

## 8. MCP Servers

### Sources (3 layers)

| Source | Scope | Config Location | Availability |
|---|---|---|---|
| Built-in `picoclaw` | Always | Hardcoded in `agent-engine.ts` | Every request |
| Org managed | Always (if configured) | `$ORG_DIR/managed-mcp.json` → loaded by `src/managed-mcp.ts` | Every request |
| Per-request | Single request | `mcp_servers` field in `POST /chat` | That request only |

Merge priority (later overrides earlier same-name server): org-managed → built-in `picoclaw` (protected) → per-request. The name `picoclaw` is reserved and cannot be used by org-managed or per-request servers.

### Per-request transport types

| Type | Required | Optional |
|---|---|---|
| `http` (default) | `url` | `headers` |
| `sse` | `url` | `headers` |
| `stdio` | `command` | `args`, `env` |

### Per-request MCP context (`mcp_context`)

`mcp_context` injects per-request auth headers or env vars into existing MCP servers
without re-defining their full config. Applied after the three-way server merge.

| Field | Applies to | Behavior |
|---|---|---|
| `headers` | http/sse | Merged with static headers (context overrides same-key) |
| `env` | stdio | Merged with static env (context overrides same-key) |
| `args` | stdio | Appended to existing args |

Warnings are returned for: reserved names (`picoclaw`), non-existent server names,
type mismatches (e.g., `headers` on stdio). Auth-related headers are scrubbed from logs.

### Built-in MCP tools

| Tool | Purpose |
|---|---|
| `mcp__picoclaw__send_message` | Queue message for HTTP caller |
| `mcp__picoclaw__schedule_task` | Create cron/interval/once task |
| `mcp__picoclaw__list_tasks` | List tasks (main: all; non-main: own only) |
| `mcp__picoclaw__pause_task` | Pause task |
| `mcp__picoclaw__resume_task` | Resume task |
| `mcp__picoclaw__cancel_task` | Delete task |
| `mcp__picoclaw__update_task` | Modify task fields |

---

## 9. Runtime Controls

### Shutdown

| Method | Trigger | Effect |
|---|---|---|
| `POST /control/stop` | API call | sync DB → close → exit |
| `SIGTERM` | Platform signal | sync DB → close → exit |
| `SIGINT` | Ctrl+C | sync DB → close → exit |

### Database Sync

Runs automatically after every HTTP response and on shutdown: `wal_checkpoint(TRUNCATE)` → file copy to `STORE_DIR`.

### Config Reload Timing

| What | How to Reload |
|---|---|
| CLAUDE.md (user/org) | Automatic per-request (SDK re-reads on each `query()`) |
| `.claude/settings.json` | Automatic per-request |
| Skills (source dirs) | `POST /admin/reload-skills` |
| `managed-mcp.json` | Container restart |
| Environment variables | Container restart |

---

## 10. Response Headers

Every HTTP response includes:

| Header | Value |
|---|---|
| `X-Request-ID` | Echoes caller header or generates `req-<UUID>` |
| `X-Build-Version` | `APP_VERSION` |
| `X-Build-Commit` | `BUILD_COMMIT` |

---

## 11. FAQ

### Q1: How do I override the system prompt?

Three methods, increasing in control:

**A. Org CLAUDE.md (append, recommended):** Create `$ORG_DIR/CLAUDE.md` with org-wide rules. Appended after the Claude Code preset; does not replace it.

```bash
docker run -v /path/to/org:/data/org:ro -e ORG_DIR=/data/org ...
```

**B. User CLAUDE.md (agent identity):** Create `/data/memory/CLAUDE.md` to define the agent's persona and behavioral rules. Auto-discovered by the SDK via `cwd`.

**C. SYSTEM_PROMPT_OVERRIDE (full replace):** Set the env var to completely replace the Claude Code preset + org CLAUDE.md. User CLAUDE.md still loads on top. Warning: removes built-in tool usage guidelines and safety rules.

### Q2: Can I select a specific model?

Yes. Set `CLAUDE_MODEL` env var for a server-wide default, or pass `model` in the `POST /chat` request body for per-request override. Accepts full model IDs (`claude-opus-4-6`) or short names (`opus`, `sonnet`, `haiku`). Set `CLAUDE_FALLBACK_MODEL` for automatic retry on primary model failure. The response includes a `model` field showing which model was actually used.

### Q3: How are API keys managed?

Two distinct keys:

| Key | Purpose | Set via |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude API access | Environment variable (required) |
| `API_TOKEN` | PicoClaw HTTP API auth | Environment variable (required) |

`ANTHROPIC_API_KEY` lifecycle: injected via env var → passed to SDK `query()` via `env` option → SDK subprocess calls Anthropic API → `PreToolUse` hook scrubs it from Bash environment before any shell command.

For third-party API proxies, set `ANTHROPIC_BASE_URL`:

```bash
docker run -e ANTHROPIC_BASE_URL=https://your-proxy.com/anthropic -e ANTHROPIC_API_KEY=proxy-key ...
```

### Q4: What is the default API_TOKEN?

There is no hardcoded default. `API_TOKEN` is required — if unset, the server returns `500`.

| Scenario | Token source |
|---|---|
| `picoclaw.sh` script | Auto-generates `picoclaw-<16-char-hex>` via `openssl rand` |
| `docker-compose.yml` | `${API_TOKEN:-dev-token-123}` from `.env` |
| Manual Docker | Must be explicitly provided |

### Q5: How do I enable extended thinking?

Per-request via `POST /chat`:

```json
{
  "message": "Analyze this problem",
  "stream": true,
  "thinking": true,
  "max_thinking_tokens": 5000
}
```

- Requires `stream: true` to see `thinking` SSE events
- In non-streaming mode, thinking occurs internally but is not returned
- No global env var to enable by default

### Q6: How do I add external tools to the agent?

| Method | Scope | Config location |
|---|---|---|
| Org MCP servers | All requests | `$ORG_DIR/managed-mcp.json` |
| Per-request MCP servers | Single request | `mcp_servers` field in `POST /chat` |
| Built-in MCP tools | All requests | `src/mcp-server.ts` (requires code change) |

Org MCP servers are loaded programmatically from `$ORG_DIR/managed-mcp.json` by `src/managed-mcp.ts` at startup and merged into `query()` `mcpServers`. They are **not** loaded via CLI auto-discovery from `/etc/claude-code/` (which would conflict with programmatic `--mcp-config`).

---

## 12. Configuration Cross-Reference

How each setting can be configured:

| Setting | Env Var | Per-Request | Config File |
|---|---|---|---|
| API key | `ANTHROPIC_API_KEY` | — | — |
| API endpoint | `ANTHROPIC_BASE_URL` | — | — |
| HTTP auth token | `API_TOKEN` | — | — |
| Server port | `PORT` | — | — |
| Global timeout cap | `MAX_EXECUTION_MS` | — | — |
| Request timeout | — | `max_execution_ms` | — |
| Agent display name | `ASSISTANT_NAME` | — | — |
| Log level | `LOG_LEVEL` | — | — |
| Timezone | `TZ` | — | — |
| Session end marker | `SESSION_END_MARKER` | — | — |
| Model selection | `CLAUDE_MODEL` | `model` | — |
| Model fallback | `CLAUDE_FALLBACK_MODEL` | — | — |
| Streaming | — | `stream` | — |
| Extended thinking | — | `thinking` | — |
| Thinking token cap | — | `max_thinking_tokens` | — |
| Tool use display | — | `show_tool_use` | — |
| Dynamic MCP servers | — | `mcp_servers` | — |
| Dynamic MCP context | — | `mcp_context` | — |
| Org MCP servers | — | — | `$ORG_DIR/managed-mcp.json` |
| System prompt override | `SYSTEM_PROMPT_OVERRIDE` | — | — |
| Org persona | — | — | `$ORG_DIR/CLAUDE.md` |
| User persona | — | — | `$MEMORY_DIR/CLAUDE.md` |
| Storage paths | `MEMORY_DIR` / `STORE_DIR` | — | — |
| Org directory | `ORG_DIR` | — | — |
| Data cleanup | `OUTBOUND_TTL_DAYS` / `TASK_LOG_RETENTION` | — | — |
| Model selection | **not exposed** | **not exposed** | — |
| Agent teams | — | — | `.claude/settings.json` (auto) |
