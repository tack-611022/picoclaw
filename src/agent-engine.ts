import fs from 'fs';
import path from 'path';

import {
  HookCallback,
  PreCompactHookInput,
  PreToolUseHookInput,
  query,
} from '@anthropic-ai/claude-agent-sdk';
import type { McpServerConfig as SdkMcpServerConfig } from '@anthropic-ai/claude-agent-sdk';

import {
  ASSISTANT_NAME,
  CLAUDE_FALLBACK_MODEL,
  CLAUDE_MODEL,
  LOCAL_DB_PATH,
  MAX_EXECUTION_MS,
  MEMORY_DIR,
  ORG_DIR,
  SDK_LOG_LEVEL,
  SKILLS_DIR,
  SYSTEM_PROMPT_OVERRIDE,
} from './config.js';
import { logger } from './logger.js';
import { getManagedMcpServers } from './managed-mcp.js';
import { createPicoClawMcpServer } from './mcp-inprocess.js';
import { createPerfTrace } from './perf.js';
import { AgentUsage } from './types.js';

/**
 * MCP server configuration for stdio, SSE, or HTTP transports.
 * This type covers configs accepted via the public HTTP API (POST /chat mcp_servers).
 * Internally, PicoClaw also uses `type: 'sdk'` for the built-in picoclaw server
 * (via SdkMcpServerConfig from the SDK), but that is not exposed to callers.
 */
export type McpServerConfig =
  | {
      type?: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> };

/**
 * Per-request context overlay for an MCP server.
 * Applied after the three-way merge to inject dynamic auth headers or env vars.
 */
export interface McpServerContext {
  /** HTTP/SSE headers — merged into server config (context overrides static). */
  headers?: Record<string, string>;
  /** stdio env vars — merged into server config (context overrides static). */
  env?: Record<string, string>;
  /** stdio args — appended to existing args array. */
  args?: string[];
}

export interface AgentRunInput {
  prompt: string;
  conversationId: string;
  sessionId?: string;
  resumeAt?: string;
  timeoutMs?: number;
  assistantName?: string;
  isScheduledTask?: boolean;
  maxThinkingTokens?: number;
  showToolUse?: boolean;
  /** Per-request model override (full ID or short name). */
  model?: string;
  /** Per-request MCP servers merged with the built-in picoclaw server. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Per-request auth/env context overlaid onto MCP server configs. */
  mcpContext?: Record<string, McpServerContext>;
}

export interface AgentRunOutput {
  status: 'success' | 'timeout' | 'error';
  result: string | null;
  newSessionId?: string;
  lastAssistantUuid?: string;
  model?: string;
  error?: string;
  usage?: AgentUsage;
  /** Warnings from MCP context merge (server not found, type mismatches). */
  contextWarnings?: string[];
}

export interface StreamCallbacks {
  onChunk?: (text: string) => Promise<void> | void;
  onThinking?: (text: string) => Promise<void> | void;
  onToolUse?: (tool: string, input: unknown) => Promise<void> | void;
}

export interface AgentRunner {
  run(
    input: AgentRunInput,
    callbacksOrOnChunk?:
      | StreamCallbacks
      | ((text: string) => Promise<void> | void),
  ): Promise<AgentRunOutput>;
}

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface StreamPromptMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string;
  };
  parent_tool_use_id: null;
  session_id: string;
}

// Keep prompt delivery as an async iterable to better align with Agent Teams
// expectations in Claude Agent SDK multi-agent flows.
class MessageStream implements AsyncIterable<StreamPromptMessage> {
  private queue: StreamPromptMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: {
        role: 'user',
        content: text,
      },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<StreamPromptMessage> {
    while (true) {
      while (this.queue.length > 0) {
        const next = this.queue.shift();
        if (next) {
          yield next;
        }
      }

      if (this.done) {
        return;
      }

      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      this.waiting = null;
    }
  }
}

const SECRET_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'API_TOKEN',
];

