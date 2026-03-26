# PicoClaw API Integration Guide

Guide for downstream developers building systems that call PicoClaw's HTTP API.

## Authentication

When `API_TOKEN` is set, all endpoints except `GET /health` require a Bearer token:

```http
Authorization: Bearer <API_TOKEN>
```

The token is configured via the `API_TOKEN` environment variable on the PicoClaw server.

**Auth-free mode:** When `API_TOKEN` is not set, authentication is disabled and all
endpoints are accessible without a token. This is intended for local development or
trusted-network deployments (e.g. behind a VPC or cloud-native gateway that handles
its own authentication).

## Response Headers

Every HTTP response includes these headers:

| Header | Description |
|---|---|
| `X-Request-ID` | Request tracking identifier for log correlation. Echoes caller-provided value or generates `req-<UUID>`. |
| `X-Build-Version` | Application version (from `package.json`, injected at Docker build time). |
| `X-Build-Commit` | Short git commit hash of the build. |

Use `X-Request-ID` for log correlation. Use `X-Build-Version` and `X-Build-Commit` to verify which code version is running.

## Conversation Lifecycle

### Start a new conversation

```bash
curl -X POST http://localhost:9000/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'
```

Response:

```json
{
  "status": "success",
  "conversation_id": "conv-a1b2c3d4",
  "message_id": "msg-e5f6g7h8",
  "result": "Hello! How can I help you?",
  "session_id": "sess-xxx",
  "duration_ms": 3200,
  "outbound_messages": [],
  "session_end_marker": "[[PICOCLAW_SESSION_END]]",
  "session_end_marker_detected": false,
  "usage": {
    "inputTokens": 150,
    "outputTokens": 42,
    "totalCostUsd": 0.002,
    "numTurns": 1,
    "durationApiMs": 2800
  }
}
```

Save `conversation_id` for follow-up messages.

The `usage` field is optional — present when the SDK provides metrics, absent otherwise. Fields:

| Field | Type | Description |
|---|---|---|
| `inputTokens` | integer | Input tokens consumed |
| `outputTokens` | integer | Output tokens generated |
| `totalCostUsd` | number | Total API cost in USD |
| `numTurns` | integer | Number of agent turns (API calls) |
| `durationApiMs` | integer | Time spent in API calls (ms) |

### Continue a conversation

```bash
curl -X POST http://localhost:9000/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Can you elaborate on that?",
    "conversation_id": "conv-a1b2c3d4"
  }'
```

The agent resumes from the previous session state. Conversation history and Claude session metadata are persisted across requests.

### Check conversation status

```bash
curl http://localhost:9000/chat/conv-a1b2c3d4 \
  -H "Authorization: Bearer $TOKEN"
```

Returns `message_count`, `last_activity`, and `status` (idle/running).

If the conversation does not exist, returns `404`.

## SSE Streaming

For real-time output, set `stream: true`:

```bash
curl -N -X POST http://localhost:9000/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message": "Write a poem", "stream": true}'
```

SSE events:

| Event | Data | When |
|---|---|---|
| `start` | `{"conversation_id", "message_id"}` | Agent starts processing |
| `thinking` | `{"text": "..."}` | Thinking process (requires `thinking: true`) |
| `tool_use` | `{"tool": "...", "input": {...}}` | Tool invocation (requires `show_tool_use: true`) |
| `chunk` | `{"text": "..."}` | Incremental text output |
| `done` | Full response object | Agent finished |
| `error` | `{"error": "..."}` | Processing failed |

### Client example (Node.js)

```javascript
import EventSource from 'eventsource';

const response = await fetch('http://localhost:9000/chat', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer your-token',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ message: 'Hello', stream: true }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const text = decoder.decode(value);
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      // Handle event data
    }
  }
}
```

### Client example (Python)

```python
import requests
import json

response = requests.post(
    'http://localhost:9000/chat',
    headers={
        'Authorization': 'Bearer your-token',
        'Content-Type': 'application/json',
    },
    json={'message': 'Hello', 'stream': True},
    stream=True,
)

for line in response.iter_lines():
    line = line.decode('utf-8')
    if line.startswith('data: '):
        data = json.loads(line[6:])
        if 'text' in data:
            print(data['text'], end='', flush=True)
```

## Thinking Process & Tool Use Display

### Extended Thinking

Request the model's reasoning process by setting `thinking: true`:

