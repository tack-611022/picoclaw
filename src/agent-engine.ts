import fs from 'fs';
import path from 'path';

import {
  HookCallback,
  PreCompactHookInput,
  PreToolUseHookInput,
  query,
} from '@anthropic-ai/claude-agent-sdk';

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
import { AgentUsage } from './types.js';

/**
 * MCP server configuration for stdio, SSE, or HTTP transports.
 * Maps directly to the Claude Agent SDK McpServerConfig type.
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
}

export interface AgentRunOutput {
  status: 'success' | 'timeout' | 'error';
  result: string | null;
  newSessionId?: string;
  lastAssistantUuid?: string;
  model?: string;
  error?: string;
  usage?: AgentUsage;
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

function discoverAdditionalDirectories(): string[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    return [];
  }

  const discovered: string[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR)) {
    const fullPath = path.join(SKILLS_DIR, entry);
    if (fs.statSync(fullPath).isDirectory()) {
      discovered.push(fullPath);
    }
  }
  return discovered;
}

function loadOrgClaudeMd(): string | undefined {
  if (!ORG_DIR) {
    return undefined;
  }

  const orgClaudeMdPath = path.join(ORG_DIR, 'CLAUDE.md');
  if (!fs.existsSync(orgClaudeMdPath)) {
    return undefined;
  }

  return fs.readFileSync(orgClaudeMdPath, 'utf-8');
}

export class AgentEngine implements AgentRunner {
  async run(
    input: AgentRunInput,
    callbacksOrOnChunk?:
      | StreamCallbacks
      | ((text: string) => Promise<void> | void),
  ): Promise<AgentRunOutput> {
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

    try {
      const sdkEnv: Record<string, string | undefined> = {
        ...process.env,
      };
      // Unset CLAUDECODE to prevent "nested session" rejection when
      // PicoClaw itself is launched inside a Claude Code session
      // (e.g. during local development with `npm run dev`).
      delete sdkEnv.CLAUDECODE;

      const orgClaudeMd = loadOrgClaudeMd();
      const additionalDirectories = discoverAdditionalDirectories();
      const mcpServerPath = resolveMcpServerPath();

      if (!fs.existsSync(mcpServerPath)) {
        throw new Error(
          `MCP server not found at ${mcpServerPath}. Run npm run build first.`,
        );
      }

      const prompt = input.isScheduledTask
        ? `[SCHEDULED TASK]\n${input.prompt}`
        : input.prompt;
      const promptStream = new MessageStream();
      promptStream.push(prompt);
      promptStream.end();

      // Three-way MCP server merge: org-managed → built-in picoclaw → per-request.
      // Managed servers are loaded programmatically (not via CLI auto-discovery)
      // to avoid the enterprise MCP config exclusion that prevents --mcp-config
      // usage when /etc/claude-code/managed-mcp.json exists.
      const managedServers = getManagedMcpServers();
      const perRequestServers = input.mcpServers
        ? Object.fromEntries(
            Object.entries(input.mcpServers).filter(
              ([name]) => name !== 'picoclaw',
            ),
          )
        : {};

      const mergedMcpServers: Record<string, McpServerConfig> = {
        ...managedServers,
        picoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            PICOCLAW_CONVERSATION_ID: input.conversationId,
            PICOCLAW_DB_PATH: LOCAL_DB_PATH,
            PICOCLAW_IS_MAIN: '1',
          },
        },
        ...perRequestServers,
      };

      logger.debug(
        {
          conversationId: input.conversationId,
          mcpServers: Object.entries(mergedMcpServers).map(([name, cfg]) => ({
            name,
            type: ('command' in cfg ? 'stdio' : cfg.type) || 'http',
            source:
              name === 'picoclaw'
                ? 'built-in'
                : name in perRequestServers
                  ? 'per-request'
                  : 'org-managed',
          })),
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

      const model = input.model || CLAUDE_MODEL || undefined;
      const fallbackModel = CLAUDE_FALLBACK_MODEL || undefined;

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
            lastStreamedLength += delta.text.length;
            await onChunk(delta.text);
          }
          if (
            delta?.type === 'thinking_delta' &&
            delta.thinking &&
            onThinking
          ) {
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

      return {
        status: 'success',
        result: lastResult,
        newSessionId,
        lastAssistantUuid,
        model: actualModel,
        usage,
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
        return {
          status: 'timeout',
          result: lastResult,
          newSessionId,
          lastAssistantUuid,
          model: actualModel,
          error: `Execution aborted after ${timeoutMs}ms. Use conversation_id to continue.`,
          usage,
        };
      }

      logger.error(
        { conversationId: input.conversationId, err },
        'Agent execution failed',
      );
      return {
        status: 'error',
        result: lastResult,
        newSessionId,
        lastAssistantUuid,
        model: actualModel,
        error: errorMessage,
        usage,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}
