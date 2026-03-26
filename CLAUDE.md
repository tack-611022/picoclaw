# PicoClaw

Serverless-first Claude Agent runtime. HTTP API for conversations and scheduled tasks.
Forked from NanoClaw — no Docker child containers, no channel adapters.

## Code Style

- ESM modules with explicit `.js` extensions in imports: `import { foo } from './bar.js'`
- Single quotes, 2-space indentation (Prettier enforced, see `.prettierrc`)
- Named exports only, no default exports
- TypeScript strict mode; interfaces for data types (not type aliases)
- File naming: `kebab-case.ts`, tests colocated as `kebab-case.test.ts`
- Logger: `logger.info({ context }, 'message')` — structured pino, context object first
- Route pattern: factory function returning `Router` (see `src/routes/health.ts` for minimal example)

## Development Commands

```bash
npm run build              # tsc compile to dist/
npm run typecheck          # type check only (no emit)
npm test                   # run all tests (vitest)
npx vitest run src/db.test.ts   # run single test file
npm run dev                # dev mode with tsx (no build needed)
npm run format:check       # check formatting
npm run format:fix         # fix formatting (also runs on pre-commit hook)
```

Full tooling reference: `make help` shows all Makefile targets.

## Docker Workflow

The Dockerfile uses a **multi-stage build** — TypeScript compilation happens inside Docker,
so no local Node.js is required for building images.

```bash
./picoclaw.sh              # one-click: env setup → build → docker run → smoke test
./picoclaw.sh up           # build and start (no smoke test)
./picoclaw.sh test         # smoke test running service
./picoclaw.sh stop-api     # graceful stop via POST /control/stop
./picoclaw.sh down         # docker stop
./picoclaw.sh logs         # tail container logs
```

Alternatively: `make docker-build && make docker-run` for manual control.

### GHCR (Container Registry)

Images are published to `ghcr.io/breakcafe/picoclaw`. On `main`, tags are `latest`,
`<version>`, `<version>-<commit>`. On other branches, tags are `dev`, `dev-<commit>`,
`dev-<branch>`. Lambda variants append `-lambda`.

```bash
make ghcr-build            # build standard image with GHCR tags
make ghcr-build-lambda     # build Lambda image with GHCR tags
make ghcr-push             # push standard image to GHCR
make ghcr-push-lambda      # push Lambda image to GHCR
make ghcr-release          # build + push all (standard + Lambda)
make ghcr-make-public      # one-time: set package visibility to public (requires public repo or GitHub Team plan)
```

## Architecture

```
src/index.ts          → process boot, directory init, shutdown signals
src/server.ts         → Express app: middleware (json, requestId, build headers, request logger, db sync) → healthRoutes → authMiddleware → chat/task/admin/control
src/routes/chat.ts    → POST /chat (SSE streaming), GET /chat, GET /chat/:id, GET /chat/:id/messages
src/routes/task.ts    → task CRUD + POST /task/trigger + POST /task/check
src/routes/admin.ts   → POST /admin/reload-skills, GET /admin/skills
src/routes/control.ts → POST /control/stop (graceful shutdown)
src/conversation-lock.ts → per-conversation mutex (prevents concurrent agent execution)
src/agent-engine.ts   → Claude Agent SDK query() wrapper, hooks, timeout via AbortController
src/mcp-server.ts     → MCP tools (send_message, schedule_task, etc.) backed by SQLite
src/db.ts             → SQLite schema, CRUD operations, dual-path sync
src/skills.ts         → skill directory sync + .claude/settings.json bootstrap
src/config.ts         → all env var defaults
src/types.ts          → shared interfaces (Conversation, ScheduledTask, etc.)
```

### Boot sequence

```
entrypoint.sh
  ├── mkdir MEMORY_DIR, /data/store
  ├── symlink ~/.claude → $MEMORY_DIR/.claude
  ├── write settings.json (if absent)
  ├── persist runtime-created skills → $MEMORY_DIR/skills/
  └── three-tier skill sync (bash level)

src/index.ts main()
  ├── ensureDataDirectories()
  ├── initDatabase()
  ├── ensureClaudeSettings()       ← write settings.json (if absent, redundant with entrypoint)
  ├── syncSkills()                 ← three-tier skill sync (TS level, redundant but safe)
  ├── loadManagedMcpServers()      ← read $ORG_DIR/managed-mcp.json into memory cache
  ├── Startup diagnostics log      ← paths, persona, MCP servers, model, SDK log level
  └── Express listen on PORT
```