const SENSITIVE_HEADER_PATTERNS = [
  /^authorization$/i,
  /^x-api-key$/i,
  /^x-auth-token$/i,
  /^cookie$/i,
  /^proxy-authorization$/i,
];

function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADER_PATTERNS.some((pattern) => pattern.test(name));
}

function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    scrubbed[key] = isSensitiveHeader(key) ? '[REDACTED]' : value;
  }
  return scrubbed;
}

/**
 * Apply per-request MCP context overlays onto merged server configs.
 * Returns the updated configs and any warnings produced during the merge.
 */
function applyMcpContext(
  servers: Record<string, McpServerConfig>,
  context: Record<string, McpServerContext>,
): { merged: Record<string, McpServerConfig>; warnings: string[] } {
  const warnings: string[] = [];
  const merged: Record<string, McpServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    merged[name] = { ...cfg };
  }

  for (const [name, ctx] of Object.entries(context)) {
    if (name === 'picoclaw') {
      warnings.push(
        `mcp_context: '${name}' targets the built-in picoclaw server and was ignored`,
      );
      continue;
    }

    const server = merged[name];
    if (!server) {
      warnings.push(
        `mcp_context: '${name}' does not match any configured MCP server and was ignored`,
      );
      continue;
    }

    const isStdio = 'command' in server;

    if (ctx.headers) {
      if (!isStdio) {
        const httpServer = server as {
          type: 'http' | 'sse';
          url: string;
          headers?: Record<string, string>;
        };
        merged[name] = {
          ...httpServer,
          headers: { ...httpServer.headers, ...ctx.headers },
        };
      } else {
        warnings.push(
          `mcp_context: '${name}' has headers but server is stdio — headers ignored`,
        );
      }
    }

    if (ctx.env) {
      if (isStdio) {
        const stdioServer = merged[name] as {
          type?: 'stdio';
          command: string;
          args?: string[];
          env?: Record<string, string>;
        };
        merged[name] = {
          ...stdioServer,
          env: { ...stdioServer.env, ...ctx.env },
        };
      } else {
        const serverType = (server as { type?: string }).type || 'http';
        warnings.push(
          `mcp_context: '${name}' has env but server is ${serverType} — env ignored`,
        );
      }
    }

    if (ctx.args && ctx.args.length > 0) {
      if (isStdio) {
        const stdioServer = merged[name] as {
          type?: 'stdio';
          command: string;
          args?: string[];
          env?: Record<string, string>;
        };
        merged[name] = {
          ...stdioServer,
          args: [...(stdioServer.args || []), ...ctx.args],
        };
      } else {
        const serverType = (server as { type?: string }).type || 'http';
        warnings.push(
          `mcp_context: '${name}' has args but server is ${serverType} — args ignored`,
        );
      }
    }
  }

  return { merged, warnings };
}

/**
 * Resolve the path to the stdio MCP server executable.
 * Used when PICOCLAW_MCP_SERVER_PATH is set (stdio fallback mode).
 */
