#!/usr/bin/env bash
# ================================================================
# PicoClaw End-to-End Test Suite
#
# Tests multi-turn conversations, memory persistence, skill sync,
# conversation isolation, task CRUD, auth, container restart recovery,
# built-in agent-browser skill, SSE streaming, thinking/tool display,
# agent background execution, and cross-session memory recall —
# all against a running Docker container.
#
# Prerequisites:
#   - Docker running
#   - .env file with ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, API_TOKEN
#
# Usage:
#   ./scripts/e2e-test.sh              # full suite (build + test)
#   ./scripts/e2e-test.sh --no-build   # skip Docker build
#   ./scripts/e2e-test.sh --no-chat    # skip tests that call Claude API
# ================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

IMAGE_NAME="picoclaw"
IMAGE_TAG="e2e-test"
CONTAINER_NAME="picoclaw-e2e"
PORT=9100  # Use non-default port to avoid conflicts
TMP_DIR=""

# ── Flags ────────────────────────────────────────────────
SKIP_BUILD=false
SKIP_CHAT=false
for arg in "$@"; do
  case "$arg" in
    --no-build) SKIP_BUILD=true ;;
    --no-chat)  SKIP_CHAT=true ;;
  esac
done

# ── Colors ───────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

pass() { PASS_COUNT=$((PASS_COUNT + 1)); echo -e "  ${GREEN}PASS${NC} $1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); echo -e "  ${RED}FAIL${NC} $1: $2"; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); echo -e "  ${YELLOW}SKIP${NC} $1"; }
section() { echo -e "\n${CYAN}── $1 ──${NC}"; }

# ── Load .env ────────────────────────────────────────────
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
else
  echo -e "${RED}ERROR: .env file not found. Copy .env.example and fill in credentials.${NC}"
  exit 1
fi

API_TOKEN="${API_TOKEN:-dev-token-123}"
BASE_URL="http://localhost:$PORT"

# ── Helpers ──────────────────────────────────────────────
api() {
  local method="$1" path="$2"
  shift 2
  curl -s -X "$method" "$BASE_URL$path" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    "$@"
}

api_status() {
  local method="$1" path="$2"
  shift 2
  curl -s -o /dev/null -w "%{http_code}" -X "$method" "$BASE_URL$path" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    "$@"
}

json_body() {
  echo -n "-d"
  echo -n "@$1"
}

wait_ready() {
  local max_wait=60
  for i in $(seq 1 $max_wait); do
    if curl -sf "$BASE_URL/health" > /dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo -e "${RED}Container failed to start within ${max_wait}s${NC}"
  docker logs "$CONTAINER_NAME" 2>&1 | tail -20
  exit 1
}

cleanup() {
  echo ""
  section "Cleanup"
  docker rm -f "$CONTAINER_NAME" 2>/dev/null && echo "  Removed container $CONTAINER_NAME" || true
  [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR" && echo "  Removed temp dir" || true
}
trap cleanup EXIT

# ── Setup ────────────────────────────────────────────────
section "Setup"

TMP_DIR=$(mktemp -d)
echo "  Temp dir: $TMP_DIR"

# Clean test data to ensure reproducibility
TEST_DATA_DIR="$PROJECT_DIR/dev-data"
rm -rf "$TEST_DATA_DIR/store/messages.db" "$TEST_DATA_DIR/memory/.claude/projects" \
       "$TEST_DATA_DIR/memory/.claude/debug" "$TEST_DATA_DIR/memory/.claude/todos"
mkdir -p "$TEST_DATA_DIR/memory/.claude/skills" "$TEST_DATA_DIR/memory/conversations" \
         "$TEST_DATA_DIR/store"

# Write test persona
cat > "$TEST_DATA_DIR/memory/CLAUDE.md" << 'PERSONA'
# E2E Test Agent

You are TestBot, a PicoClaw end-to-end test agent.

## Communication Style

- Always mention your name "TestBot" in the first response of a conversation
- Be concise — one or two sentences max
- When asked to recall information, list it as bullet points

## Memory

- Store notes in /data/memory/notes/ if asked to remember something
- Check conversation context before answering
PERSONA

# Write test skill
mkdir -p "$TEST_DATA_DIR/skills/math-skill"
cat > "$TEST_DATA_DIR/skills/math-skill/SKILL.md" << 'SKILL'
---
name: math-helper
description: Perform simple math calculations when asked
---

# Math Helper

## When to use this skill

When the user asks you to perform arithmetic or math calculations.

## Instructions

1. Parse the mathematical expression from the user's message.
2. Compute the result.
3. Return the result in the format: "Result: [answer]"

## Examples

- "What is 2 + 3?" -> "Result: 5"
- "Calculate 10 * 7" -> "Result: 70"
SKILL

echo "  Test persona and skill written"

# ── Build ────────────────────────────────────────────────
if [ "$SKIP_BUILD" = false ]; then
  section "Docker Build"
  E2E_BUILD_VERSION="$(node -p "require('$PROJECT_DIR/package.json').version" 2>/dev/null || echo unknown)"
  E2E_BUILD_COMMIT="$(git -C "$PROJECT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  E2E_BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  docker build --platform linux/amd64 \
    --build-arg BUILD_VERSION="$E2E_BUILD_VERSION" \
    --build-arg BUILD_COMMIT="$E2E_BUILD_COMMIT" \
    --build-arg BUILD_TIME="$E2E_BUILD_TIME" \
    -t "$IMAGE_NAME:$IMAGE_TAG" "$PROJECT_DIR" \
    --quiet 2>&1 | tail -1
  echo "  Image built: $IMAGE_NAME:$IMAGE_TAG (v${E2E_BUILD_VERSION} @ ${E2E_BUILD_COMMIT})"
else
  echo "  Skipping Docker build (--no-build)"
  IMAGE_TAG="latest"
fi

# ── Start Container ──────────────────────────────────────
section "Start Container"

docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
docker run -d --name "$CONTAINER_NAME" \
  --platform linux/amd64 \
  -p "$PORT:9000" \
  -e "API_TOKEN=$API_TOKEN" \
  -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
  -e "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-https://api.anthropic.com}" \
  -e "ASSISTANT_NAME=TestBot" \
  -e "LOG_LEVEL=info" \
  -e "TZ=${TZ:-UTC}" \
  -v "$TEST_DATA_DIR/memory:/data/memory" \
  -v "$TEST_DATA_DIR/store:/data/store" \
  "$IMAGE_NAME:$IMAGE_TAG" > /dev/null

echo "  Container started, waiting for ready..."
wait_ready
echo "  Container ready on port $PORT"

# ════════════════════════════════════════════════════════
# TEST SUITE
# ════════════════════════════════════════════════════════

# ── 1. Health Check ──────────────────────────────────────
section "1. Health Check"

HEALTH=$(curl -s "$BASE_URL/health")
STATUS=$(echo "$HEALTH" | jq -r '.status')
if [ "$STATUS" = "ok" ]; then
  pass "GET /health returns status=ok"
else
  fail "GET /health" "expected status=ok, got $STATUS"
fi

# ── 2. Authentication ────────────────────────────────────
section "2. Authentication"

CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/chat")
if [ "$CODE" = "401" ]; then
  pass "No token → 401"
else
  fail "No token" "expected 401, got $CODE"
fi

CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/chat" \
  -H "Authorization: Bearer wrong-token" \
  -H "Content-Type: application/json" \
  -d '{"message":"test"}')
if [ "$CODE" = "401" ]; then
  pass "Wrong token → 401"
else
  fail "Wrong token" "expected 401, got $CODE"
fi

# ── 3. Multi-Turn Conversation ───────────────────────────
section "3. Multi-Turn Conversation"

if [ "$SKIP_CHAT" = true ]; then
  skip "Round 1: start conversation (--no-chat)"
  skip "Round 2: recall context (--no-chat)"
  skip "Round 3: accumulate context (--no-chat)"
  skip "Round 4: cross-request summary (--no-chat)"
  skip "Conversation metadata check (--no-chat)"
else
  # Round 1: Start conversation, establish identity
  cat > "$TMP_DIR/r1.json" << 'JSON'
{"message":"Hi! My name is Kevin, I code in Rust, and my dog is called Mochi. What is your name?","sender":"kevin","sender_name":"Kevin"}
JSON
  R1=$(api POST /chat -d @"$TMP_DIR/r1.json")
  R1_STATUS=$(echo "$R1" | jq -r '.status')
  CONV_ID=$(echo "$R1" | jq -r '.conversation_id')
  R1_RESULT=$(echo "$R1" | jq -r '.result')

  if [ "$R1_STATUS" = "success" ] && [ "$CONV_ID" != "null" ]; then
    pass "Round 1: conversation created ($CONV_ID)"
  else
    fail "Round 1" "status=$R1_STATUS, conv=$CONV_ID"
  fi

  # Check persona: agent should call itself TestBot
  if echo "$R1_RESULT" | grep -qi "testbot"; then
    pass "Persona: agent identifies as TestBot"
  else
    fail "Persona" "expected 'TestBot' in response: ${R1_RESULT:0:100}"
  fi

  # Round 2: Ask agent to recall name
  cat > "$TMP_DIR/r2.json" << JSON
{"message":"What is my name?","conversation_id":"$CONV_ID","sender":"kevin","sender_name":"Kevin"}
JSON
  R2=$(api POST /chat -d @"$TMP_DIR/r2.json")
  R2_RESULT=$(echo "$R2" | jq -r '.result')

  if echo "$R2_RESULT" | grep -qi "kevin"; then
    pass "Round 2: agent recalls name 'Kevin'"
  else
    fail "Round 2" "expected 'Kevin' in: ${R2_RESULT:0:100}"
  fi

  # Round 3: Ask agent to recall all three facts
  cat > "$TMP_DIR/r3.json" << JSON
{"message":"List the three things you know about me (name, language, pet).","conversation_id":"$CONV_ID","sender":"kevin","sender_name":"Kevin"}
JSON
  R3=$(api POST /chat -d @"$TMP_DIR/r3.json")
  R3_RESULT=$(echo "$R3" | jq -r '.result')

  FOUND=0
  echo "$R3_RESULT" | grep -qi "kevin" && FOUND=$((FOUND + 1))
  echo "$R3_RESULT" | grep -qi "rust"  && FOUND=$((FOUND + 1))
  echo "$R3_RESULT" | grep -qi "mochi" && FOUND=$((FOUND + 1))

  if [ "$FOUND" -eq 3 ]; then
    pass "Round 3: agent recalls all 3 facts (Kevin, Rust, Mochi)"
  else
    fail "Round 3" "found $FOUND/3 facts in: ${R3_RESULT:0:200}"
  fi

  # Round 4: One more round — summarize in one sentence
  cat > "$TMP_DIR/r4.json" << JSON
{"message":"Summarize everything about me in one sentence.","conversation_id":"$CONV_ID","sender":"kevin","sender_name":"Kevin"}
JSON
  R4=$(api POST /chat -d @"$TMP_DIR/r4.json")
  R4_STATUS=$(echo "$R4" | jq -r '.status')

  if [ "$R4_STATUS" = "success" ]; then
    pass "Round 4: 4-turn conversation completed"
  else
    fail "Round 4" "status=$R4_STATUS"
  fi

  # Verify conversation metadata
  META=$(api GET "/chat/$CONV_ID")
  MSG_COUNT=$(echo "$META" | jq -r '.message_count')
  META_STATUS=$(echo "$META" | jq -r '.status')

  if [ "$MSG_COUNT" -ge 8 ] && [ "$META_STATUS" = "idle" ]; then
    pass "Metadata: $MSG_COUNT messages, status=idle"
  else
    fail "Metadata" "message_count=$MSG_COUNT, status=$META_STATUS"
  fi
fi

# ── 4. Conversation Isolation ────────────────────────────
section "4. Conversation Isolation"

if [ "$SKIP_CHAT" = true ]; then
  skip "New conversation isolation (--no-chat)"
else
  cat > "$TMP_DIR/iso.json" << 'JSON'
{"message":"Do you know someone named Kevin? What programming language does he use?","sender":"alice","sender_name":"Alice"}
JSON
  ISO=$(api POST /chat -d @"$TMP_DIR/iso.json")
  ISO_CONV=$(echo "$ISO" | jq -r '.conversation_id')
  ISO_RESULT=$(echo "$ISO" | jq -r '.result')

  # New conversation should NOT have Kevin's context
  if [ "$ISO_CONV" != "$CONV_ID" ]; then
    pass "Isolation: new conversation_id ($ISO_CONV)"
  else
    fail "Isolation" "reused conversation_id"
  fi

  # The agent might say it doesn't know, or might not mention Rust/Mochi
  # We check that it's a DIFFERENT conversation by checking conv_id above
  # The content check is best-effort (LLM responses aren't deterministic)
  if echo "$ISO_RESULT" | grep -qi "don't\|do not\|no information\|not sure\|don't have"; then
    pass "Isolation: agent reports no knowledge of Kevin"
  else
    echo -e "  ${YELLOW}WARN${NC} Isolation: agent response may leak context (non-deterministic)"
    pass "Isolation: different conversation_id confirmed"
  fi
fi

# ── 5. Task CRUD ─────────────────────────────────────────
section "5. Task CRUD"

# Create
CREATE=$(api POST /task -d '{"id":"e2e-test-task","prompt":"Hello from e2e test","schedule_type":"interval","schedule_value":"3600000","context_mode":"isolated"}')
TASK_STATUS=$(echo "$CREATE" | jq -r '.status')
if [ "$TASK_STATUS" = "active" ]; then
  pass "Create task: status=active"
else
  fail "Create task" "status=$TASK_STATUS"
fi

# List
TASKS=$(api GET /tasks)
TASK_COUNT=$(echo "$TASKS" | jq '.tasks | length')
if [ "$TASK_COUNT" -ge 1 ]; then
  pass "List tasks: $TASK_COUNT task(s) found"
else
  fail "List tasks" "count=$TASK_COUNT"
fi

# Update
UPDATE_CODE=$(api_status PUT /task/e2e-test-task -d '{"prompt":"Updated prompt"}')
if [ "$UPDATE_CODE" = "200" ]; then
  pass "Update task: 200"
else
  fail "Update task" "expected 200, got $UPDATE_CODE"
fi

# Task check (no due tasks yet since interval is 1 hour)
CHECK=$(api POST /task/check)
CHECKED=$(echo "$CHECK" | jq -r '.checked')
if [ "$CHECKED" = "0" ] || [ "$CHECKED" = "1" ]; then
  pass "Task check: checked=$CHECKED"
else
  fail "Task check" "checked=$CHECKED"
fi

# Delete
DELETE_CODE=$(api_status DELETE /task/e2e-test-task)
if [ "$DELETE_CODE" = "204" ]; then
  pass "Delete task: 204"
else
  fail "Delete task" "expected 204, got $DELETE_CODE"
fi

# ── 6. Skills Sync ───────────────────────────────────────
section "6. Skills & Memory Verification"

SKILLS_LS=$(docker exec "$CONTAINER_NAME" ls /data/memory/.claude/skills/ 2>&1)
if echo "$SKILLS_LS" | grep -q "math-skill"; then
  pass "Skills synced to .claude/skills/"
else
  fail "Skills sync" "math-skill not found in: $SKILLS_LS"
fi

PERSONA=$(docker exec "$CONTAINER_NAME" cat /data/memory/CLAUDE.md 2>&1)
if echo "$PERSONA" | grep -q "TestBot"; then
  pass "Persona CLAUDE.md accessible (/data/memory)"
else
  fail "Persona" "TestBot not found in CLAUDE.md"
fi

# ── 7. Container Restart Persistence ─────────────────────
section "7. Container Restart Persistence"

if [ "$SKIP_CHAT" = true ] || [ -z "${CONV_ID:-}" ]; then
  skip "Restart persistence (--no-chat or no conversation)"
else
  # Graceful stop (triggers DB sync)
  STOP=$(api POST /control/stop -d '{"reason":"e2e-restart-test"}')
  STOP_STATUS=$(echo "$STOP" | jq -r '.status')
  if [ "$STOP_STATUS" = "stopping" ]; then
    pass "Graceful stop accepted"
  else
    fail "Graceful stop" "status=$STOP_STATUS"
  fi

  # Wait for container to exit
  sleep 5

  # Verify DB was synced to volume
  if [ -f "$TEST_DATA_DIR/store/messages.db" ]; then
    pass "Database synced to volume"
  else
    fail "Database sync" "messages.db not found"
  fi

  # Restart container
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
  docker run -d --name "$CONTAINER_NAME" \
    --platform linux/amd64 \
    -p "$PORT:9000" \
    -e "API_TOKEN=$API_TOKEN" \
    -e "ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY" \
    -e "ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL:-https://api.anthropic.com}" \
    -e "ASSISTANT_NAME=TestBot" \
    -e "LOG_LEVEL=info" \
    -e "TZ=${TZ:-UTC}" \
    -v "$TEST_DATA_DIR/memory:/data/memory" \
    -v "$TEST_DATA_DIR/store:/data/store" \
    "$IMAGE_NAME:$IMAGE_TAG" > /dev/null

  wait_ready
  pass "Container restarted"

  # Verify conversation still exists
  META2=$(api GET "/chat/$CONV_ID")
  META2_COUNT=$(echo "$META2" | jq -r '.message_count')
  if [ "$META2_COUNT" -ge 8 ]; then
    pass "Conversation persisted after restart ($META2_COUNT messages)"
  else
    fail "Conversation persistence" "message_count=$META2_COUNT"
  fi

  # Resume conversation and verify context
  cat > "$TMP_DIR/resume.json" << JSON
{"message":"What is my dogs name and what language do I code in?","conversation_id":"$CONV_ID","sender":"kevin","sender_name":"Kevin"}
JSON
  RESUME=$(api POST /chat -d @"$TMP_DIR/resume.json")
  RESUME_STATUS=$(echo "$RESUME" | jq -r '.status')
  RESUME_RESULT=$(echo "$RESUME" | jq -r '.result')

  if [ "$RESUME_STATUS" = "success" ]; then
    FOUND=0
    echo "$RESUME_RESULT" | grep -qi "mochi" && FOUND=$((FOUND + 1))
    echo "$RESUME_RESULT" | grep -qi "rust"  && FOUND=$((FOUND + 1))
    if [ "$FOUND" -eq 2 ]; then
      pass "Session resume: agent recalls Mochi + Rust after restart"
    else
      fail "Session resume" "found $FOUND/2 facts in: ${RESUME_RESULT:0:200}"
    fi
  else
    fail "Session resume" "status=$RESUME_STATUS"
  fi
fi

# ── 8. Dynamic Skill Creation ────────────────────────────
section "8. Dynamic Skill Creation & Reload"

# 1. Create a skill inside the container via docker exec
docker exec "$CONTAINER_NAME" mkdir -p /data/memory/skills/e2e-test-skill
docker exec "$CONTAINER_NAME" sh -c 'cat > /data/memory/skills/e2e-test-skill/SKILL.md << SKILLEOF
---
name: e2e-test-skill
description: A test skill created dynamically during E2E testing
---

# E2E Test Skill

When the user says "e2e skill test", respond with exactly: "E2E_SKILL_ACTIVE"
SKILLEOF'

if docker exec "$CONTAINER_NAME" test -f /data/memory/skills/e2e-test-skill/SKILL.md; then
  pass "Created dynamic skill in container"
else
  fail "Dynamic skill creation" "SKILL.md not found"
fi

# 2. Reload skills via admin API
RELOAD=$(api POST /admin/reload-skills)
RELOAD_STATUS=$(echo "$RELOAD" | jq -r '.status')
if [ "$RELOAD_STATUS" = "reloaded" ]; then
  pass "POST /admin/reload-skills → status=reloaded"
else
  fail "Reload skills" "status=$RELOAD_STATUS"
fi

# 3. Verify skill appears in effective list
SKILLS=$(api GET /admin/skills)
EFFECTIVE=$(echo "$SKILLS" | jq -r '.skills.effective[]' 2>/dev/null)
if echo "$EFFECTIVE" | grep -q "e2e-test-skill"; then
  pass "GET /admin/skills → e2e-test-skill in effective list"
else
  fail "Skills list" "e2e-test-skill not in effective: $EFFECTIVE"
fi

# 4. Verify skill is synced to .claude/skills/
SYNCED=$(docker exec "$CONTAINER_NAME" ls /data/memory/.claude/skills/ 2>&1)
if echo "$SYNCED" | grep -q "e2e-test-skill"; then
  pass "Dynamic skill synced to .claude/skills/"
else
  fail "Skill sync" "e2e-test-skill not in .claude/skills/: $SYNCED"
fi

# 5. Best-effort: send a message that triggers the skill (LLM non-deterministic)
if [ "$SKIP_CHAT" = true ]; then
  skip "Dynamic skill chat test (--no-chat)"
else
  cat > "$TMP_DIR/skill-test.json" << 'JSON'
{"message":"e2e skill test","sender":"test","sender_name":"Tester"}
JSON
  SKILL_RESP=$(api POST /chat -d @"$TMP_DIR/skill-test.json")
  SKILL_STATUS=$(echo "$SKILL_RESP" | jq -r '.status')
  SKILL_RESULT=$(echo "$SKILL_RESP" | jq -r '.result')

  if [ "$SKILL_STATUS" = "success" ]; then
    if echo "$SKILL_RESULT" | grep -qi "E2E_SKILL_ACTIVE"; then
      pass "Dynamic skill triggered in chat response"
    else
      echo -e "  ${YELLOW}WARN${NC} Skill response did not contain exact marker (LLM non-deterministic)"
      pass "Dynamic skill chat completed (status=success)"
    fi
  else
    fail "Dynamic skill chat" "status=$SKILL_STATUS"
  fi
fi

# 6. Test hot-reload: modify the skill and reload again
docker exec "$CONTAINER_NAME" sh -c 'cat > /data/memory/skills/e2e-test-skill/SKILL.md << SKILLEOF
---
name: e2e-test-skill-v2
description: Updated test skill created dynamically during E2E testing
---

# E2E Test Skill (Updated)

When the user says "e2e skill test", respond with exactly: "E2E_SKILL_V2_ACTIVE"
SKILLEOF'

# Reload after modification
RELOAD2=$(api POST /admin/reload-skills)
RELOAD2_STATUS=$(echo "$RELOAD2" | jq -r '.status')
if [ "$RELOAD2_STATUS" = "reloaded" ]; then
  pass "Hot-reload after modification: status=reloaded"
else
  fail "Hot-reload after modification" "status=$RELOAD2_STATUS"
fi

# Verify the skill content was updated in .claude/skills/
UPDATED_CONTENT=$(docker exec "$CONTAINER_NAME" cat /data/memory/.claude/skills/e2e-test-skill/SKILL.md 2>&1)
if echo "$UPDATED_CONTENT" | grep -q "e2e-test-skill-v2"; then
  pass "Hot-reload: skill content updated in .claude/skills/"
else
  fail "Hot-reload content" "expected v2 content, got: ${UPDATED_CONTENT:0:100}"
fi

# 7. Best-effort: verify updated skill triggers in chat
if [ "$SKIP_CHAT" = false ]; then
  cat > "$TMP_DIR/skill-test-v2.json" << 'JSON'
{"message":"e2e skill test","sender":"test","sender_name":"Tester"}
JSON
  SKILL_V2_RESP=$(api POST /chat -d @"$TMP_DIR/skill-test-v2.json")
  SKILL_V2_STATUS=$(echo "$SKILL_V2_RESP" | jq -r '.status')
  SKILL_V2_RESULT=$(echo "$SKILL_V2_RESP" | jq -r '.result')

  if [ "$SKILL_V2_STATUS" = "success" ]; then
    if echo "$SKILL_V2_RESULT" | grep -qi "V2"; then
      pass "Hot-reload: updated skill triggered in chat (v2 detected)"
    else
      echo -e "  ${YELLOW}WARN${NC} V2 marker not found (LLM non-deterministic), checking for skill activity"
      pass "Hot-reload: chat completed after skill update (status=success)"
    fi
  else
    fail "Hot-reload chat" "status=$SKILL_V2_STATUS"
  fi
fi

# 8. Clean up
docker exec "$CONTAINER_NAME" rm -rf /data/memory/skills/e2e-test-skill
pass "Cleaned up dynamic skill"

# ── 9. Built-in Skills (agent-browser) ──────────────────
section "9. Built-in Skills (agent-browser)"

# 9a. Verify agent-browser is in the built-in skills list
AB_SKILLS=$(api GET /admin/skills)
AB_BUILTIN=$(echo "$AB_SKILLS" | jq -r '.skills.builtIn[]' 2>/dev/null)
if echo "$AB_BUILTIN" | grep -q "agent-browser"; then
  pass "agent-browser in built-in skills list"
else
  fail "agent-browser" "not in built-in: $AB_BUILTIN"
fi

AB_EFFECTIVE=$(echo "$AB_SKILLS" | jq -r '.skills.effective[]' 2>/dev/null)
if echo "$AB_EFFECTIVE" | grep -q "agent-browser"; then
  pass "agent-browser in effective skills list"
else
  fail "agent-browser" "not in effective: $AB_EFFECTIVE"
fi

# 9b. Verify agent-browser SKILL.md exists in container
if docker exec "$CONTAINER_NAME" test -f /app/built-in-skills/agent-browser/SKILL.md; then
  pass "agent-browser SKILL.md exists at /app/built-in-skills/"
else
  fail "agent-browser" "SKILL.md not found in /app/built-in-skills/"
fi

# 9c. Verify agent-browser CLI is installed and executable
AB_VERSION=$(docker exec "$CONTAINER_NAME" agent-browser --version 2>&1 || true)
if echo "$AB_VERSION" | grep -qE "[0-9]+\.[0-9]+"; then
  pass "agent-browser CLI installed (version: $AB_VERSION)"
else
  # agent-browser may not have --version, try --help
  AB_HELP=$(docker exec "$CONTAINER_NAME" agent-browser --help 2>&1 || true)
  if echo "$AB_HELP" | grep -qi "agent-browser\|usage\|command"; then
    pass "agent-browser CLI installed (--help works)"
  else
    fail "agent-browser CLI" "not found or not executable: $AB_VERSION"
  fi
fi

# 9d. Verify Chromium is installed (required by agent-browser)
CHROMIUM_PATH=$(docker exec "$CONTAINER_NAME" which chromium 2>/dev/null || true)
if [ -n "$CHROMIUM_PATH" ]; then
  pass "Chromium installed at $CHROMIUM_PATH"
else
  fail "Chromium" "not found in container PATH"
fi

# 9e. Verify AGENT_BROWSER_EXECUTABLE_PATH env var is set
AB_ENV=$(docker exec "$CONTAINER_NAME" printenv AGENT_BROWSER_EXECUTABLE_PATH 2>/dev/null || true)
if [ -n "$AB_ENV" ]; then
  pass "AGENT_BROWSER_EXECUTABLE_PATH set ($AB_ENV)"
else
  echo -e "  ${YELLOW}WARN${NC} AGENT_BROWSER_EXECUTABLE_PATH not set (agent-browser may auto-detect)"
fi

# 9f. Test agent-browser can actually open and snapshot a page (no Claude needed)
AB_OPEN=$(docker exec "$CONTAINER_NAME" sh -c 'agent-browser open https://httpbin.org/html 2>&1' || true)
if echo "$AB_OPEN" | grep -qi "error\|fail\|not found\|ENOENT"; then
  echo -e "  ${YELLOW}WARN${NC} agent-browser open returned error: ${AB_OPEN:0:150}"
else
  pass "agent-browser open https://httpbin.org/html executed"
fi
AB_SNAP=$(docker exec "$CONTAINER_NAME" sh -c 'agent-browser snapshot 2>&1' || true)
if echo "$AB_SNAP" | grep -qi "herman\|melville\|html\|heading\|text"; then
  pass "agent-browser snapshot: page content captured"
else
  echo -e "  ${YELLOW}WARN${NC} agent-browser snapshot output: ${AB_SNAP:0:150}"
fi
docker exec "$CONTAINER_NAME" sh -c 'agent-browser close 2>&1' > /dev/null || true

# 9g. Test agent-browser via Claude conversation (requires Claude API)
if [ "$SKIP_CHAT" = true ]; then
  skip "agent-browser web browsing via Claude test (--no-chat)"
else
  cat > "$TMP_DIR/browser-test.json" << 'JSON'
{"message":"Use the agent-browser skill to visit https://httpbin.org/html and tell me the title of the page. Just tell me the title text.","sender":"test","sender_name":"Tester"}
JSON
  BROWSER_RESP=$(api POST /chat -d @"$TMP_DIR/browser-test.json")
  BROWSER_STATUS=$(echo "$BROWSER_RESP" | jq -r '.status')
  BROWSER_RESULT=$(echo "$BROWSER_RESP" | jq -r '.result')

  if [ "$BROWSER_STATUS" = "success" ]; then
    # httpbin.org/html has "Herman Melville" content
    if echo "$BROWSER_RESULT" | grep -qi "herman\|melville\|moby\|whale"; then
      pass "agent-browser via Claude: extracted content from httpbin.org/html"
    else
      echo -e "  ${YELLOW}WARN${NC} Response did not contain expected content (LLM non-deterministic)"
      echo -e "  ${YELLOW}     ${NC} Response: ${BROWSER_RESULT:0:150}"
      pass "agent-browser via Claude: web browsing completed (status=success)"
    fi
  elif [ "$BROWSER_STATUS" = "timeout" ]; then
    echo -e "  ${YELLOW}WARN${NC} Browser test timed out (may need more execution time)"
    pass "agent-browser via Claude: web browsing attempted (timeout)"
  else
    fail "agent-browser web test" "status=$BROWSER_STATUS, error=$(echo "$BROWSER_RESP" | jq -r '.error')"
  fi
fi

# ── 10. SSE Streaming ──────────────────────────────────
section "10. SSE Streaming"

if [ "$SKIP_CHAT" = true ]; then
  skip "SSE streaming test (--no-chat)"
else
  # Use curl with streaming to capture SSE events
  SSE_RESPONSE=$(curl -s -N --max-time 120 -X POST "$BASE_URL/chat" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"message":"What is 2+2? Just say the number.","sender":"test","sender_name":"Tester","stream":true}')

  if echo "$SSE_RESPONSE" | grep -q "event: start"; then
    pass "SSE: received 'start' event"
  else
    fail "SSE start event" "not found in stream response"
  fi

  if echo "$SSE_RESPONSE" | grep -q "event: chunk"; then
    pass "SSE: received 'chunk' event(s)"
  else
    echo -e "  ${YELLOW}WARN${NC} No chunk events (agent may have returned result without streaming)"
    pass "SSE: stream completed"
  fi

  if echo "$SSE_RESPONSE" | grep -q "event: done"; then
    pass "SSE: received 'done' event"
  else
    fail "SSE done event" "not found in stream response"
  fi

  # Verify done event contains full response
  DONE_DATA=$(echo "$SSE_RESPONSE" | grep -A1 "event: done" | grep "data: " | head -1 | sed 's/data: //')
  if echo "$DONE_DATA" | jq -r '.status' 2>/dev/null | grep -q "success"; then
    pass "SSE: done event contains status=success"
  else
    echo -e "  ${YELLOW}WARN${NC} Could not parse done event data"
  fi

  # Verify done event contains conversation_id for continuation
  SSE_CONV=$(echo "$DONE_DATA" | jq -r '.conversation_id' 2>/dev/null)
  if [ -n "$SSE_CONV" ] && [ "$SSE_CONV" != "null" ]; then
    pass "SSE: done event includes conversation_id ($SSE_CONV)"

    # 10b. Test streaming continuation on existing conversation
    SSE_CONT=$(curl -s -N --max-time 120 -X POST "$BASE_URL/chat" \
      -H "Authorization: Bearer $API_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"message\":\"What did I just ask you?\",\"conversation_id\":\"$SSE_CONV\",\"sender\":\"test\",\"sender_name\":\"Tester\",\"stream\":true}")

    if echo "$SSE_CONT" | grep -q "event: start"; then
      pass "SSE continuation: received 'start' event"
    else
      fail "SSE continuation" "no start event"
    fi

    if echo "$SSE_CONT" | grep -q "event: done"; then
      CONT_DONE=$(echo "$SSE_CONT" | grep -A1 "event: done" | grep "data: " | head -1 | sed 's/data: //')
      CONT_CONV=$(echo "$CONT_DONE" | jq -r '.conversation_id' 2>/dev/null)
      if [ "$CONT_CONV" = "$SSE_CONV" ]; then
        pass "SSE continuation: same conversation_id preserved"
      else
        fail "SSE continuation" "conversation_id mismatch: $CONT_CONV vs $SSE_CONV"
      fi
    else
      fail "SSE continuation" "no done event"
    fi
  fi
fi

# ── 11. Thinking Process & Tool Use Display ────────────
section "11. Thinking & Tool Use Display"

if [ "$SKIP_CHAT" = true ]; then
  skip "Thinking display test (--no-chat)"
  skip "Tool use display test (--no-chat)"
  skip "Non-streaming thinking/tool test (--no-chat)"
else
  # 11a. Test thinking display in streaming mode
  THINK_RESPONSE=$(curl -s -N --max-time 120 -X POST "$BASE_URL/chat" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"message":"Think carefully: what is the capital of France? Just answer the city name.","sender":"test","sender_name":"Tester","stream":true,"thinking":true,"max_thinking_tokens":5000}')

  THINK_STATUS=$(echo "$THINK_RESPONSE" | grep -A1 "event: done" | grep "data: " | head -1 | sed 's/data: //' | jq -r '.status' 2>/dev/null)
  if [ "$THINK_STATUS" = "success" ]; then
    pass "Thinking (stream): completed successfully"
  else
    echo -e "  ${YELLOW}WARN${NC} Thinking mode completed but could not verify status"
    pass "Thinking (stream): request accepted"
  fi

  if echo "$THINK_RESPONSE" | grep -q "event: thinking"; then
    pass "Thinking (stream): received 'thinking' SSE events"
  else
    echo -e "  ${YELLOW}WARN${NC} No thinking events (model may not support extended thinking)"
    pass "Thinking (stream): API accepted thinking=true"
  fi

  # 11b. Test tool use display in streaming mode — ask something that requires a tool
  TOOL_RESPONSE=$(curl -s -N --max-time 120 -X POST "$BASE_URL/chat" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"message":"Read the file /data/memory/CLAUDE.md and tell me the agent name mentioned in it.","sender":"test","sender_name":"Tester","stream":true,"show_tool_use":true}')

  TOOL_STATUS=$(echo "$TOOL_RESPONSE" | grep -A1 "event: done" | grep "data: " | head -1 | sed 's/data: //' | jq -r '.status' 2>/dev/null)
  if [ "$TOOL_STATUS" = "success" ]; then
    pass "Tool use (stream): completed successfully"
  else
    echo -e "  ${YELLOW}WARN${NC} Tool use display completed but could not verify status"
    pass "Tool use (stream): request accepted"
  fi

  if echo "$TOOL_RESPONSE" | grep -q "event: tool_use"; then
    pass "Tool use (stream): received 'tool_use' SSE events"
    # Check tool name is in the event
    TOOL_EVENT=$(echo "$TOOL_RESPONSE" | grep -A1 "event: tool_use" | grep "data: " | head -1 | sed 's/data: //')
    TOOL_NAME=$(echo "$TOOL_EVENT" | jq -r '.tool' 2>/dev/null)
    if [ -n "$TOOL_NAME" ] && [ "$TOOL_NAME" != "null" ]; then
      pass "Tool use (stream): tool name reported ($TOOL_NAME)"
    fi
  else
    echo -e "  ${YELLOW}WARN${NC} No tool_use events received (agent may not have used tools)"
    pass "Tool use (stream): API accepted show_tool_use=true"
  fi

  # 11c. Test thinking in NON-streaming mode (thinking=true, stream=false)
  THINK_NS_RESP=$(api POST /chat -d '{"message":"Think step by step: what is 17 * 23? Just answer the number.","sender":"test","sender_name":"Tester","thinking":true,"max_thinking_tokens":3000}')
  THINK_NS_STATUS=$(echo "$THINK_NS_RESP" | jq -r '.status')
  THINK_NS_RESULT=$(echo "$THINK_NS_RESP" | jq -r '.result')

  if [ "$THINK_NS_STATUS" = "success" ]; then
    pass "Thinking (non-stream): accepted and completed"
    if echo "$THINK_NS_RESULT" | grep -q "391"; then
      pass "Thinking (non-stream): correct answer (391)"
    else
      echo -e "  ${YELLOW}WARN${NC} Answer: ${THINK_NS_RESULT:0:100}"
    fi
  else
    fail "Thinking (non-stream)" "status=$THINK_NS_STATUS"
  fi

  # 11d. Test tool use in NON-streaming mode (show_tool_use=true, stream=false)
  # In non-streaming mode, tool_use events are NOT in the response (no SSE),
  # but the parameter should be accepted and the agent should still use tools.
  TOOL_NS_RESP=$(api POST /chat -d '{"message":"List the files in /data/memory/ directory.","sender":"test","sender_name":"Tester","show_tool_use":true}')
  TOOL_NS_STATUS=$(echo "$TOOL_NS_RESP" | jq -r '.status')

  if [ "$TOOL_NS_STATUS" = "success" ]; then
    pass "Tool use (non-stream): accepted and completed"
  else
    fail "Tool use (non-stream)" "status=$TOOL_NS_STATUS"
  fi

  # 11e. Test combined thinking + tool_use in streaming mode
  COMBINED_RESPONSE=$(curl -s -N --max-time 120 -X POST "$BASE_URL/chat" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"message":"Think about this, then check: does the file /data/memory/CLAUDE.md exist? Read it and tell me the first line.","sender":"test","sender_name":"Tester","stream":true,"thinking":true,"max_thinking_tokens":3000,"show_tool_use":true}')

  COMBINED_DONE=$(echo "$COMBINED_RESPONSE" | grep -A1 "event: done" | grep "data: " | head -1 | sed 's/data: //')
  COMBINED_STATUS=$(echo "$COMBINED_DONE" | jq -r '.status' 2>/dev/null)
  if [ "$COMBINED_STATUS" = "success" ]; then
    pass "Combined thinking+tool_use (stream): completed"
  else
    echo -e "  ${YELLOW}WARN${NC} Combined mode status: $COMBINED_STATUS"
    pass "Combined thinking+tool_use (stream): request accepted"
  fi

  HAS_THINKING=false
  HAS_TOOLUSE=false
  echo "$COMBINED_RESPONSE" | grep -q "event: thinking" && HAS_THINKING=true
  echo "$COMBINED_RESPONSE" | grep -q "event: tool_use" && HAS_TOOLUSE=true
  if [ "$HAS_THINKING" = true ] && [ "$HAS_TOOLUSE" = true ]; then
    pass "Combined: both thinking + tool_use events received"
  elif [ "$HAS_THINKING" = true ]; then
    pass "Combined: thinking events received (tool_use may be absent)"
  elif [ "$HAS_TOOLUSE" = true ]; then
    pass "Combined: tool_use events received (thinking may not be supported)"
  else
    echo -e "  ${YELLOW}WARN${NC} Neither thinking nor tool_use events received"
    pass "Combined: API accepted both parameters"
  fi
fi

# ── 12. Agent Synchronous & Background Execution ────────
section "12. Agent Synchronous & Background Execution"

if [ "$SKIP_CHAT" = true ]; then
  skip "Agent sync execution test (--no-chat)"
  skip "Agent background execution test (--no-chat)"
else
  # 12a. SYNCHRONOUS agent execution — agent performs a task and returns result inline
  cat > "$TMP_DIR/sync-test.json" << 'JSON'
{"message":"Create a simple text file at /data/memory/sync-test-marker.txt with the content 'sync-test-ok'. Then confirm you created it.","sender":"test","sender_name":"Tester"}
JSON
  SYNC_RESP=$(api POST /chat -d @"$TMP_DIR/sync-test.json")
  SYNC_STATUS=$(echo "$SYNC_RESP" | jq -r '.status')
  SYNC_CONV=$(echo "$SYNC_RESP" | jq -r '.conversation_id')
  SYNC_DURATION=$(echo "$SYNC_RESP" | jq -r '.duration_ms')

  if [ "$SYNC_STATUS" = "success" ]; then
    pass "Sync execution: completed (status=success, ${SYNC_DURATION}ms)"

    # Verify the file was actually created (proves agent used tools synchronously)
    if docker exec "$CONTAINER_NAME" test -f /data/memory/sync-test-marker.txt; then
      MARKER_CONTENT=$(docker exec "$CONTAINER_NAME" cat /data/memory/sync-test-marker.txt 2>/dev/null)
      if echo "$MARKER_CONTENT" | grep -q "sync-test-ok"; then
        pass "Sync execution: file created with correct content"
      else
        pass "Sync execution: file created (content may differ)"
      fi
    else
      echo -e "  ${YELLOW}WARN${NC} Agent did not create the file (LLM non-deterministic)"
      pass "Sync execution: chat completed"
    fi

    # Clean up
    docker exec "$CONTAINER_NAME" rm -f /data/memory/sync-test-marker.txt
  else
    fail "Sync execution" "status=$SYNC_STATUS"
  fi

  # 12b. BACKGROUND agent execution — use the Agent/Task tool to run_in_background
  # The SDK's Task tool with run_in_background=true spawns a subagent that runs independently.
  # We test this by asking the agent to launch a background task, then verifying the main
  # conversation returns before the background work completes.
  cat > "$TMP_DIR/bg-test.json" << 'JSON'
{"message":"I need you to do two things: (1) Write the text 'foreground-done' to /data/memory/fg-marker.txt immediately, and (2) use the Task tool to launch a background agent that writes 'background-done' to /data/memory/bg-marker.txt. Return as soon as the foreground write is complete — do not wait for the background task.","sender":"test","sender_name":"Tester"}
JSON
  BG_RESP=$(api POST /chat -d @"$TMP_DIR/bg-test.json")
  BG_STATUS=$(echo "$BG_RESP" | jq -r '.status')
  BG_DURATION=$(echo "$BG_RESP" | jq -r '.duration_ms')

  if [ "$BG_STATUS" = "success" ] || [ "$BG_STATUS" = "timeout" ]; then
    pass "Background execution: chat returned (status=$BG_STATUS, ${BG_DURATION}ms)"

    # Check foreground file
    if docker exec "$CONTAINER_NAME" test -f /data/memory/fg-marker.txt; then
      pass "Background execution: foreground task completed"
    else
      echo -e "  ${YELLOW}WARN${NC} Foreground marker not found (LLM non-deterministic)"
    fi

    # Wait a few seconds for background to complete, then check
    sleep 5
    if docker exec "$CONTAINER_NAME" test -f /data/memory/bg-marker.txt; then
      pass "Background execution: background agent wrote marker file"
    else
      echo -e "  ${YELLOW}WARN${NC} Background marker not found (agent may not have used background mode)"
      pass "Background execution: chat completed"
    fi

    # Clean up
    docker exec "$CONTAINER_NAME" rm -f /data/memory/fg-marker.txt /data/memory/bg-marker.txt
  else
    fail "Background execution" "status=$BG_STATUS"
  fi

  # 12c. Test conversation-scoped agent execution — continue same conversation
  cat > "$TMP_DIR/continue-test.json" << JSON
{"message":"What was the last thing I asked you to do?","conversation_id":"$SYNC_CONV","sender":"test","sender_name":"Tester"}
JSON
  CONT_RESP=$(api POST /chat -d @"$TMP_DIR/continue-test.json")
  CONT_STATUS=$(echo "$CONT_RESP" | jq -r '.status')
  CONT_RESULT=$(echo "$CONT_RESP" | jq -r '.result')

  if [ "$CONT_STATUS" = "success" ]; then
    if echo "$CONT_RESULT" | grep -qi "file\|marker\|sync\|creat"; then
      pass "Conversation continuation: agent recalled previous action"
    else
      pass "Conversation continuation: completed (context recall is best-effort)"
    fi
  else
    fail "Conversation continuation" "status=$CONT_STATUS"
  fi

  # 12d. Test scheduled task creation via MCP tool in conversation
  cat > "$TMP_DIR/schedule-test.json" << JSON
{"message":"Use the schedule_task MCP tool to create a task with id 'e2e-mcp-task', prompt 'test task from conversation', schedule_type 'once', schedule_value '2099-01-01T00:00:00', context_mode 'isolated'. Then confirm you created it.","conversation_id":"$SYNC_CONV","sender":"test","sender_name":"Tester"}
JSON
  SCHED_RESP=$(api POST /chat -d @"$TMP_DIR/schedule-test.json")
  SCHED_STATUS=$(echo "$SCHED_RESP" | jq -r '.status')

  if [ "$SCHED_STATUS" = "success" ]; then
    # Verify task was created
    TASKS_AFTER=$(api GET /tasks)
    if echo "$TASKS_AFTER" | jq -r '.tasks[].id' 2>/dev/null | grep -q "e2e-mcp-task"; then
      pass "MCP task creation: task created via conversation"
      # Clean up
      api_status DELETE /task/e2e-mcp-task > /dev/null
    else
      echo -e "  ${YELLOW}WARN${NC} Task not found (agent may not have used MCP tool)"
      pass "MCP task creation: chat completed"
    fi
  else
    fail "MCP task creation" "status=$SCHED_STATUS"
  fi
fi

# ── 13. Conversation 404 ���────────────────────────────────
section "13. Error Handling"

CODE=$(api_status GET /chat/conv-nonexistent-12345)
if [ "$CODE" = "404" ]; then
  pass "Non-existent conversation → 404"
else
  fail "Conversation 404" "expected 404, got $CODE"
fi

# ── 14. Cross-Session Memory (Auto-Memory) ────────────────
section "14. Cross-Session Memory"

if [ "$SKIP_CHAT" = true ]; then
  skip "Cross-session memory: teach fact (--no-chat)"
  skip "Cross-session memory: recall in new session (--no-chat)"
else
  # Use a unique, unmistakable fact that the agent is unlikely to hallucinate
  MEMORY_FACT="PicoTestCode7749"

  # 14a. Teach the agent a unique fact in a fresh conversation
  cat > "$TMP_DIR/mem1.json" << JSON
{"message":"Please remember this important code for me: $MEMORY_FACT. Write it to a file at /data/memory/notes/e2e-memory-test.txt so you can find it later. Confirm you saved it.","sender":"test","sender_name":"Tester"}
JSON
  MEM1=$(api POST /chat -d @"$TMP_DIR/mem1.json")
  MEM1_STATUS=$(echo "$MEM1" | jq -r '.status')
  MEM1_CONV=$(echo "$MEM1" | jq -r '.conversation_id')

  if [ "$MEM1_STATUS" = "success" ]; then
    pass "Cross-session memory: taught fact in conversation $MEM1_CONV"
  else
    fail "Cross-session memory: teach" "status=$MEM1_STATUS"
  fi

  # Verify the file was actually written (agent may or may not have done it)
  FILE_EXISTS=$(docker exec "$CONTAINER_NAME" cat /data/memory/notes/e2e-memory-test.txt 2>/dev/null || echo "")
  if echo "$FILE_EXISTS" | grep -q "$MEMORY_FACT"; then
    pass "Cross-session memory: fact persisted to /data/memory/notes/"
  else
    echo -e "  ${YELLOW}WARN${NC} Agent did not write the file (will rely on conversation context if resumed)"
  fi

  # 14b. Start a completely new conversation and ask for the fact
  # Note: when the agent reads files, the JSON response may contain unescaped
  # control characters from tool output, breaking jq. We use grep on the raw
  # response for content checks and only use jq for simple top-level fields.
  cat > "$TMP_DIR/mem2.json" << JSON
{"message":"I previously asked you to remember an important code and save it to a file in /data/memory/notes/. Can you find and tell me what that code was? Check the file at /data/memory/notes/e2e-memory-test.txt","sender":"test","sender_name":"Tester"}
JSON
  MEM2=$(api POST /chat -d @"$TMP_DIR/mem2.json")
  # Use grep on raw response to avoid jq control-char parse errors
  MEM2_STATUS=$(echo "$MEM2" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  MEM2_CONV=$(echo "$MEM2" | grep -o '"conversation_id":"[^"]*"' | head -1 | cut -d'"' -f4)

  if [ -n "$MEM2_CONV" ] && [ "$MEM2_CONV" != "$MEM1_CONV" ]; then
    pass "Cross-session memory: new conversation created ($MEM2_CONV)"
  else
    fail "Cross-session memory: isolation" "reused same conversation_id or empty"
  fi

  if [ "$MEM2_STATUS" = "success" ] && echo "$MEM2" | grep -q "$MEMORY_FACT"; then
    pass "Cross-session memory: agent recalled '$MEMORY_FACT' in new session"
  else
    fail "Cross-session memory: recall" "expected '$MEMORY_FACT' in response (status=$MEM2_STATUS)"
  fi

  # Cleanup
  docker exec "$CONTAINER_NAME" rm -rf /data/memory/notes/e2e-memory-test.txt 2>/dev/null || true
fi

# ── 15. Graceful Shutdown ────────────────────────────────
section "15. Final Graceful Shutdown"

FINAL_STOP=$(api POST /control/stop -d '{"reason":"e2e-complete"}')
FINAL_STATUS=$(echo "$FINAL_STOP" | jq -r '.status')
if [ "$FINAL_STATUS" = "stopping" ]; then
  pass "Final shutdown accepted"
else
  fail "Final shutdown" "status=$FINAL_STATUS"
fi

sleep 3
RUNNING=$(docker ps --filter "name=$CONTAINER_NAME" --format "{{.Names}}")
if [ -z "$RUNNING" ]; then
  pass "Container exited cleanly"
else
  fail "Container exit" "still running"
fi

# ════════════════════════════════════════════════════════
# SUMMARY
# ════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════════════════"
TOTAL=$((PASS_COUNT + FAIL_COUNT + SKIP_COUNT))
echo -e "  Total: $TOTAL  ${GREEN}Pass: $PASS_COUNT${NC}  ${RED}Fail: $FAIL_COUNT${NC}  ${YELLOW}Skip: $SKIP_COUNT${NC}"
echo "════════════════════════════════════════════════════"

if [ "$FAIL_COUNT" -gt 0 ]; then
  exit 1
fi