The two-pass skill sync (entrypoint.sh + index.ts) is intentionally redundant: entrypoint.sh handles the Docker path, index.ts handles the local Node.js path (`npm start`).

### Request lifecycle

1. HTTP hits Express router → `authMiddleware` validates Bearer token (skipped when `API_TOKEN` is unset)
2. Route handler resolves/creates conversation in SQLite
3. `acquireConversationLock()` prevents concurrent execution on same conversation (409 if busy)
4. `AgentEngine.run()` wraps prompt in `MessageStream`, calls `query()`
5. SDK spawns CLI subprocess → CLI spawns MCP Server (stdio)
6. Agent executes tools; MCP tools read/write same SQLite via `PICOCLAW_DB_PATH`
7. `query()` yields `system/init` (session_id, tools, mcp_servers), `assistant` (uuid), `result` messages
8. Route stores `session_id` + `last_assistant_uuid` for next resume
9. Conversation lock released in `finally` block
10. `syncDatabaseToVolume()` runs after response completes

### Database schema (5 tables in `src/db.ts`)

- `conversations` — id, session_id, last_assistant_uuid, status (idle/running), message_count
- `messages` — id, conversation_id (FK), role, sender, content, created_at
- `outbound_messages` — queued messages from MCP `send_message`, delivered flag
- `scheduled_tasks` — id, conversation_id (FK), prompt, schedule_type/value, context_mode, next_run, status
- `task_run_logs` — task_id (FK), run_at, duration_ms, status, result, error

### MCP tools (defined in `src/mcp-server.ts`)

The MCP server runs as a stdio subprocess. Tools share the SQLite DB:

- `send_message` — queue message for HTTP caller during agent execution
- `schedule_task` — create cron/interval/once task
- `list_tasks` — list tasks (main session: all; non-main: own conversation only)
- `pause_task` / `resume_task` — pause/resume with ownership check
- `cancel_task` — delete task with ownership check
- `update_task` — modify prompt, schedule, context_mode

### Volume mount semantics

| Mount | Runtime access | Agent `cwd` | Purpose |
|---|---|---|---|
| `/data/org` | Read-only | No | Org persona, org skills, managed MCP config (optional) |
| `/data/memory` | Read/Write | **Yes** (set as cwd) | User persona (`CLAUDE.md`), agent workspace, `.claude/` SDK session state |
| `/data/store` | Write (sync target) | No | Persistent SQLite (conversations, messages, scheduled tasks, run logs); synced from `/tmp/messages.db` after each response |
| `/tmp` | Read/Write | No | Local runtime DB (ephemeral, fast) |

### Persona and system prompt

PicoClaw uses a **two-tier CLAUDE.md** model for the agent's persona and system prompt,
implemented in `src/agent-engine.ts`:

| Tier | File | Code mechanism | Purpose |
|---|---|---|---|
| Org | `$ORG_DIR/CLAUDE.md` | `loadOrgClaudeMd()` → `systemPrompt: { preset: 'claude_code', append }` | Organization-wide policies, shared rules |
| User | `/data/memory/CLAUDE.md` | `cwd: MEMORY_DIR` + `settingSources: ['project', 'user']` → SDK auto-discovers | Agent identity, capabilities, user-specific rules |

Assembly order (default): **Claude Code preset** → **org CLAUDE.md** (appended, if `ORG_DIR` is set) →
**user CLAUDE.md** (loaded by CLI from `cwd`). Both files are optional. All `/data/*` volumes
can be mounted as empty directories — the container starts and functions without a persona file.

**System prompt override:** Set `SYSTEM_PROMPT_OVERRIDE` env var to completely replace the
Claude Code preset + org CLAUDE.md with a custom system prompt. The user CLAUDE.md
(from `cwd`) is still loaded on top. When unset (default), the standard two-tier append
model is used.

