#!/usr/bin/env node
// Test-only MCP server — verifies mcp_context header injection.
// Tools: echo_headers, check_auth, get_user_data
// Usage: node scripts/test-auth-mcp-server.mjs [port]  (default: 3456)
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';

const PORT = parseInt(process.argv[2] || '3456', 10);

// Store per-session request headers so tools can read them
const sessionHeaders = new Map();

function createMcpServer() {
  const server = new McpServer({
    name: 'auth-test-server',
    version: '1.0.0',
  });

  // ── Tool 1: echo_headers ─────────────────────────────────
  server.tool(
    'echo_headers',
    'Returns HTTP request headers (for auth verification testing)',
    {},
    async (_args, extra) => {
      const headers = sessionHeaders.get(extra.sessionId) || {};
      const filtered = Object.fromEntries(
        Object.entries(headers).filter(
          ([k]) =>
            !k.startsWith('content-') &&
            !['host', 'connection', 'accept', 'accept-encoding', 'user-agent', 'transfer-encoding'].includes(k),
        ),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(filtered, null, 2) }],
      };
    },
  );

  // ── Tool 2: check_auth ───────────────────────────────────
  server.tool(
    'check_auth',
    'Simulates auth-required endpoint. Requires Authorization header.',
    { action: z.string().optional().describe('Action to perform') },
    async (args, extra) => {
      const headers = sessionHeaders.get(extra.sessionId) || {};
      const authHeader = headers['authorization'];

      if (!authHeader) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'AUTH_REQUIRED',
                message: 'No Authorization header. Provide Bearer token via mcp_context.',
              }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              status: 'authenticated',
              token_preview: authHeader.substring(0, 20) + '...',
              action: args.action || 'none',
              user_id: headers['x-user-id'] || '(not provided)',
              tenant_id: headers['x-tenant-id'] || '(not provided)',
            }),
          },
        ],
      };
    },
  );

  // ── Tool 3: get_user_data ────────────────────────────────
  server.tool(
    'get_user_data',
    'Returns user-specific data based on X-User-Id header',
    { query: z.string().describe('Data query') },
    async (args, extra) => {
      const headers = sessionHeaders.get(extra.sessionId) || {};
      const userId = headers['x-user-id'];

      if (!userId) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: 'USER_NOT_IDENTIFIED',
                message: 'X-User-Id header missing. Pass it via mcp_context.',
              }),
            },
          ],
          isError: true,
        };
      }

      const mockData = {
        alice: { balance: 1500.0, transactions: 12, last_login: '2026-03-26' },
        bob: { balance: 3200.5, transactions: 8, last_login: '2026-03-25' },
      };

      const userData = mockData[userId.toLowerCase()] || {
        balance: 0,
        transactions: 0,
        note: `No data for user '${userId}'`,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ user_id: userId, query: args.query, data: userData }),
          },
        ],
      };
    },
  );

  return server;
}

// ── Express + Streamable HTTP transport ──────────────────
const app = express();
const transports = new Map();

app.post('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];

  if (sessionId && transports.has(sessionId)) {
    // Update stored headers for this session (they may change per request)
    sessionHeaders.set(sessionId, { ...req.headers });
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res);
    return;
  }

  // New session — create a fresh McpServer + transport
  const mcpServer = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (newSessionId) => {
      transports.set(newSessionId, transport);
      sessionHeaders.set(newSessionId, { ...req.headers });
    },
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) {
      transports.delete(sid);
      sessionHeaders.delete(sid);
    }
  };

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
});

app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && transports.has(sessionId)) {
    await transports.get(sessionId).handleRequest(req, res);
    return;
  }
  res.status(400).json({ error: 'Missing or invalid session' });
});

app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'];
  if (sessionId && transports.has(sessionId)) {
    const transport = transports.get(sessionId);
    await transport.handleRequest(req, res);
    transports.delete(sessionId);
    sessionHeaders.delete(sessionId);
    return;
  }
  res.status(400).json({ error: 'Missing or invalid session' });
});

app.listen(PORT, () => {
  console.log(`Auth-test MCP server listening on http://localhost:${PORT}/mcp`);
  console.log('Tools: echo_headers, check_auth, get_user_data');
});