```bash
curl -N -X POST http://localhost:9000/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Analyze this complex problem",
    "stream": true,
    "thinking": true,
    "max_thinking_tokens": 5000
  }'
```

When enabled, the SSE stream includes `thinking` events before `chunk` events:

```text
event: thinking
data: {"text":"Let me break this down..."}

event: thinking
data: {"text":"First, I need to consider..."}

event: chunk
data: {"text":"Based on my analysis..."}
```

The `thinking` parameter requires `stream: true` to see thinking events. In non-streaming mode, thinking occurs internally but is not returned in the response.

### Tool Use Display

See which tools the agent invokes by setting `show_tool_use: true`:

```bash
curl -N -X POST http://localhost:9000/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Search for the latest news",
    "stream": true,
    "show_tool_use": true
  }'
```

Tool invocations appear as `tool_use` events in the SSE stream:

```text
event: tool_use
data: {"tool":"WebSearch","input":{"query":"latest news today"}}

event: chunk
data: {"text":"Here are the latest headlines..."}
```

Both options can be combined: `thinking: true, show_tool_use: true` shows the full agent reasoning and tool usage in the SSE stream.

## Session End Detection

PicoClaw supports a session-end marker mechanism. When the agent determines that the conversation is complete, the response includes:

```json
{
  "session_end_marker": "[[PICOCLAW_SESSION_END]]",
  "session_end_marker_detected": true
}
```

**Recommended caller flow:**

1. Send message via `POST /chat`.
2. Check `session_end_marker_detected` in the response.
3. If `true` and no further interaction is needed, call `POST /control/stop` to trigger graceful shutdown (data sync + process exit).
4. If `false`, continue the conversation normally.

This is particularly useful in serverless environments where you want the container to shut down after completing a task.

## Dynamic MCP Servers

PicoClaw can connect to external MCP servers on a per-request basis. Pass `mcp_servers` in the chat request to give the agent access to additional tools:

```bash
curl -X POST http://localhost:9000/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "请帮我分析一下最近一周的支出情况",
    "mcp_servers": {
      "finance": {
        "type": "http",
        "url": "http://example.com/mcp-server/mcp"
      }
    }
  }'
```

Supported transport types:

| Transport | Config | Example |
|---|---|---|
| HTTP (Streamable HTTP) | `{ "type": "http", "url": "...", "headers": {...} }` | Remote MCP servers |
| SSE | `{ "type": "sse", "url": "...", "headers": {...} }` | SSE-based MCP servers |
| stdio | `{ "type": "stdio", "command": "...", "args": [...], "env": {...} }` | Local subprocess |

Per-request MCP servers are merged with the built-in `picoclaw` MCP server and any org-managed servers (from `managed-mcp.json`). The agent sees tools from all servers with the naming pattern `mcp__<server_name>__<tool_name>`.

If `type` is omitted, it defaults to `http`. Invalid entries produce a `warnings` array in the response instead of being silently dropped.

### Server Name Restrictions

- `picoclaw` is reserved and cannot be used as a per-request MCP server name.
  Attempts to use it are rejected with a warning in the response.
- Per-request servers can override org-managed servers of the same name
  (the per-request config takes precedence for that request only).
- Merge priority: org-managed → built-in `picoclaw` (protected) → per-request (highest).

## Scheduled Tasks

### Create a task

```bash
curl -X POST http://localhost:9000/task \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "daily-summary",
    "prompt": "Summarize the latest news",
    "schedule_type": "cron",
    "schedule_value": "0 9 * * 1-5",
    "context_mode": "isolated"
  }'
```

**Schedule types:**

| Type | `schedule_value` format | Example |
|---|---|---|
| `cron` | Standard 5-field cron expression | `0 9 * * 1-5` (weekdays 9am) |
| `interval` | Milliseconds as string | `3600000` (every hour) |
| `once` | Local time string (no timezone suffix) | `2026-03-15T14:00:00` |

**Context modes:**

| Mode | Behavior |
|---|---|
| `group` | Runs within an existing conversation (requires `conversation_id`) |
| `isolated` | Creates a fresh temporary conversation for each execution |

### Trigger tasks externally

PicoClaw does not run an internal scheduler. Tasks are triggered by external cron (EventBridge, FC timer):

```bash
# Execute the next due task (call every 1 minute from external cron)
curl -X POST http://localhost:9000/task/check \
  -H "Authorization: Bearer $TOKEN"
```

Response when a task was executed:

```json
{
  "checked": 3,
  "executed": {
    "status": "success",
    "task_id": "daily-summary",
    "result": "Here is today's summary...",
    "duration_ms": 12000,
    "next_run": "2026-03-11T09:00:00.000Z"
  },
  "remaining": 2
}
```

Each call to `/task/check` executes at most **one** due task. If multiple tasks are due, call it repeatedly or increase cron frequency.

### Manually trigger a specific task

```bash
curl -X POST http://localhost:9000/task/trigger \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"task_id": "daily-summary"}'
```

## Graceful Shutdown

```bash
curl -X POST http://localhost:9000/control/stop \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "end-of-session"}'
```

The server will:

1. Sync the database to the persistent volume.
2. Close database connections.
3. Exit the process.

Alternatively, send `SIGTERM` to the container (the default serverless platform behavior). Both paths execute the same sync-and-exit sequence.

### List all conversations

```bash
curl http://localhost:9000/chat \
  -H "Authorization: Bearer $TOKEN"
```

Returns all conversations ordered by last activity (most recent first).

### Get conversation messages

```bash
curl http://localhost:9000/chat/conv-a1b2c3d4/messages \
  -H "Authorization: Bearer $TOKEN"
```

Returns the full message history for a conversation.

### Delete a conversation

```bash
curl -X DELETE http://localhost:9000/chat/conv-a1b2c3d4 \
  -H "Authorization: Bearer $TOKEN"
```

Returns `204 No Content` on success. Returns `409` if the conversation is currently running.

## Skills Management

### Reload skills

```bash
curl -X POST http://localhost:9000/admin/reload-skills \
  -H "Authorization: Bearer $TOKEN"
```

Re-syncs skills from all three tiers (built-in, org, user) to `.claude/skills/`.

### Get skills summary

```bash
curl http://localhost:9000/admin/skills \
  -H "Authorization: Bearer $TOKEN"
```

Returns the current skills from all three tiers and the effective (merged) list.

## Error Handling

### HTTP Status Codes

| Code | Meaning |
|---|---|
| 200 | Success |
| 204 | Success (no content, e.g., DELETE) |
| 400 | Invalid request (missing fields, bad schedule) |
| 401 | Missing or invalid Bearer token (only when `API_TOKEN` is set) |
| 404 | Conversation or task not found |
| 409 | Conflict (conversation busy or currently running) |
| 500 | Server error |

### Response status field

The `status` field in chat responses can be:

| Value | Meaning | Action |
|---|---|---|
| `success` | Agent completed normally | Use `result` |
| `timeout` | Agent hit execution time limit | Partial result may be available; retry with same `conversation_id` to continue |
| `error` | Agent encountered an error | Check `error` field for details |

### Timeout behavior

- Default timeout: 300 seconds (configurable via `MAX_EXECUTION_MS`).
- Per-request override: pass `max_execution_ms` in the chat request body (capped at server maximum).
- On timeout, the agent is aborted and any partial result is returned with `status: "timeout"`.
- The caller can resume by sending a new message to the same `conversation_id`.

## Request Fields Reference

### POST /chat

| Field | Type | Required | Description |
|---|---|---|---|
| `message` | string | Yes | User message text |
| `conversation_id` | string | No | Existing conversation to continue (creates new if omitted) |
| `sender` | string | No | Sender identifier (default: `user`) |
| `sender_name` | string | No | Display name (default: same as sender) |
| `stream` | boolean | No | Enable SSE streaming (default: false) |
| `max_execution_ms` | number | No | Per-request timeout (capped at `MAX_EXECUTION_MS`) |
| `thinking` | boolean | No | Enable extended thinking (default: false) |
| `max_thinking_tokens` | number | No | Max thinking tokens (default: 10000, only when `thinking=true`) |
| `show_tool_use` | boolean | No | Stream tool invocation events (default: false) |
| `mcp_servers` | object | No | Per-request MCP servers (HTTP/SSE/stdio transports) |

### POST /task

| Field | Type | Required | Description |
|---|---|---|---|
| `id` | string | No | Custom task ID (auto-generated if omitted) |
| `prompt` | string | Yes | Task instruction for the agent |
| `schedule_type` | string | Yes | `cron`, `interval`, or `once` |
| `schedule_value` | string | Yes | Schedule expression (see table above) |
| `context_mode` | string | No | `group` or `isolated` (default: `isolated`) |
| `conversation_id` | string | No | Target conversation (required for `group` mode) |
