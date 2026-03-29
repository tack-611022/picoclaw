import { randomUUID } from 'crypto';

import { Request, Response, Router } from 'express';

import {
  AgentRunner,
  McpServerConfig,
  McpServerContext,
  StreamCallbacks,
} from '../agent-engine.js';
import {
  validateSingleMcpContext,
  validateSingleMcpServer,
} from '../managed-mcp.js';
import {
  ASSISTANT_NAME,
  MAX_EXECUTION_MS,
  SESSION_END_MARKER,
  TIMEZONE,
} from '../config.js';
import {
  ConversationBusyError,
  acquireConversationLock,
} from '../conversation-lock.js';
import {
  consumeOutboundMessages,
  createConversation,
  deleteConversation,
  ensureConversation,
  getAllConversations,
  getConversation,
  getConversationMessages,
  getPromptMessages,
  setConversationStatus,
  storeConversationMessage,
  updateConversationSession,
} from '../db.js';
import { logger } from '../logger.js';
import { formatMessages, formatOutbound } from '../router.js';

interface ChatRequestBody {
  message?: string;
  conversation_id?: string;
  sender?: string;
  sender_name?: string;
  stream?: boolean;
  max_execution_ms?: number;
  thinking?: boolean;
  max_thinking_tokens?: number;
  show_tool_use?: boolean;
  model?: string;
  mcp_servers?: Record<string, McpServerConfig>;
  mcp_context?: Record<string, unknown>;
}

function getExecutionTimeout(ms?: number): number {
  if (!ms || !Number.isFinite(ms) || ms <= 0) {
    return MAX_EXECUTION_MS;
  }

  return Math.min(ms, MAX_EXECUTION_MS);
}

function writeSseEvent(res: Response, event: string, payload: object): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function resolveConversation(body: ChatRequestBody): {
  id: string;
  isNew: boolean;
} {
  if (!body.conversation_id) {
    return { id: `conv-${randomUUID()}`, isNew: true };
  }

  return { id: body.conversation_id, isNew: false };
}

const RESERVED_MCP_NAMES = new Set(['picoclaw']);

interface McpValidationResult {
  servers: Record<string, McpServerConfig> | null;
  warnings: string[];
}

function validateMcpServers(raw: unknown): McpValidationResult {
  const warnings: string[] = [];

  if (raw === undefined || raw === null) {
    return { servers: null, warnings };
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(
      `mcp_servers: expected an object, got ${Array.isArray(raw) ? 'array' : typeof raw}`,
    );
    return { servers: null, warnings };
  }

  const result: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(raw as Record<string, unknown>)) {
    if (RESERVED_MCP_NAMES.has(name)) {
      warnings.push(
        `mcp_servers: '${name}' is a reserved name and was ignored`,
      );
      continue;
    }

    const { config: validated, reason } = validateSingleMcpServer(config);
    if (validated) {
      result[name] = validated;
    } else {
      warnings.push(`mcp_servers: '${name}' skipped — ${reason}`);
    }
  }

  return {
    servers: Object.keys(result).length > 0 ? result : null,
    warnings,
  };
}

interface McpContextValidationResult {
  context: Record<string, McpServerContext> | null;
  warnings: string[];
}

function validateMcpContext(raw: unknown): McpContextValidationResult {
  const warnings: string[] = [];

  if (raw === undefined || raw === null) {
    return { context: null, warnings };
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(
      `mcp_context: expected an object, got ${Array.isArray(raw) ? 'array' : typeof raw}`,
    );
    return { context: null, warnings };
  }

  const result: Record<string, McpServerContext> = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (RESERVED_MCP_NAMES.has(name)) {
      warnings.push(
        `mcp_context: '${name}' is a reserved server name and was ignored`,
      );
      continue;
    }

    const validation = validateSingleMcpContext(entry);
    if (validation.valid) {
      result[name] = validation.context;
    } else {
      warnings.push(`mcp_context: '${name}' skipped — ${validation.reason}`);
    }
  }

  return {
    context: Object.keys(result).length > 0 ? result : null,
    warnings,
  };
}

function containsSessionEndMarker(text: string | null | undefined): boolean {
  if (!SESSION_END_MARKER) {
    return false;
  }

  return Boolean(text && text.includes(SESSION_END_MARKER));
}

