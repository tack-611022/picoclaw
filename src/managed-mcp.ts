import fs from 'fs';
import path from 'path';

import { McpServerConfig, McpServerContext } from './agent-engine.js';
import { ORG_DIR } from './config.js';
import { logger } from './logger.js';

let cachedServers: Record<string, McpServerConfig> = {};

export interface McpServerValidationResult {
  config: McpServerConfig | null;
  /** Present when config is null — describes why validation failed. */
  reason?: string;
}

/**
 * Validate a single MCP server config entry.
 * Returns `{ config }` on success, `{ config: null, reason }` on failure.
 * Shared by managed-mcp loading and per-request validation.
 */
export function validateSingleMcpServer(
  config: unknown,
): McpServerValidationResult {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return {
      config: null,
      reason: `expected an object, got ${config === null ? 'null' : Array.isArray(config) ? 'array' : typeof config}`,
    };
  }

  const cfg = config as Record<string, unknown>;
  const type = (cfg.type as string) || 'http';

  if (type === 'http' || type === 'sse') {
    if (typeof cfg.url !== 'string' || !cfg.url) {
      return {
        config: null,
        reason: `${type} server requires a non-empty 'url' string`,
      };
    }
    const entry: {
      type: 'http' | 'sse';
      url: string;
      headers?: Record<string, string>;
    } = { type, url: cfg.url };
    if (
      cfg.headers &&
      typeof cfg.headers === 'object' &&
      !Array.isArray(cfg.headers)
    ) {
      entry.headers = cfg.headers as Record<string, string>;
    }
    return { config: entry };
  }

  if (type === 'stdio') {
    if (typeof cfg.command !== 'string' || !cfg.command) {
      return {
        config: null,
        reason: `stdio server requires a non-empty 'command' string`,
      };
    }
    const entry: {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    } = { type: 'stdio', command: cfg.command };
    if (Array.isArray(cfg.args)) {
      entry.args = cfg.args as string[];
    }
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      entry.env = cfg.env as Record<string, string>;
    }
    return { config: entry };
  }

  return {
    config: null,
    reason: `unsupported transport type '${type}' (expected http, sse, or stdio)`,
  };
}

export type McpContextValidationResult =
  | { valid: true; context: McpServerContext }
  | { valid: false; reason: string };

/**
 * Validate a single mcp_context entry (one server's overlay).
 * Returns `{ valid: true, context }` on success, `{ valid: false, reason }` on failure.
 * Shared by per-request validation in chat routes.
 */
export function validateSingleMcpContext(
  raw: unknown,
): McpContextValidationResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      valid: false,
      reason: `expected an object, got ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw}`,
    };
  }

  const cfg = raw as Record<string, unknown>;
  const result: McpServerContext = {};
  let hasFields = false;

  if (cfg.headers !== undefined) {
    if (
      typeof cfg.headers !== 'object' ||
      cfg.headers === null ||
      Array.isArray(cfg.headers)
    ) {
      return {
        valid: false,
        reason: 'headers must be an object with string values',
      };
    }
    result.headers = cfg.headers as Record<string, string>;
    hasFields = true;
  }

  if (cfg.env !== undefined) {
    if (
      typeof cfg.env !== 'object' ||
      cfg.env === null ||
      Array.isArray(cfg.env)
    ) {
      return {
        valid: false,
        reason: 'env must be an object with string values',
      };
    }
    result.env = cfg.env as Record<string, string>;
    hasFields = true;
  }

  if (cfg.args !== undefined) {
    if (!Array.isArray(cfg.args)) {
      return { valid: false, reason: 'args must be an array of strings' };
    }
    result.args = cfg.args as string[];
    hasFields = true;
  }

  if (!hasFields) {
    return {
      valid: false,
      reason: 'context must have at least one of: headers, env, args',
    };
  }

  return { valid: true, context: result };
}

/**
 * Read and cache MCP server configs from $ORG_DIR/managed-mcp.json.
 * Call once at startup. Uses the same format as Claude Code managed-mcp.json:
 * { "mcpServers": { "name": { "type": "http", "url": "..." } } }
 */
export function loadManagedMcpServers(): Record<string, McpServerConfig> {
  cachedServers = {};
  if (!ORG_DIR) {
    return cachedServers;
  }

  const filePath = path.join(ORG_DIR, 'managed-mcp.json');
  if (!fs.existsSync(filePath)) {
    return cachedServers;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (raw?.mcpServers && typeof raw.mcpServers === 'object') {
      for (const [name, config] of Object.entries(raw.mcpServers)) {
        if (name === 'picoclaw') {
          logger.warn(
            { server: name },
            'managed-mcp.json: "picoclaw" is a reserved name and was skipped — the built-in picoclaw server cannot be overridden',
          );
          continue;
        }
        const { config: validated, reason } = validateSingleMcpServer(config);
        if (validated) {
          cachedServers[name] = validated;
        } else {
          logger.warn(
            { server: name, reason },
            `managed-mcp.json: skipped invalid server '${name}' — ${reason}`,
          );
        }
      }
    }
  } catch {
    logger.warn('Failed to parse managed-mcp.json');
  }

  return cachedServers;
}

/** Return cached managed MCP server configs (full config objects). */
export function getManagedMcpServers(): Record<string, McpServerConfig> {
  return cachedServers;
}

/** Return cached managed MCP server names. */
export function getManagedMcpNames(): string[] {
  return Object.keys(cachedServers);
}
