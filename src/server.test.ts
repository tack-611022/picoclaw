import fs from 'fs';
import os from 'os';
import path from 'path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRunner, StreamCallbacks } from './agent-engine.js';

function makeFakeEngine(): AgentRunner {
  return {
    async run() {
      return {
        status: 'success',
        result: 'mock-result [[PICOCLAW_SESSION_END]]',
        newSessionId: 'session-abc',
        lastAssistantUuid: 'assistant-abc',
      };
    },
  };
}

describe('http server', () => {
  let closeDatabase: (() => void) | undefined;
  let resetDatabase: (() => void) | undefined;
  let app: import('express').Express;
  let fakeEngine: AgentRunner;
  let stopSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    process.env.API_TOKEN = 'test-token';

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picoclaw-http-'));

    const dbModule = await import('./db.js');
    dbModule.initDatabase({
      persistentDbPath: path.join(rootDir, 'store', 'messages.db'),
      localDbPath: path.join(rootDir, 'tmp', 'messages.db'),
      forceReinitialize: true,
    });

    closeDatabase = dbModule.closeDatabase;
    resetDatabase = dbModule._resetDatabaseForTests;

    fakeEngine = makeFakeEngine();
    stopSpy = vi.fn();

    const serverModule = await import('./server.js');
    app = serverModule.createServer(fakeEngine, {
      onStop: stopSpy,
    });
  });

  afterEach(() => {
    closeDatabase?.();
    resetDatabase?.();
  });

  it('returns health without auth', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(['ok', 'degraded']).toContain(response.body.status);
    expect(response.body.database.ok).toBe(true);
    expect(response.body.database.conversations).toBeTypeOf('number');
    expect(response.body.database.tasks).toBeTypeOf('number');
    expect(response.body.volumes).toBeDefined();
  });

  it('rejects chat request without bearer token', async () => {
    const response = await request(app)
      .post('/chat')
      .send({ message: 'hello' });
    expect(response.status).toBe(401);
  });

  it('creates and resumes conversation through /chat', async () => {
    const first = await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'first turn', sender: 'u1', sender_name: 'User' });

    expect(first.status).toBe(200);
    expect(first.body.status).toBe('success');
    expect(first.body.conversation_id).toMatch(/^conv-/);
    expect(first.body.result).toContain('mock-result');
    expect(first.body.session_end_marker).toBe('[[PICOCLAW_SESSION_END]]');
    expect(first.body.session_end_marker_detected).toBe(true);

    const conversationId = first.body.conversation_id as string;

    const second = await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({
        message: 'second turn',
        conversation_id: conversationId,
        sender: 'u1',
        sender_name: 'User',
      });

    expect(second.status).toBe(200);
    expect(second.body.conversation_id).toBe(conversationId);

    const status = await request(app)
      .get(`/chat/${conversationId}`)
      .set('Authorization', 'Bearer test-token');

    expect(status.status).toBe(200);
    expect(status.body.message_count).toBeGreaterThanOrEqual(4);
  });

  it('creates and lists tasks', async () => {
    const response = await request(app)
      .post('/task')
      .set('Authorization', 'Bearer test-token')
      .send({
        prompt: 'do work',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
      });

    expect(response.status).toBe(201);
    expect(response.body.id).toMatch(/^task-/);

    const list = await request(app)
      .get('/tasks')
      .set('Authorization', 'Bearer test-token');

    expect(list.status).toBe(200);
    expect(list.body.tasks).toHaveLength(1);
  });

  it('lists conversations via GET /chat', async () => {
    // Create a conversation
    await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'hello' });

    const list = await request(app)
      .get('/chat')
      .set('Authorization', 'Bearer test-token');

    expect(list.status).toBe(200);
    expect(list.body.conversations).toHaveLength(1);
    expect(list.body.conversations[0].id).toMatch(/^conv-/);
  });

  it('returns messages via GET /chat/:id/messages', async () => {
    const first = await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'hello' });

    const conversationId = first.body.conversation_id as string;

    const messages = await request(app)
      .get(`/chat/${conversationId}/messages`)
      .set('Authorization', 'Bearer test-token');

    expect(messages.status).toBe(200);
    expect(messages.body.conversation_id).toBe(conversationId);
    expect(messages.body.messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.body.messages[0].role).toBe('user');
  });

  it('deletes conversation via DELETE /chat/:id', async () => {
    const create = await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'hello' });

    const conversationId = create.body.conversation_id as string;

    const del = await request(app)
      .delete(`/chat/${conversationId}`)
      .set('Authorization', 'Bearer test-token');

    expect(del.status).toBe(204);

    // Verify it's gone
    const get = await request(app)
      .get(`/chat/${conversationId}`)
      .set('Authorization', 'Bearer test-token');
    expect(get.status).toBe(404);
  });

  it('returns 404 when deleting non-existent conversation', async () => {
    const del = await request(app)
      .delete('/chat/conv-nonexistent')
      .set('Authorization', 'Bearer test-token');

    expect(del.status).toBe(404);
  });

  it('returns 409 for concurrent requests to same conversation', async () => {
    const slowEngine: AgentRunner = {
      async run() {
        await new Promise((r) => setTimeout(r, 100));
        return {
          status: 'success',
          result: 'slow-result',
          newSessionId: 'session-slow',
          lastAssistantUuid: 'uuid-slow',
        };
      },
    };
    const serverModule = await import('./server.js');
    const slowApp = serverModule.createServer(slowEngine);

    // Create a conversation first
    const create = await request(slowApp)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'create' });
    const convId = create.body.conversation_id;

    // Fire two requests concurrently
    const [r1, r2] = await Promise.all([
      request(slowApp)
        .post('/chat')
        .set('Authorization', 'Bearer test-token')
        .send({ message: 'first', conversation_id: convId }),
      request(slowApp)
        .post('/chat')
        .set('Authorization', 'Bearer test-token')
        .send({ message: 'second', conversation_id: convId }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it('returns X-Request-ID header on every response', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-request-id']).toMatch(/^req-/);
  });

  it('echoes caller-provided X-Request-ID', async () => {
    const response = await request(app)
      .get('/health')
      .set('X-Request-ID', 'caller-trace-42');
    expect(response.headers['x-request-id']).toBe('caller-trace-42');
  });

  it('returns X-Build-Version and X-Build-Commit headers', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-build-version']).toBeDefined();
    expect(response.headers['x-build-commit']).toBeDefined();
  });

  it('includes commit and build_time in health response', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('commit');
    expect(response.body).toHaveProperty('build_time');
  });

  it('streams thinking events when thinking=true and stream=true', async () => {
    const thinkingEngine: AgentRunner = {
      async run(_input, callbacksOrOnChunk) {
        const callbacks: StreamCallbacks =
          typeof callbacksOrOnChunk === 'function'
            ? { onChunk: callbacksOrOnChunk }
            : callbacksOrOnChunk || {};
        if (callbacks.onThinking) {
          await callbacks.onThinking('Let me think...');
          await callbacks.onThinking('about this');
        }
        if (callbacks.onChunk) {
          await callbacks.onChunk('The answer');
        }
        return {
          status: 'success',
          result: 'The answer',
          newSessionId: 'session-think',
          lastAssistantUuid: 'uuid-think',
        };
      },
    };
    const serverModule = await import('./server.js');
    const thinkApp = serverModule.createServer(thinkingEngine);

    const response = await request(thinkApp)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'test', stream: true, thinking: true });

    expect(response.status).toBe(200);
    const text = response.text;
    expect(text).toContain('event: thinking');
    expect(text).toContain('"text":"Let me think..."');
    expect(text).toContain('event: chunk');
    expect(text).toContain('event: done');
  });

  it('streams tool_use events when show_tool_use=true and stream=true', async () => {
    const toolEngine: AgentRunner = {
      async run(_input, callbacksOrOnChunk) {
        const callbacks: StreamCallbacks =
          typeof callbacksOrOnChunk === 'function'
            ? { onChunk: callbacksOrOnChunk }
            : callbacksOrOnChunk || {};
        if (callbacks.onToolUse) {
          await callbacks.onToolUse('WebSearch', { query: 'test' });
        }
        if (callbacks.onChunk) {
          await callbacks.onChunk('Search result');
        }
        return {
          status: 'success',
          result: 'Search result',
          newSessionId: 'session-tool',
          lastAssistantUuid: 'uuid-tool',
        };
      },
    };
    const serverModule = await import('./server.js');
    const toolApp = serverModule.createServer(toolEngine);

    const response = await request(toolApp)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'test', stream: true, show_tool_use: true });

    expect(response.status).toBe(200);
    const text = response.text;
    expect(text).toContain('event: tool_use');
    expect(text).toContain('"tool":"WebSearch"');
    expect(text).toContain('event: chunk');
    expect(text).toContain('event: done');
  });

  it('passes maxThinkingTokens to engine when thinking is enabled', async () => {
    let capturedInput: any;
    const captureEngine: AgentRunner = {
      async run(input) {
        capturedInput = input;
        return {
          status: 'success',
          result: 'ok',
          newSessionId: 'session-cap',
          lastAssistantUuid: 'uuid-cap',
        };
      },
    };
    const serverModule = await import('./server.js');
    const captureApp = serverModule.createServer(captureEngine);

    await request(captureApp)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'test', thinking: true, max_thinking_tokens: 5000 });

    expect(capturedInput.maxThinkingTokens).toBe(5000);
    expect(capturedInput.showToolUse).toBe(false);
  });

  it('passes mcp_servers to engine when provided in chat request', async () => {
    let capturedInput: any;
    const captureEngine: AgentRunner = {
      async run(input) {
        capturedInput = input;
        return {
          status: 'success',
          result: 'ok',
          newSessionId: 'session-mcp',
          lastAssistantUuid: 'uuid-mcp',
        };
      },
    };
    const serverModule = await import('./server.js');
    const captureApp = serverModule.createServer(captureEngine);

    await request(captureApp)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({
        message: 'use mcp',
        mcp_servers: {
          finance: {
            type: 'http',
            url: 'http://example.com/mcp',
          },
          analytics: {
            type: 'sse',
            url: 'http://example.com/sse',
            headers: { Authorization: 'Bearer tok' },
          },
        },
      });

    expect(capturedInput.mcpServers).toEqual({
      finance: { type: 'http', url: 'http://example.com/mcp' },
      analytics: {
        type: 'sse',
        url: 'http://example.com/sse',
        headers: { Authorization: 'Bearer tok' },
      },
    });
  });

  it('ignores invalid mcp_servers entries', async () => {
    let capturedInput: any;
    const captureEngine: AgentRunner = {
      async run(input) {
        capturedInput = input;
        return {
          status: 'success',
          result: 'ok',
          newSessionId: 'session-mcp2',
          lastAssistantUuid: 'uuid-mcp2',
        };
      },
    };
    const serverModule = await import('./server.js');
    const captureApp = serverModule.createServer(captureEngine);

    await request(captureApp)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({
        message: 'test invalid',
        mcp_servers: {
          bad1: { type: 'http' },
          bad2: 'not-an-object',
          good: { type: 'http', url: 'http://valid.com/mcp' },
        },
      });

    expect(capturedInput.mcpServers).toEqual({
      good: { type: 'http', url: 'http://valid.com/mcp' },
    });
  });

  it('rejects reserved name picoclaw with warning', async () => {
    let capturedInput: any;
    const captureEngine: AgentRunner = {
      async run(input) {
        capturedInput = input;
        return {
          status: 'success',
          result: 'ok',
          newSessionId: 'session-rsv',
          lastAssistantUuid: 'uuid-rsv',
        };
      },
    };
    const serverModule = await import('./server.js');
    const captureApp = serverModule.createServer(captureEngine);

    const response = await request(captureApp)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({
        message: 'test reserved',
        mcp_servers: {
          picoclaw: { type: 'http', url: 'http://evil.com' },
          good: { type: 'http', url: 'http://valid.com/mcp' },
        },
      });

    expect(response.status).toBe(200);
    expect(capturedInput.mcpServers).toEqual({
      good: { type: 'http', url: 'http://valid.com/mcp' },
    });
    expect(response.body.warnings).toBeDefined();
    expect(response.body.warnings).toContainEqual(
      expect.stringContaining('picoclaw'),
    );
  });

  it('returns warnings for invalid mcp_servers entries', async () => {
    let capturedInput: any;
    const captureEngine: AgentRunner = {
      async run(input) {
        capturedInput = input;
        return {
          status: 'success',
          result: 'ok',
          newSessionId: 'session-warn',
          lastAssistantUuid: 'uuid-warn',
        };
      },
    };
    const serverModule = await import('./server.js');
    const captureApp = serverModule.createServer(captureEngine);

    const response = await request(captureApp)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({
        message: 'test warnings',
        mcp_servers: {
          bad1: { type: 'http' },
          good: { type: 'http', url: 'http://valid.com/mcp' },
        },
      });

    expect(response.status).toBe(200);
    expect(capturedInput.mcpServers).toEqual({
      good: { type: 'http', url: 'http://valid.com/mcp' },
    });
    expect(response.body.warnings).toBeDefined();
    expect(response.body.warnings).toContainEqual(
      expect.stringContaining('bad1'),
    );
  });

  it('omits warnings when all mcp_servers are valid', async () => {
    let capturedInput: any;
    const captureEngine: AgentRunner = {
      async run(input) {
        capturedInput = input;
        return {
          status: 'success',
          result: 'ok',
          newSessionId: 'session-nowarn',
          lastAssistantUuid: 'uuid-nowarn',
        };
      },
    };
    const serverModule = await import('./server.js');
    const captureApp = serverModule.createServer(captureEngine);

    const response = await request(captureApp)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({
        message: 'test no warnings',
        mcp_servers: {
          finance: { type: 'http', url: 'http://example.com/mcp' },
        },
      });

    expect(response.status).toBe(200);
    expect(capturedInput.mcpServers).toEqual({
      finance: { type: 'http', url: 'http://example.com/mcp' },
    });
    expect(response.body).not.toHaveProperty('warnings');
  });

  it('includes usage metrics in chat response when engine returns them', async () => {
    const usageEngine: AgentRunner = {
      async run() {
        return {
          status: 'success',
          result: 'answer',
          newSessionId: 'session-u',
          lastAssistantUuid: 'uuid-u',
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            totalCostUsd: 0.003,
            numTurns: 2,
            durationApiMs: 1500,
          },
        };
      },
    };
    const serverModule = await import('./server.js');
    const usageApp = serverModule.createServer(usageEngine);

    const response = await request(usageApp)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'test' });

    expect(response.status).toBe(200);
    expect(response.body.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalCostUsd: 0.003,
      numTurns: 2,
      durationApiMs: 1500,
    });
  });

  it('omits usage from response when engine does not return it', async () => {
    const response = await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'no usage' });

    expect(response.status).toBe(200);
    expect(response.body).not.toHaveProperty('usage');
  });

  it('does not pass mcpServers when mcp_servers is omitted', async () => {
    let capturedInput: any;
    const captureEngine: AgentRunner = {
      async run(input) {
        capturedInput = input;
        return {
          status: 'success',
          result: 'ok',
          newSessionId: 'session-none',
          lastAssistantUuid: 'uuid-none',
        };
      },
    };
    const serverModule = await import('./server.js');
    const captureApp = serverModule.createServer(captureEngine);

    await request(captureApp)
      .post('/chat')
      .set('Authorization', 'Bearer test-token')
      .send({ message: 'no mcp' });

    expect(capturedInput.mcpServers).toBeUndefined();
  });

  it('accepts stop request and invokes shutdown callback', async () => {
    const response = await request(app)
      .post('/control/stop')
      .set('Authorization', 'Bearer test-token')
      .send({ reason: 'unit-test' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('stopping');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stopSpy).toHaveBeenCalledWith('unit-test');
  });
});

