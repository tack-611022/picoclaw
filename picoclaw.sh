#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

ENV_FILE="$ROOT_DIR/.env"
IMAGE_NAME="picoclaw:latest"
CONTAINER_NAME="picoclaw-dev"
API_PORT="${PORT:-9000}"

usage() {
  cat <<'USAGE'
Usage:
  ./picoclaw.sh            # one-click: prepare env -> build -> run -> smoke test
  ./picoclaw.sh up         # prepare env -> build -> run
  ./picoclaw.sh test       # smoke test current running service
  ./picoclaw.sh stop-api   # request graceful stop via /control/stop
  ./picoclaw.sh down       # stop container
  ./picoclaw.sh logs       # tail logs
USAGE
}

read_env() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return 0
  fi
  awk -F= -v k="$key" '$1==k {sub(/^[^=]*=/, "", $0); print $0; exit}' "$ENV_FILE"
}

upsert_env() {
  local key="$1"
  local value="$2"
  python3 - "$ENV_FILE" "$key" "$value" <<'PY'
from pathlib import Path
import sys

env_path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
line = f"{key}={value}"

if not env_path.exists():
    env_path.write_text(line + "\n", encoding="utf-8")
    raise SystemExit(0)

lines = env_path.read_text(encoding="utf-8").splitlines()
replaced = False
for idx, raw in enumerate(lines):
    if raw.startswith(f"{key}="):
        lines[idx] = line
        replaced = True
        break

if not replaced:
    lines.append(line)

env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

generate_token() {
  if command -v openssl >/dev/null 2>&1; then
    echo "picoclaw-$(openssl rand -hex 8)"
    return
  fi

  python3 - <<'PY'
import secrets
print("picoclaw-" + secrets.token_hex(8))
PY
}

prepare_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    cp .env.example "$ENV_FILE"
    echo "[info] created .env from .env.example"
  fi

  local base_url="${ANTHROPIC_BASE_URL:-$(read_env ANTHROPIC_BASE_URL)}"
  if [[ -z "$base_url" || "$base_url" == "https://api.anthropic.com" ]]; then
    echo "[info] ANTHROPIC_BASE_URL not set. Press Enter to use default (https://api.anthropic.com),"
    read -r -p "       or enter a custom URL (e.g. https://your-proxy.com/anthropic): " base_url
    base_url="${base_url:-https://api.anthropic.com}"
  fi
  upsert_env "ANTHROPIC_BASE_URL" "$base_url"

  local api_key="${ANTHROPIC_API_KEY:-$(read_env ANTHROPIC_API_KEY)}"
  if [[ -z "$api_key" || "$api_key" == "sk-ant-xxxx" ]]; then
    read -r -s -p "Input ANTHROPIC_API_KEY: " api_key
    echo
  fi

  if [[ -z "$api_key" ]]; then
    echo "[error] ANTHROPIC_API_KEY is required"
    exit 1
  fi

  upsert_env "ANTHROPIC_API_KEY" "$api_key"

  local api_token="${API_TOKEN:-$(read_env API_TOKEN)}"
  if [[ -z "$api_token" || "$api_token" == "dev-token-123" ]]; then
    api_token="$(generate_token)"
  fi
  upsert_env "API_TOKEN" "$api_token"

  local assistant_name="${ASSISTANT_NAME:-$(read_env ASSISTANT_NAME)}"
  assistant_name="${assistant_name:-Pico}"
  upsert_env "ASSISTANT_NAME" "$assistant_name"

  local timeout_ms="${MAX_EXECUTION_MS:-$(read_env MAX_EXECUTION_MS)}"
  timeout_ms="${timeout_ms:-300000}"
  upsert_env "MAX_EXECUTION_MS" "$timeout_ms"

  local timezone="${TZ:-$(read_env TZ)}"
  timezone="${timezone:-Asia/Shanghai}"
  upsert_env "TZ" "$timezone"

  local log_level="${LOG_LEVEL:-$(read_env LOG_LEVEL)}"
  log_level="${log_level:-info}"
  upsert_env "LOG_LEVEL" "$log_level"

  echo "[info] .env prepared"
}

