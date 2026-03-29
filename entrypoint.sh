#!/bin/bash
set -euo pipefail

# Enable V8 compile cache — caches bytecode for cli.js (11.5 MB) and other
# large JS files, reducing per-request CLI subprocess parse time by ~200-400ms.
# Node.js 22+ feature; harmless no-op on older versions.
export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE:-/tmp/node-compile-cache}"
mkdir -p "${NODE_COMPILE_CACHE}"

MEMORY_DIR="${MEMORY_DIR:-/data/memory}"
CLAUDE_HOME="/home/node/.claude"
SESSION_CLAUDE_DIR="${MEMORY_DIR}/.claude"
SETTINGS_FILE="${CLAUDE_HOME}/settings.json"

mkdir -p "${MEMORY_DIR}" /data/store

# Ensure persistent .claude directory exists and symlink home to it.
# This must be unconditional so empty mounted volumes get the needed
# structure on first boot.
mkdir -p "${SESSION_CLAUDE_DIR}"
rm -rf "${CLAUDE_HOME}"
ln -sf "${SESSION_CLAUDE_DIR}" "${CLAUDE_HOME}"
if [ ! -f "${SETTINGS_FILE}" ]; then
  cat > "${SETTINGS_FILE}" << 'JSON'
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",
    "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"
  }
}
JSON
fi

# ── Org directory setup ──────────────────────────────────────────
# NOTE: managed-mcp.json is loaded programmatically by src/managed-mcp.ts
# and merged into query() mcpServers, NOT via CLI auto-discovery from
# /etc/claude-code/. CLI auto-discovery triggers an enterprise MCP config
# exclusion that prevents --mcp-config usage, breaking the built-in
# picoclaw MCP server and per-request dynamic servers.
ORG_DIR="${ORG_DIR:-}"

# ── Three-tier skill sync ────────────────────────────────────────
# Load order: built-in → org (authoritative) → user (additive only)
SKILLS_DST="${CLAUDE_HOME}/skills"
BUILTIN_SRC="${BUILT_IN_SKILLS_DIR:-/app/built-in-skills}"
USER_SKILLS_SRC="${MEMORY_DIR}/skills"

# Resolve org skills source path (needed before persist step).
if [ -n "${ORG_DIR}" ] && [ -d "${ORG_DIR}/skills" ]; then
  ORG_SKILLS_SRC="${ORG_DIR}/skills"
elif [ -n "${SKILLS_DIR:-}" ] && [ -d "${SKILLS_DIR:-}" ]; then
  ORG_SKILLS_SRC="${SKILLS_DIR}"
elif [ -d "/data/skills" ]; then
  ORG_SKILLS_SRC="/data/skills"
else
  ORG_SKILLS_SRC=""
fi

mkdir -p "${SKILLS_DST}" "${USER_SKILLS_SRC}"

# Persist runtime-created skills before clearing the destination.
# Skills created during chat (e.g. via Claude Code) are written to
# .claude/skills/ inside MEMORY_DIR and would be lost on restart
# because the sync clears the destination first.  Copy any skill whose
# name does NOT exist in a managed source back to the persistent user
# skills directory so it survives the next sync.
for skill_dir in "${SKILLS_DST}"/*/; do
  [ -d "${skill_dir}" ] || continue
  skill_name="$(basename "${skill_dir}")"
  # Skip skills from managed sources.
  [ -d "${BUILTIN_SRC}/${skill_name}" ] && continue
  [ -n "${ORG_SKILLS_SRC}" ] && [ -d "${ORG_SKILLS_SRC}/${skill_name}" ] && continue
  [ -d "${USER_SKILLS_SRC}/${skill_name}" ] && continue
  # Runtime-created — persist to user skills directory.
  cp -r "${skill_dir}" "${USER_SKILLS_SRC}/${skill_name}"
done

find "${SKILLS_DST}" -mindepth 1 -maxdepth 1 -type d -exec rm -rf {} +

# 1. Built-in skills (bundled in image)
if [ -d "${BUILTIN_SRC}" ]; then
  for dir in "${BUILTIN_SRC}"/*; do
    if [ -d "${dir}" ]; then
      cp -r "${dir}" "${SKILLS_DST}/$(basename "${dir}")"
    fi
  done
fi

# 2. Org skills (authoritative — overrides built-in)
if [ -n "${ORG_SKILLS_SRC}" ]; then
  for dir in "${ORG_SKILLS_SRC}"/*; do
    if [ -d "${dir}" ]; then
      cp -r "${dir}" "${SKILLS_DST}/$(basename "${dir}")"
    fi
  done
fi

# 3. User skills (additive only — skip skills that already exist)
if [ -d "${USER_SKILLS_SRC}" ]; then
  for dir in "${USER_SKILLS_SRC}"/*; do
    if [ -d "${dir}" ]; then
      skill_name="$(basename "${dir}")"
      if [ ! -d "${SKILLS_DST}/${skill_name}" ]; then
        cp -r "${dir}" "${SKILLS_DST}/${skill_name}"
      fi
    fi
  done
fi

# ── Auto-memory symlink ─────────────────────────────────────────
# Link Claude Code auto-memory directory to the actual memory volume.
# The SDK writes auto-memory to $HOME/.claude/projects/<cwd-slug>/memory/
# but the agent's cwd is /data/memory. Without this link, auto-memory
# writes go to an isolated directory that the agent never sees.
# NOTE: As of SDK 0.2.34, auto-memory is gated behind an internal feature
# flag (tengu_herring_clock, default false) and is non-functional in
# SDK/non-interactive mode. This symlink is a forward-compatibility measure.
PROJECT_SLUG=$(echo "${MEMORY_DIR}" | sed 's|/|-|g')
AUTO_MEMORY_DIR="${CLAUDE_HOME}/projects/${PROJECT_SLUG}/memory"

# Skip symlink when AUTO_MEMORY_DIR is inside MEMORY_DIR (merged mode → circular).
case "${AUTO_MEMORY_DIR}" in
  "${MEMORY_DIR}"/*)
    ;;  # Skip — would be circular
  *)
    if [ -d "${AUTO_MEMORY_DIR}" ] && [ ! -L "${AUTO_MEMORY_DIR}" ]; then
      # Move any existing auto-memory content to the real volume
      if [ -f "${AUTO_MEMORY_DIR}/MEMORY.md" ]; then
        cp -n "${AUTO_MEMORY_DIR}/MEMORY.md" "${MEMORY_DIR}/MEMORY.md" 2>/dev/null || true
      fi
      rm -rf "${AUTO_MEMORY_DIR}"
    fi
    mkdir -p "$(dirname "${AUTO_MEMORY_DIR}")"
    ln -sf "${MEMORY_DIR}" "${AUTO_MEMORY_DIR}"
    ;;
esac

exec node /app/dist/index.js "$@"