function resolveMcpServerPath(): string {
  const overridePath =
    process.env.PICOCLAW_MCP_SERVER_PATH ||
    process.env.NANOCLAW_MCP_SERVER_PATH;
  if (overridePath) {
    return overridePath;
  }

  return path.resolve(process.cwd(), 'dist/mcp-server.js');
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const index = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    ) as SessionsIndex;
    const entry = index.entries.find((item) => item.sessionId === sessionId);
    return entry?.summary || null;
  } catch {
    return null;
  }
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const now = new Date();
  return `conversation-${now.getHours().toString().padStart(2, '0')}${now
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: {
          content?:
            | string
            | Array<{ type?: string; text?: string; [key: string]: unknown }>;
        };
      };

      if (entry.type === 'user' && entry.message?.content) {
        const userText =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content.map((part) => part.text || '').join('');

        if (userText) {
          messages.push({ role: 'user', content: userText });
        }
      }

      if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
        const assistantText = entry.message.content
          .filter((part) => part.type === 'text' && part.text)
          .map((part) => part.text as string)
          .join('');

        if (assistantText) {
          messages.push({ role: 'assistant', content: assistantText });
        }
      }
    } catch {
      // Ignore malformed transcript lines.
    }
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const message of messages) {
    const sender =
      message.role === 'user' ? 'User' : assistantName || ASSISTANT_NAME;
    const text =
      message.content.length > 2_000
        ? `${message.content.slice(0, 2_000)}...`
        : message.content;
    lines.push(`**${sender}**: ${text}`);
    lines.push('');
  }

  return lines.join('\n');
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return {};
    }

    try {
      const transcript = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(transcript);
      if (messages.length === 0) {
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();
      const conversationsDir = path.join(MEMORY_DIR, 'conversations');
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const archivePath = path.join(conversationsDir, `${date}-${name}.md`);

      fs.writeFileSync(
        archivePath,
        formatTranscriptMarkdown(messages, summary, assistantName),
      );
    } catch {
      // Archiving should never fail the main agent flow.
    }

    return {};
  };
}

function createSanitizeBashHook(): HookCallback {
  return async (input) => {
    const preToolUse = input as PreToolUseHookInput;
    const command = (preToolUse.tool_input as { command?: string }).command;

    if (!command) {
      return {};
    }

    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: {
          ...(preToolUse.tool_input as Record<string, unknown>),
          command: `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; ${command}`,
        },
      },
    };
  };
}

// --- Cached filesystem reads (invalidated on skill reload) ---

let cachedOrgClaudeMd: string | undefined | null = null; // null = not loaded
let cachedAdditionalDirs: string[] | null = null;

function discoverAdditionalDirectories(): string[] {
  if (cachedAdditionalDirs !== null) {
    return cachedAdditionalDirs;
  }

  if (!fs.existsSync(SKILLS_DIR)) {
    cachedAdditionalDirs = [];
    return cachedAdditionalDirs;
  }

  const discovered: string[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR)) {
    const fullPath = path.join(SKILLS_DIR, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      discovered.push(fullPath);
    }
  }
  cachedAdditionalDirs = discovered;
  return discovered;
}

function loadOrgClaudeMd(): string | undefined {
  if (cachedOrgClaudeMd !== null) {
    return cachedOrgClaudeMd || undefined;
  }

  if (!ORG_DIR) {
    cachedOrgClaudeMd = '';
    return undefined;
  }

  const orgClaudeMdPath = path.join(ORG_DIR, 'CLAUDE.md');
  if (!fs.existsSync(orgClaudeMdPath)) {
    cachedOrgClaudeMd = '';
    return undefined;
  }

  cachedOrgClaudeMd = fs.readFileSync(orgClaudeMdPath, 'utf-8');
  return cachedOrgClaudeMd;
}

/**
 * Invalidate cached filesystem reads. Call after skill reload or
 * config changes that affect org CLAUDE.md or skill directories.
 */
export function invalidateAgentCache(): void {
  cachedOrgClaudeMd = null;
  cachedAdditionalDirs = null;
}

export class AgentEngine implements AgentRunner {
  async run(
    input: AgentRunInput,
    callbacksOrOnChunk?:
      | StreamCallbacks
      | ((text: string) => Promise<void> | void),
  ): Promise<AgentRunOutput> {
    const perf = createPerfTrace('agentRun', {
      conversationId: input.conversationId,
      hasResume: Boolean(input.sessionId),
      isScheduledTask: input.isScheduledTask === true,
    });
    const callbacks: StreamCallbacks =
      typeof callbacksOrOnChunk === 'function'
        ? { onChunk: callbacksOrOnChunk }
        : callbacksOrOnChunk || {};
    const { onChunk, onThinking, onToolUse } = callbacks;
    const timeoutMs = input.timeoutMs ?? MAX_EXECUTION_MS;
    const abortController = new AbortController();

    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, timeoutMs);

    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;
    let actualModel: string | undefined;
    let lastResult: string | null = null;
    let lastStreamedLength = 0;
    let usage: AgentUsage | undefined;
    let contextWarnings: string[] = [];
    let sawFirstTextDelta = false;
    let sawFirstThinkingDelta = false;

    try {
      const sdkEnv: Record<string, string | undefined> = {
        ...process.env,
      };
      // Unset CLAUDECODE to prevent "nested session" rejection when
      // PicoClaw itself is launched inside a Claude Code session
      // (e.g. during local development with `npm run dev`).
      delete sdkEnv.CLAUDECODE;
      perf.mark('prepareSdkEnv');

      const orgClaudeMd = loadOrgClaudeMd();
      perf.mark('loadOrgClaudeMd', {
        bytes: orgClaudeMd ? orgClaudeMd.length : 0,
      });

      const additionalDirectories = discoverAdditionalDirectories();
      perf.mark('discoverAdditionalDirs', {
        count: additionalDirectories.length,
      });

      const prompt = input.isScheduledTask
        ? `[SCHEDULED TASK]\n${input.prompt}`
        : input.prompt;
      const promptStream = new MessageStream();
      promptStream.push(prompt);
      promptStream.end();
      perf.mark('preparePromptStream', { promptChars: prompt.length });

      // Three-way MCP server merge: org-managed → built-in picoclaw → per-request.
      // Managed servers are loaded programmatically (not via CLI auto-discovery)
      // to avoid the enterprise MCP config exclusion that prevents --mcp-config
      // usage when /etc/claude-code/managed-mcp.json exists.
      //
      // The built-in picoclaw server uses `type: 'sdk'` (in-process) to eliminate
      // the stdio subprocess spawn overhead (~100ms per request).
      const managedServers = getManagedMcpServers();
      const perRequestServers = input.mcpServers
        ? Object.fromEntries(
            Object.entries(input.mcpServers).filter(
              ([name]) => name !== 'picoclaw',
            ),
          )
        : {};

      // Use in-process MCP by default. Fall back to stdio subprocess when
      // PICOCLAW_MCP_SERVER_PATH is explicitly set (backward compatibility,
      // Docker scenarios, or A/B performance testing).
      const useStdioMcp = Boolean(process.env.PICOCLAW_MCP_SERVER_PATH);
      let picoClawMcpConfig: SdkMcpServerConfig;

      if (useStdioMcp) {
        const mcpServerPath = resolveMcpServerPath();
        if (!fs.existsSync(mcpServerPath)) {
          throw new Error(
            `MCP server not found at ${mcpServerPath}. Run npm run build first.`,
          );
        }
        picoClawMcpConfig = {
          command: 'node',
          args: [mcpServerPath],
          env: {
            PICOCLAW_CONVERSATION_ID: input.conversationId,
            PICOCLAW_DB_PATH: LOCAL_DB_PATH,
            PICOCLAW_IS_MAIN: '1',
          },
        };
        perf.mark('createStdioMcp');
      } else {
        picoClawMcpConfig = createPicoClawMcpServer(input.conversationId, true);
        perf.mark('createInprocessMcp');
      }

      let mergedMcpServers: Record<string, SdkMcpServerConfig> = {
        ...managedServers,
        picoclaw: picoClawMcpConfig,
        ...perRequestServers,
      };
      perf.mark('mergeMcpServers', {
        managedCount: Object.keys(managedServers).length,
        perRequestCount: Object.keys(perRequestServers).length,
        totalCount: Object.keys(mergedMcpServers).length,
      });

      // Apply per-request mcp_context overlays (after three-way merge).
      // Context overlays only apply to serializable servers (stdio/http/sse),
      // not to the in-process picoclaw server.
      if (input.mcpContext) {
        const applied = applyMcpContext(
          mergedMcpServers as Record<string, McpServerConfig>,
          input.mcpContext,
        );
        mergedMcpServers = {
          ...mergedMcpServers,
          ...applied.merged,
        };
        contextWarnings = applied.warnings;
        perf.mark('applyMcpContext', {
          overlayCount: Object.keys(input.mcpContext).length,
        });
        if (applied.warnings.length > 0) {
          logger.warn(
            {
              conversationId: input.conversationId,
              warnings: applied.warnings,
            },
            'MCP context merge produced warnings',
          );
        }
      }

      logger.debug(
        {
          conversationId: input.conversationId,
          mcpServers: Object.entries(mergedMcpServers).map(([name, cfg]) => {
            const typeName =
              'type' in cfg && cfg.type === 'sdk'
                ? 'sdk'
                : 'command' in cfg
                  ? 'stdio'
                  : ('type' in cfg && cfg.type) || 'http';
            return {
              name,
              type: typeName,
              source:
                name === 'picoclaw'
                  ? 'built-in (in-process)'
                  : name in perRequestServers
                    ? 'per-request'
                    : 'org-managed',
              ...('headers' in cfg &&
              cfg.headers &&
              typeof cfg.headers === 'object'
                ? {
                    headers: scrubHeaders(
                      cfg.headers as Record<string, string>,
                    ),
                  }
                : {}),
              hasContextOverlay: input.mcpContext
                ? name in input.mcpContext
                : false,
            };
          }),
        },
        'MCP servers configured for request',
      );

      // Build allowedTools with wildcards for each MCP server.
      const allowedTools = [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'WebSearch',
        'WebFetch',
        'Task',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'SendMessage',
        'TodoWrite',
        'ToolSearch',
        'Skill',
        'NotebookEdit',
        ...Object.keys(mergedMcpServers).map((name) => `mcp__${name}__*`),
      ];
      perf.mark('buildAllowedTools', {
        count: allowedTools.length,
      });

      const model = input.model || CLAUDE_MODEL || undefined;
      const fallbackModel = CLAUDE_FALLBACK_MODEL || undefined;
      perf.mark('startSdkQuery', {
        model: model || '(default)',
        fallbackModel: fallbackModel || '(none)',
      });

      for await (const message of query({
        prompt: promptStream,
        options: {
          abortController,
          model,
          fallbackModel,
          cwd: MEMORY_DIR,
          additionalDirectories:
            additionalDirectories.length > 0
              ? additionalDirectories
              : undefined,
          resume: input.sessionId,
          resumeSessionAt: input.resumeAt,
          systemPrompt: SYSTEM_PROMPT_OVERRIDE
            ? SYSTEM_PROMPT_OVERRIDE
            : orgClaudeMd
              ? {
                  type: 'preset',
                  preset: 'claude_code',
                  append: orgClaudeMd,
                }
              : undefined,
          allowedTools,
          includePartialMessages: true,
          maxThinkingTokens: input.maxThinkingTokens,
          env: sdkEnv,
          stderr:
            SDK_LOG_LEVEL === 'debug'
              ? (data: string) => {
                  logger.debug({ source: 'sdk' }, data.trimEnd());
                }
              : undefined,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          settingSources: ['project', 'user'],
          mcpServers: mergedMcpServers,
          hooks: {
            PreCompact: [
              {
                hooks: [
                  createPreCompactHook(input.assistantName || ASSISTANT_NAME),
                ],
              },
            ],
            PreToolUse: [
              {
                matcher: 'Bash',
                hooks: [createSanitizeBashHook()],
              },
            ],
          },
        },
      }) as AsyncIterable<any>) {
        if (message.type === 'system' && message.subtype === 'init') {
          newSessionId = message.session_id;
          actualModel = message.model;
          perf.mark('sdkInit', {
            model: message.model,
            toolCount: Array.isArray(message.tools)
              ? message.tools.length
              : undefined,
            mcpServerCount: Array.isArray(message.mcp_servers)
              ? message.mcp_servers.length
              : undefined,
          });
          logger.debug(
            {
              conversationId: input.conversationId,
              model: message.model,
              tools: message.tools,
              mcpServers: message.mcp_servers,
            },
            'SDK session initialized — tools and MCP servers discovered',
          );
        }

        // Stream incremental text and thinking from content_block_delta events
        if (
          message.type === 'stream_event' &&
          message.event?.type === 'content_block_delta'
        ) {
          const delta = message.event.delta;
          if (delta?.type === 'text_delta' && delta.text && onChunk) {
            if (!sawFirstTextDelta) {
              sawFirstTextDelta = true;
              perf.mark('firstTextDelta');
            }
            lastStreamedLength += delta.text.length;
            await onChunk(delta.text);
          }
          if (
            delta?.type === 'thinking_delta' &&
            delta.thinking &&
            onThinking
          ) {
            if (!sawFirstThinkingDelta) {
              sawFirstThinkingDelta = true;
              perf.mark('firstThinkingDelta');
            }
            await onThinking(delta.thinking);
          }
        }

        // Track assistant UUID and emit tool_use events
        if (message.type === 'assistant') {
          if (message.uuid) {
            lastAssistantUuid = message.uuid;
          }
          if (input.showToolUse && onToolUse && message.message?.content) {
            const contentBlocks = message.message.content as Array<{
              type?: string;
              name?: string;
              input?: unknown;
            }>;
            for (const block of contentBlocks) {
              if (block.type === 'tool_use' && block.name) {
                await onToolUse(block.name, block.input);
              }
            }
          }
        }

        if (message.type === 'result') {
          perf.mark('sdkResult', {
            numTurns: message.num_turns ?? undefined,
            durationApiMs: message.duration_api_ms ?? undefined,
          });
          const text =
            typeof message.result === 'string' ? message.result : null;
          if (text) {
            lastResult = text;
            // Only call onChunk for result if no streaming happened
            if (onChunk && lastStreamedLength === 0) {
              await onChunk(text);
            }
          }
          // Extract usage metrics from SDK result message.
          // The top-level usage object uses snake_case (input_tokens) while
          // the typed NonNullableUsage interface uses camelCase (inputTokens).
          // Handle both naming conventions defensively.
          const u = message.usage;
          usage = {
            inputTokens: u?.inputTokens ?? u?.input_tokens ?? 0,
            outputTokens: u?.outputTokens ?? u?.output_tokens ?? 0,
            totalCostUsd: message.total_cost_usd ?? 0,
            numTurns: message.num_turns ?? 0,
            durationApiMs: message.duration_api_ms ?? 0,
          };
        }
      }

      logger.info(
        {
          conversationId: input.conversationId,
          status: 'success',
          model: actualModel,
          ...(usage && {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            totalCostUsd: usage.totalCostUsd,
            numTurns: usage.numTurns,
            durationApiMs: usage.durationApiMs,
          }),
        },
        'Agent execution completed',
      );
      perf.flush('[PERF:AGENT] execution complete', {
        status: 'success',
        model: actualModel || '(unknown)',
        mcpServerCount: Object.keys(mergedMcpServers).length,
      });

      return {
        status: 'success',
        result: lastResult,
        newSessionId,
        lastAssistantUuid,
        model: actualModel,
        usage,
        ...(contextWarnings.length > 0 && { contextWarnings }),
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isAbort = err instanceof Error && err.name === 'AbortError';
      if (isAbort) {
        logger.info(
          {
            conversationId: input.conversationId,
            status: 'timeout',
            timeoutMs,
          },
          'Agent execution timed out',
        );
        perf.flush('[PERF:AGENT] execution timed out', {
          status: 'timeout',
          timeoutMs,
        });
        return {
          status: 'timeout',
          result: lastResult,
          newSessionId,
          lastAssistantUuid,
          model: actualModel,
          error: `Execution aborted after ${timeoutMs}ms. Use conversation_id to continue.`,
          usage,
          ...(contextWarnings.length > 0 && { contextWarnings }),
        };
      }

      logger.error(
        { conversationId: input.conversationId, err },
        'Agent execution failed',
      );
      perf.flush('[PERF:AGENT] execution failed', {
        status: 'error',
        error: errorMessage,
      });
      return {
        status: 'error',
        result: lastResult,
        newSessionId,
        lastAssistantUuid,
        model: actualModel,
        error: errorMessage,
        usage,
        ...(contextWarnings.length > 0 && { contextWarnings }),
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