describe('http server (auth-free mode)', () => {
  let closeDatabase: (() => void) | undefined;
  let resetDatabase: (() => void) | undefined;
  let app: import('express').Express;

  beforeEach(async () => {
    vi.resetModules();
    delete process.env.API_TOKEN;

    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picoclaw-noauth-'));

    const dbModule = await import('./db.js');
    dbModule.initDatabase({
      persistentDbPath: path.join(rootDir, 'store', 'messages.db'),
      localDbPath: path.join(rootDir, 'tmp', 'messages.db'),
      forceReinitialize: true,
    });

    closeDatabase = dbModule.closeDatabase;
    resetDatabase = dbModule._resetDatabaseForTests;

    const serverModule = await import('./server.js');
    app = serverModule.createServer(makeFakeEngine());
  });

  afterEach(() => {
    closeDatabase?.();
    resetDatabase?.();
  });

  it('allows chat requests without Authorization header', async () => {
    const response = await request(app)
      .post('/chat')
      .send({ message: 'hello from auth-free' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(response.body.conversation_id).toMatch(/^conv-/);
  });

  it('allows task creation without Authorization header', async () => {
    const response = await request(app).post('/task').send({
      prompt: 'do work',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
    });

    expect(response.status).toBe(201);
    expect(response.body.id).toMatch(/^task-/);
  });

  it('allows control/stop without Authorization header', async () => {
    const stopSpy = vi.fn();
    const serverModule = await import('./server.js');
    const stopApp = serverModule.createServer(makeFakeEngine(), {
      onStop: stopSpy,
    });

    const response = await request(stopApp)
      .post('/control/stop')
      .send({ reason: 'auth-free-test' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('stopping');
  });

  it('still allows requests with Authorization header (ignored)', async () => {
    const response = await request(app)
      .post('/chat')
      .set('Authorization', 'Bearer any-token-is-fine')
      .send({ message: 'hello with optional token' });

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
  });
});
