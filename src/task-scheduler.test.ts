import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { AgentRunner } from './agent-engine.js';
import {
  _resetDatabaseForTests,
  closeDatabase,
  consumeOutboundMessages,
  createConversation,
  createTask,
  getConversation,
  getTaskById,
  initDatabase,
  queueOutboundMessage,
} from './db.js';
import {
  computeInitialNextRun,
  computeNextRun,
  runTask,
} from './task-scheduler.js';

function setupDb(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'picoclaw-scheduler-'));
  initDatabase({
    persistentDbPath: path.join(root, 'store', 'messages.db'),
    localDbPath: path.join(root, 'tmp', 'messages.db'),
    forceReinitialize: true,
  });
}

afterEach(() => {
  closeDatabase();
  _resetDatabaseForTests();
});

describe('task scheduler', () => {
  it('computes initial next_run for interval schedules', () => {
    const now = new Date('2026-03-08T00:00:00.000Z');
    const next = computeInitialNextRun('interval', '60000', now);
    expect(next).toBe('2026-03-08T00:01:00.000Z');
  });

  it('skips missed interval windows when computing next run', () => {
    const now = new Date('2026-03-08T00:10:00.000Z');
    const next = computeNextRun(
      {
        id: 'task-1',
        conversation_id: 'conv-1',
        prompt: 'hello',
        schedule_type: 'interval',
        schedule_value: '60000',
        context_mode: 'isolated',
        next_run: '2026-03-08T00:00:00.000Z',
        last_run: null,
        last_result: null,
        status: 'active',
        created_at: now.toISOString(),
      },
      now,
    );

    expect(next).toBe('2026-03-08T00:11:00.000Z');
  });

  it('runs task and updates conversation session for group mode', async () => {
    setupDb();
    createConversation('conv-123');

    createTask({
      id: 'task-group',
      conversation_id: 'conv-123',
      prompt: 'do work',
      schedule_type: 'once',
      schedule_value: '2026-03-09T10:00:00',
      context_mode: 'group',
      next_run: '2026-03-09T02:00:00.000Z',
      status: 'active',
      created_at: '2026-03-08T00:00:00.000Z',
    });

    const fakeEngine: AgentRunner = {
      async run() {
        return {
          status: 'success',
          result: 'task result',
          newSessionId: 'session-1',
          lastAssistantUuid: 'assistant-1',
        };
      },
    };

    const task = getTaskById('task-group');
    if (!task) {
      throw new Error('task not found');
    }

    const result = await runTask(task, fakeEngine);
    expect(result.status).toBe('success');

    const updatedTask = getTaskById('task-group');
    expect(updatedTask?.status).toBe('completed');

    const conversation = getConversation('conv-123');
    expect(conversation?.session_id).toBe('session-1');
    expect(conversation?.last_assistant_uuid).toBe('assistant-1');
  });

  it('creates isolated runtime conversation for MCP outbound messages', async () => {
    setupDb();
    createConversation('conv-root');

    createTask({
      id: 'task-isolated',
      conversation_id: 'conv-root',
      prompt: 'do isolated work',
      schedule_type: 'once',
      schedule_value: '2026-03-09T10:00:00',
      context_mode: 'isolated',
      next_run: '2026-03-09T02:00:00.000Z',
      status: 'active',
      created_at: '2026-03-08T00:00:00.000Z',
    });

    let runtimeConversationId: string | undefined;
    const fakeEngine: AgentRunner = {
      async run(input) {
        runtimeConversationId = input.conversationId;
        queueOutboundMessage(input.conversationId, 'task ping', 'task-agent');
        return {
          status: 'success',
          result: null,
        };
      },
    };

    const task = getTaskById('task-isolated');
    if (!task) {
      throw new Error('task not found');
    }

    const result = await runTask(task, fakeEngine);
    expect(result.status).toBe('success');
    expect(runtimeConversationId).toMatch(/^task-task-isolated-/);

    const conversation = getConversation(runtimeConversationId!);
    expect(conversation?.id).toBe(runtimeConversationId);

    const outbound = consumeOutboundMessages(runtimeConversationId!);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.text).toBe('task ping');
  });
});