ensure_data_dirs() {
  mkdir -p dev-data/memory/.claude/skills dev-data/memory/conversations
  mkdir -p dev-data/store

  if [[ ! -f dev-data/memory/CLAUDE.md ]]; then
    cat > dev-data/memory/CLAUDE.md <<'MD'
# PicoClaw Memory

You are a helpful assistant.
MD
  fi
}

build_image() {
  local build_version build_commit build_time
  build_version="$(node -p "require('./package.json').version" 2>/dev/null || echo unknown)"
  build_commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  build_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  echo "[step] building Docker image: $IMAGE_NAME (v${build_version} @ ${build_commit})"
  docker build --platform linux/amd64 \
    --build-arg BUILD_VERSION="$build_version" \
    --build-arg BUILD_COMMIT="$build_commit" \
    --build-arg BUILD_TIME="$build_time" \
    -t "$IMAGE_NAME" .
}

wait_ready() {
  echo "[step] waiting for /health"
  for _ in $(seq 1 45); do
    if curl -sf "http://localhost:${API_PORT}/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "[error] service did not become ready"
  docker logs "$CONTAINER_NAME" || true
  exit 1
}

start_container() {
  ensure_data_dirs
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

  echo "[step] starting container: $CONTAINER_NAME"
  docker run -d --rm \
    --name "$CONTAINER_NAME" \
    -p "${API_PORT}:9000" \
    --env-file "$ENV_FILE" \
    -v "$ROOT_DIR/dev-data/memory:/data/memory" \
    -v "$ROOT_DIR/dev-data/store:/data/store" \
    "$IMAGE_NAME" >/dev/null

  wait_ready
}

smoke_test() {
  local api_token
  api_token="$(read_env API_TOKEN)"
  if [[ -z "$api_token" ]]; then
    echo "[error] API_TOKEN not found in .env"
    exit 1
  fi

  echo "[step] health check"
  curl -sS "http://localhost:${API_PORT}/health"
  echo

  echo "[step] chat smoke test"
  local resp
  resp="$(curl -sS -X POST "http://localhost:${API_PORT}/chat" \
    -H "Authorization: Bearer ${api_token}" \
    -H "Content-Type: application/json" \
    -d '{"message":"请回复：PicoClaw ready","sender":"quickstart","sender_name":"Quickstart"}')"

  if command -v jq >/dev/null 2>&1; then
    echo "$resp" | jq .
    local status
    status="$(echo "$resp" | jq -r '.status // empty')"
    if [[ "$status" != "success" && "$status" != "timeout" ]]; then
      echo "[error] chat smoke test failed"
      exit 1
    fi
  else
    echo "$resp"
    if [[ "$resp" == *'"status":"error"'* ]]; then
      echo "[error] chat smoke test failed"
      exit 1
    fi
  fi

  echo "[done] PicoClaw is ready at http://localhost:${API_PORT}"
}

stop_container() {
  docker stop "$CONTAINER_NAME" >/dev/null 2>&1 || true
  echo "[done] container stopped"
}

api_stop() {
  local api_token
  api_token="$(read_env API_TOKEN)"
  if [[ -z "$api_token" ]]; then
    echo "[error] API_TOKEN not found in .env"
    exit 1
  fi

  curl -sS -X POST "http://localhost:${API_PORT}/control/stop" \
    -H "Authorization: Bearer ${api_token}" \
    -H "Content-Type: application/json" \
    -d '{"reason":"manual-stop-api"}'
  echo
}

show_logs() {
  docker logs -f "$CONTAINER_NAME"
}

command="${1:-all}"
case "$command" in
  all)
    prepare_env
    build_image
    start_container
    smoke_test
    ;;
  up)
    prepare_env
    build_image
    start_container
    echo "[done] PicoClaw is running"
    ;;
  test)
    smoke_test
    ;;
  stop-api)
    api_stop
    ;;
  down)
    stop_container
    ;;
  logs)
    show_logs
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    usage
    echo "[error] unknown command: $command"
    exit 1
    ;;
esac