Key implementation details:

- `settingSources: ['project', 'user']` is required for the SDK to discover CLAUDE.md in `cwd`.
  Without it, the SDK loads no filesystem settings (isolation by default).
- When `ORG_DIR` is empty or `$ORG_DIR/CLAUDE.md` does not exist, `systemPrompt` is `undefined`
  and the SDK falls back to the default Claude Code preset. The user CLAUDE.md still loads.
- When `SYSTEM_PROMPT_OVERRIDE` is set, it takes precedence over both the preset and org
  CLAUDE.md. The value is passed as a plain string to `systemPrompt`, fully replacing the
  built-in Claude Code prompt. Use with caution — this removes built-in tool instructions.
- The `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1'` setting in `.claude/settings.json`
  also enables CLAUDE.md discovery in `additionalDirectories` (skill paths from `SKILLS_DIR`).

### Org MCP servers (`managed-mcp.json`)

When `ORG_DIR` is set and `$ORG_DIR/managed-mcp.json` exists, `src/managed-mcp.ts`
reads it at startup and caches the server configs in memory. These are merged
programmatically into `query()` `mcpServers` for every request — **not** via CLI
auto-discovery from `/etc/claude-code/`. CLI auto-discovery is avoided because it
triggers an enterprise MCP exclusion that prevents `--mcp-config` usage, breaking
the built-in picoclaw server and per-request dynamic servers.

MCP servers come from three sources, merged with this priority:

1. `managed-mcp.json` (from `$ORG_DIR`) — org-level, loaded by `managed-mcp.ts`
2. Built-in `picoclaw` — always present, protected (cannot be overridden)
3. Per-request `mcp_servers` — passed via `POST /chat` body (can override managed same-name)

### Adding a new route

1. Create `src/routes/myroute.ts` with `export function myRoutes(): Router`
2. Mount in `src/server.ts` after `authMiddleware` (or before, if no auth needed)
3. Add test in `src/routes/myroute.test.ts` using supertest (see `server.test.ts` for pattern)

### Adding an MCP tool

1. Add tool definition in `src/mcp-server.ts` under the `server.tool()` section
2. Use `z` (zod) for input validation
3. Read/write via the shared SQLite `db` instance
4. Tool is auto-discovered by agent as `mcp__picoclaw__<tool_name>`

### Dynamic MCP servers (per-request)

`POST /chat` accepts an optional `mcp_servers` field that lets callers attach
additional MCP servers to a specific request. These are merged with the built-in
`picoclaw` MCP server and passed to the SDK's `query()` call.

Supported transport types (maps to SDK `McpServerConfig`):

| Transport | Required fields |
|---|---|
| `http` | `url` (and optional `headers`) |
| `sse` | `url` (and optional `headers`) |
| `stdio` | `command` (and optional `args`, `env`) |

Example request with an HTTP MCP server:

```json
{
  "message": "请帮我分析一下最近一周的支出情况",
  "mcp_servers": {
    "finance": {
      "type": "http",
      "url": "http://example.com/mcp-server/mcp"
    }
  }
}
```

The agent will see tools from all configured MCP servers. Tool names follow the
pattern `mcp__<server_name>__<tool_name>` — so the example above exposes
`mcp__finance__*` tools alongside the built-in `mcp__picoclaw__*` tools.

## Non-Negotiable Principles

1. **Memory and conversation history are core** — never treat as optional. Cross-request
   personalization depends on persistent mounted paths.
2. **Persistent data model** — `MEMORY_DIR` and `STORE_DIR`
   must be preserved on mounted volumes. `ORG_DIR` is read-only and optional.
   SDK session state lives at `$MEMORY_DIR/.claude/` (no separate `SESSIONS_DIR`).
3. **Graceful stop must sync data** — both `POST /control/stop` and `SIGTERM`/`SIGINT`
   trigger `syncDatabaseToVolume()` → `closeDatabase()` → exit.
4. **SDK version alignment** — `@anthropic-ai/claude-agent-sdk`: `0.2.74`,
   `@modelcontextprotocol/sdk`: `1.27.1`. Do not downgrade.