export function chatRoutes(agentEngine: AgentRunner): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const body = (req.body || {}) as ChatRequestBody;
    const message = body.message?.trim();

    if (!message) {
      res.status(400).json({ error: 'message is required' });
      return;
    }

    const { id: conversationId, isNew } = resolveConversation(body);
    const existingConversation = getConversation(conversationId);
    if (!isNew && !existingConversation) {
      res
        .status(404)
        .json({ error: `conversation_id not found: ${conversationId}` });
      return;
    }

    const conversation = isNew
      ? createConversation(conversationId)
      : ensureConversation(conversationId);

    const userMessageId = `msg-${randomUUID()}`;
    const sender = body.sender?.trim() || 'user';
    const senderName = body.sender_name?.trim() || sender;

    storeConversationMessage({
      id: userMessageId,
      conversationId,
      role: 'user',
      sender,
      senderName,
      content: message,
    });

    const promptMessages = getPromptMessages(conversationId);
    const prompt = formatMessages(promptMessages, TIMEZONE);

    const executionTimeout = getExecutionTimeout(body.max_execution_ms);
    const stream = body.stream === true;
    const enableThinking = body.thinking === true;
    const maxThinkingTokens =
      enableThinking && body.max_thinking_tokens && body.max_thinking_tokens > 0
        ? body.max_thinking_tokens
        : enableThinking
          ? 10000
          : undefined;
    const showToolUse = body.show_tool_use === true;
    const { servers: mcpServers, warnings: mcpWarnings } = validateMcpServers(
      body.mcp_servers,
    );
    const { context: mcpContext, warnings: mcpContextWarnings } =
      validateMcpContext(body.mcp_context);
    const allWarnings = [...mcpWarnings, ...mcpContextWarnings];

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      writeSseEvent(res, 'start', {
        conversation_id: conversationId,
        message_id: userMessageId,
        ...(allWarnings.length > 0 && { warnings: allWarnings }),
      });
    }

    logger.info(
      {
        requestId: req.requestId,
        conversationId,
        isNew,
        stream,
      },
      'Chat request received',
    );

    let releaseLock: (() => void) | undefined;
    const startedAt = Date.now();
    const chunkBuffer: string[] = [];

    try {
      releaseLock = await acquireConversationLock(conversationId, {
        wait: false,
      });
      setConversationStatus(conversationId, 'running');

      const streamCallbacks: StreamCallbacks = {
        onChunk: async (chunkText: string) => {
          const formatted = formatOutbound(chunkText);
          if (!formatted) {
            return;
          }

          chunkBuffer.push(formatted);
          if (stream) {
            writeSseEvent(res, 'chunk', { text: formatted });
          }
        },
        onThinking:
          stream && enableThinking
            ? async (text: string) => {
                writeSseEvent(res, 'thinking', { text });
              }
            : undefined,
        onToolUse:
          stream && showToolUse
            ? async (tool: string, input: unknown) => {
                writeSseEvent(res, 'tool_use', { tool, input });
              }
            : undefined,
      };

      const output = await agentEngine.run(
        {
          prompt,
          conversationId,
          sessionId: conversation.session_id,
          resumeAt: conversation.last_assistant_uuid,
          timeoutMs: executionTimeout,
          assistantName: ASSISTANT_NAME,
          maxThinkingTokens,
          showToolUse,
          model: body.model?.trim() || undefined,
          mcpServers: mcpServers ?? undefined,
          mcpContext: mcpContext ?? undefined,
        },
        streamCallbacks,
      );

      const finalResult = formatOutbound(
        output.result || chunkBuffer.join('').trim(),
      );

      let assistantMessageId: string | null = null;
      if (finalResult) {
        assistantMessageId = `msg-${randomUUID()}`;
        storeConversationMessage({
          id: assistantMessageId,
          conversationId,
          role: 'assistant',
          sender: 'assistant',
          senderName: ASSISTANT_NAME,
          content: finalResult,
        });
      }

      updateConversationSession(
        conversationId,
        output.newSessionId,
        output.lastAssistantUuid,
      );
      setConversationStatus(conversationId, 'idle');

      const outboundMessages = consumeOutboundMessages(conversationId);
      const hasSessionEndMarker =
        containsSessionEndMarker(finalResult) ||
        outboundMessages.some((message) =>
          containsSessionEndMarker(message.text),
        );
      const durationMs = Date.now() - startedAt;
      if (output.contextWarnings) {
        allWarnings.push(...output.contextWarnings);
      }
      const responseBody = {
        status: output.status,
        conversation_id: conversationId,
        message_id: assistantMessageId || userMessageId,
        result: finalResult,
        model: output.model,
        session_id: output.newSessionId || conversation.session_id,
        duration_ms: durationMs,
        error: output.error,
        outbound_messages: outboundMessages,
        session_end_marker: SESSION_END_MARKER,
        session_end_marker_detected: hasSessionEndMarker,
        ...(output.usage && { usage: output.usage }),
        ...(allWarnings.length > 0 && { warnings: allWarnings }),
      };

      // Expose usage to per-request middleware log (server.ts)
      if (output.usage) {
        res.locals.usage = output.usage;
      }

      logger.info(
        {
          requestId: req.requestId,
          conversationId,
          status: output.status,
          durationMs,
          ...(output.usage && {
            inputTokens: output.usage.inputTokens,
            outputTokens: output.usage.outputTokens,
            totalCostUsd: output.usage.totalCostUsd,
          }),
        },
        'Chat request completed',
      );

      if (stream) {
        for (const outbound of outboundMessages) {
          writeSseEvent(res, 'chunk', {
            text: formatOutbound(outbound.text),
            sender: outbound.sender,
          });
        }
        writeSseEvent(res, 'done', responseBody);
        res.end();
        return;
      }

      res.json(responseBody);
    } catch (err) {
      if (err instanceof ConversationBusyError) {
        const errorBody = {
          error: `Conversation ${conversationId} is currently processing another request`,
          conversation_id: conversationId,
        };
        if (stream) {
          writeSseEvent(res, 'error', errorBody);
          res.end();
          return;
        }
        res.status(409).json(errorBody);
        return;
      }

      setConversationStatus(conversationId, 'idle');
      const messageText = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, conversationId, requestId: req.requestId },
        'Chat request failed',
      );

      if (stream) {
        writeSseEvent(res, 'error', { error: messageText });
        res.end();
        return;
      }

      res.status(500).json({
        status: 'error',
        conversation_id: conversationId,
        message_id: userMessageId,
        result: null,
        error: messageText,
      });
    } finally {
      releaseLock?.();
    }
  });

  router.get('/', (_req: Request, res: Response) => {
    const conversations = getAllConversations();
    res.json({ conversations });
  });

  router.get('/:conversation_id/messages', (req: Request, res: Response) => {
    const rawConversationId = req.params.conversation_id;
    const conversationId = Array.isArray(rawConversationId)
      ? rawConversationId[0]
      : rawConversationId;

    if (!conversationId) {
      res.status(400).json({ error: 'conversation_id is required' });
      return;
    }

    const conversation = getConversation(conversationId);
    if (!conversation) {
      res
        .status(404)
        .json({ error: `conversation_id not found: ${conversationId}` });
      return;
    }

    const messages = getConversationMessages(conversationId);
    res.json({
      conversation_id: conversationId,
      messages,
    });
  });

  router.delete('/:conversation_id', (req: Request, res: Response) => {
    const rawConversationId = req.params.conversation_id;
    const conversationId = Array.isArray(rawConversationId)
      ? rawConversationId[0]
      : rawConversationId;

    if (!conversationId) {
      res.status(400).json({ error: 'conversation_id is required' });
      return;
    }

    const conversation = getConversation(conversationId);
    if (!conversation) {
      res
        .status(404)
        .json({ error: `conversation_id not found: ${conversationId}` });
      return;
    }

    if (conversation.status === 'running') {
      res.status(409).json({
        error: `Conversation ${conversationId} is currently running`,
        conversation_id: conversationId,
      });
      return;
    }

    deleteConversation(conversationId);
    res.status(204).send();
  });

  router.get('/:conversation_id', (req: Request, res: Response) => {
    const rawConversationId = req.params.conversation_id;
    const conversationId = Array.isArray(rawConversationId)
      ? rawConversationId[0]
      : rawConversationId;

    if (!conversationId) {
      res.status(400).json({ error: 'conversation_id is required' });
      return;
    }

    const conversation = getConversation(conversationId);

    if (!conversation) {
      res
        .status(404)
        .json({ error: `conversation_id not found: ${conversationId}` });
      return;
    }

    res.json({
      conversation_id: conversation.id,
      session_id: conversation.session_id,
      message_count: conversation.message_count,
      last_activity: conversation.last_activity,
      status: conversation.status,
    });
  });

  return router;
}
