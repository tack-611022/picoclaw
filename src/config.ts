import path from 'path';

const parseIntWithDefault = (
  value: string | undefined,
  fallback: number,
): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL || '';

export const APP_VERSION = process.env.APP_VERSION || '1.0.0';
export const BUILD_COMMIT = process.env.BUILD_COMMIT || 'unknown';
export const BUILD_TIME = process.env.BUILD_TIME || 'unknown';
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Pico';
export const API_TOKEN = process.env.API_TOKEN || '';

export const PORT = parseIntWithDefault(process.env.PORT, 9000);
export const MAX_EXECUTION_MS = parseIntWithDefault(
  process.env.MAX_EXECUTION_MS,
  300_000,
);
export const SESSION_END_MARKER =
  process.env.SESSION_END_MARKER || '[[PICOCLAW_SESSION_END]]';

export const STORE_DIR = process.env.STORE_DIR || '/data/store';
export const MEMORY_DIR = process.env.MEMORY_DIR || '/data/memory';

/**
 * Organization directory — a single read-only mount containing
 * CLAUDE.md (org persona), managed-mcp.json, and skills/.
 * When set, SKILLS_DIR defaults to $ORG_DIR/skills.
 */
export const ORG_DIR = process.env.ORG_DIR || '';

/**
 * Org-level skills directory.
 * Explicit SKILLS_DIR env var takes precedence; otherwise derived from ORG_DIR.
 * Falls back to /data/skills for backward compatibility.
 */
export const SKILLS_DIR =
  process.env.SKILLS_DIR ||
  (ORG_DIR ? path.join(ORG_DIR, 'skills') : '/data/skills');

export const BUILT_IN_SKILLS_DIR =
  process.env.BUILT_IN_SKILLS_DIR || '/app/built-in-skills';

export const LOCAL_DB_PATH = process.env.LOCAL_DB_PATH || '/tmp/messages.db';

export const OUTBOUND_TTL_DAYS = parseIntWithDefault(
  process.env.OUTBOUND_TTL_DAYS,
  7,
);
export const TASK_LOG_RETENTION = parseIntWithDefault(
  process.env.TASK_LOG_RETENTION,
  100,
);

export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || undefined;
export const CLAUDE_FALLBACK_MODEL =
  process.env.CLAUDE_FALLBACK_MODEL || undefined;

export const SYSTEM_PROMPT_OVERRIDE = process.env.SYSTEM_PROMPT_OVERRIDE || '';

export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Controls Claude Agent SDK stderr output.
 * 'off' (default) — SDK stderr is not captured.
 * 'debug' — SDK stderr is piped through pino at debug level.
 */
export const SDK_LOG_LEVEL = process.env.SDK_LOG_LEVEL || 'off';