5. **Dual-DB sync is the only safe write path** — never write directly to
   `/data/store/messages.db`. Always operate on `/tmp/messages.db` and let sync copy it.

## Key Environment Variables

| Variable | Default | Code location |
|---|---|---|
| `ANTHROPIC_BASE_URL` | (empty; SDK defaults to `https://api.anthropic.com`) | Used by SDK internally; set for third-party API proxies |
| `ANTHROPIC_API_KEY` | (required) | Used by SDK internally |
| `APP_VERSION` | `1.0.0` | `src/config.ts` → health response, `X-Build-Version` header; overridden by `BUILD_VERSION` Docker ARG |
| `API_TOKEN` | _(empty)_ | `src/config.ts` → auth middleware. When unset, auth is disabled (all endpoints public). |
| `PORT` | `9000` | `src/config.ts` |
| `MAX_EXECUTION_MS` | `300000` | `src/config.ts` → AbortController timeout |
| `MEMORY_DIR` | `/data/memory` | `src/config.ts` → agent cwd, persona, `.claude/` session state |
| `STORE_DIR` | `/data/store` | `src/config.ts` → persistent SQLite sync target |
| `ASSISTANT_NAME` | `Pico` | `src/config.ts` → agent display name, transcript archiving |
| `LOG_LEVEL` | `info` | `src/logger.ts` → pino log level (`debug`, `info`, `warn`, `error`) |
| `SESSION_END_MARKER` | `[[PICOCLAW_SESSION_END]]` | `src/config.ts` → chat response |
| `ORG_DIR` | (empty) | `src/config.ts` → org persona, org skills, managed MCP config |
| `SKILLS_DIR` | `$ORG_DIR/skills` or `/data/skills` (fallback) | `src/config.ts` → org skills directory |
| `PICOCLAW_DB_PATH` | `/tmp/messages.db` | MCP server env var (set by agent-engine; `NANOCLAW_DB_PATH` as fallback) |
| `PICOCLAW_CONVERSATION_ID` | per-request | MCP server env var (set by agent-engine; `NANOCLAW_CONVERSATION_ID` as fallback) |
| `PICOCLAW_IS_MAIN` | `1` | MCP server env var — enables cross-conversation task management |
| `BUILD_COMMIT` | `unknown` | `src/config.ts` → git commit hash, injected at Docker build time |
| `BUILD_TIME` | `unknown` | `src/config.ts` → build timestamp, injected at Docker build time |
| `CLAUDE_MODEL` | (empty; CLI default) | `src/config.ts` → model for `query()` (full ID or short name) |
| `CLAUDE_FALLBACK_MODEL` | (empty) | `src/config.ts` → fallback model on primary failure |
| `SYSTEM_PROMPT_OVERRIDE` | (empty) | When set, fully replaces Claude Code preset + org CLAUDE.md |
| `SDK_LOG_LEVEL` | `off` | `off` or `debug` — pipes SDK stderr through pino at debug level |
| `OUTBOUND_TTL_DAYS` | `7` | Days to keep delivered outbound messages before cleanup |
| `TASK_LOG_RETENTION` | `100` | Max task run logs kept per task (oldest pruned on sync) |

## Common Gotchas

- **Reserved MCP server name**: `picoclaw` is reserved for the built-in MCP server.
  Per-request `mcp_servers` entries using this name are rejected with a warning.
  managed-mcp.json entries named `picoclaw` are rejected at load time with a warning.
- **Enterprise MCP exclusion**: Claude Code CLI rejects `--mcp-config` when
  `/etc/claude-code/managed-mcp.json` exists. PicoClaw avoids this by loading
  managed-mcp.json programmatically via `src/managed-mcp.ts` instead of copying
  it to `/etc/claude-code/`. Never place files in `/etc/claude-code/`.
- **ESM `.js` in imports**: TypeScript compiles `.ts` → `.js` but import paths must already
  say `.js`. Forgetting this causes runtime `ERR_MODULE_NOT_FOUND`.
- **MCP server is a subprocess**: `src/mcp-server.ts` runs as a stdio child process spawned
  by the SDK, not as part of the main Express server. It shares the SQLite DB via
  `PICOCLAW_DB_PATH` env var. You cannot import it directly.
- **Dual-DB sync**: Runtime operates on `/tmp/messages.db` (fast local). Every HTTP response
  triggers `syncDatabaseToVolume()` which does `wal_checkpoint(TRUNCATE)` + file copy to
  `STORE_DIR`. Never write directly to the volume path.
- **Pre-compact hook**: `agent-engine.ts` archives transcripts to
  `/data/memory/conversations/` when Claude compacts context. This rarely triggers in
  PicoClaw's request-driven model — only when a single `query()` execution approaches the
  context window limit.
- **MessageStream wrapping**: Prompts are wrapped in an `AsyncIterable` (not passed as strings)
  to prevent the SDK from prematurely closing stdin and killing subagents. See
  `MessageStream` class in `agent-engine.ts`.
- **Isolated task conversations**: When `context_mode=isolated`, the MCP server calls
  `ensureConversationExists()` before creating a task to avoid FK constraint violations.
- **`format` vs `format:fix`**: Both run Prettier write. The pre-commit hook calls `format:fix`.
  Use `format:check` to verify without modifying.
- **Auto-memory is non-functional**: Claude Code's auto-memory feature (`MEMORY.md`
  auto-generation) is gated behind an internal feature flag (`tengu_herring_clock`,
  default `false`) in the CLI. In SDK/non-interactive mode, the auto-memory system prompt
  is never injected, so `MEMORY.md` is never written — regardless of the
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY` setting. `entrypoint.sh` sets up a symlink from the
  SDK's auto-memory path to `/data/memory/` as a forward-compatibility measure, but the
  feature is currently inert. Cross-session memory must be implemented in the persona
  (`CLAUDE.md`) by instructing the agent to read/write files in `/data/memory/` explicitly.
- **Zod v4 + MCP SDK**: `@modelcontextprotocol/sdk@1.27.1` supports `zod ^3.25 || ^4.0`,
  so MCP tool schemas in `src/mcp-server.ts` use the standard `import { z } from 'zod'`
  (v4). If the MCP SDK is ever downgraded below 1.27.1, MCP tools with parameters will
  break at runtime with `keyValidator._parse is not a function` because older SDK versions
  only support zod v3.
- **Org skills are authoritative**: User skills (`$MEMORY_DIR/skills/`) are additive only —
  they cannot override org or built-in skills of the same name. This ensures org policies
  remain the authoritative source.
- **`additionalDirectories` is NOT skill discovery**: `discoverAdditionalDirectories()`
  passes org skill subdirectory paths to `query()` as `additionalDirectories`. This only
  grants file access and CLAUDE.md discovery in those paths — it does NOT make them skill
  sources. Skill discovery always comes from `.claude/skills/` via `syncSkills()`. Adding
  a new skill directory to `additionalDirectories` will not register its SKILL.md files.

## Change Guardrails

After any code change, verify:

```bash
npm run build && npm test           # must pass
npm run format:check                # must pass
```

Also check:

- OpenAPI spec (`docs/api/openapi.yaml`) updated if API contract changed
- `CHANGELOG.md` updated for user-visible changes
- Stop path still syncs data and exits cleanly

## Docs

- @docs/CONFIGURATION_REFERENCE.md — all env vars, API endpoints, volumes, and controls at a glance
- @docs/SERVERLESS_API_DEPLOYMENT_GUIDE.md — full operations and deployment manual
- @docs/API_INTEGRATION_GUIDE.md — downstream HTTP API integration guide
- @docs/SKILLS_AND_PERSONA_GUIDE.md — skill authoring and persona configuration
- @docs/SECURITY.md — HTTP API trust model and deployment hardening
- @docs/DESIGN_RATIONALE.md — architectural decisions and first-principles reasoning
- @docs/SDK_DEEP_DIVE.md — Claude Agent SDK internals (query, session resume, hooks)
- `docs/api/openapi.yaml` / `openapi.json` — API specification (validated by `src/openapi.test.ts`)
- `docs/api/postman_collection.json` — API smoke testing collection
