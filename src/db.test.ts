import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetDatabaseForTests,
  cleanupStaleData,
  closeDatabase,
  consumeOutboundMessages,
  createConversation,
  deleteConversation,
  getConversation,
  getDatabase,
  initDatabase,
  logTaskRun,
  createTask,
  queueOutboundMessage,
  storeConversationMessage,
  getPromptMessages,
  syncDatabaseToVolume,
} from './db.js';

function createTempPaths(): {
  rootDir: string;
  persistentPath: string;
  localPath: string;
} {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picoclaw-db-'));
  return {
    rootDir,
    persistentPath: path.join(rootDir, 'store', 'messages.db'),
    localPath: path.join(rootDir, 'tmp', 'messages.db'),
  };
}

afterEach(() => {
  closeDatabase();
  _resetDatabaseForTests();
});

describe('db', () => {
  it('stores conversation messages and renders prompt history', () => {
    const paths = createTempPaths();
    initDatabase({
      persistentDbPath: paths.persistentPath,
      localDbPath: paths.localPath,
      forceReinitialize: true,
    });

    createConversation('conv-1');
    storeConversationMessage({
      id: 'msg-1',
      conversationId: 'conv-1',
      role: 'user',
      sender: 'u1',
      senderName: 'User 1',
      content: 'hello',
      createdAt: '2026-03-08T10:00:00.000Z',
    });

    const promptMessages = getPromptMessages('conv-1');
    expect(promptMessages).toHaveLength(1);
    expect(promptMessages[0]).toMatchObject({
      id: 'msg-1',
      sender_name: 'User 1',
      content: 'hello',
    });
  });

  it('consumes outbound messages only once', () => {
    const paths = createTempPaths();
    initDatabase({
      persistentDbPath: paths.persistentPath,
      localDbPath: paths.localPath,
      forceReinitialize: true,
    });

    createConversation('conv-2');
    queueOutboundMessage('conv-2', 'first');
    queueOutboundMessage('conv-2', 'second');

    const firstRead = consumeOutboundMessages('conv-2');
    expect(firstRead.map((item) => item.text)).toEqual(['first', 'second']);

    const secondRead = consumeOutboundMessages('conv-2');
    expect(secondRead).toEqual([]);
  });

  it('syncs local db to persistent volume path', () => {
    const paths = createTempPaths();
    initDatabase({
      persistentDbPath: paths.persistentPath,
      localDbPath: paths.localPath,
      forceReinitialize: true,
    });

    createConversation('conv-3');
    syncDatabaseToVolume();

    expect(fs.existsSync(paths.persistentPath)).toBe(true);
  });

  it('cleans up delivered outbound messages older than 7 days', () => {
    const paths = createTempPaths();
    initDatabase({
      persistentDbPath: paths.persistentPath,
      localDbPath: paths.localPath,
      forceReinitialize: true,
    });

    createConversation('conv-cleanup');
    const db = getDatabase();

    // Insert old delivered message (10 days ago)
    db.prepare(
      `INSERT INTO outbound_messages (conversation_id, text, sender, created_at, delivered)
       VALUES (?, ?, ?, datetime('now', '-10 days'), 1)`,
    ).run('conv-cleanup', 'old-msg', null);

    // Insert recent delivered message (1 day ago)
    db.prepare(
      `INSERT INTO outbound_messages (conversation_id, text, sender, created_at, delivered)
       VALUES (?, ?, ?, datetime('now', '-1 days'), 1)`,
    ).run('conv-cleanup', 'recent-msg', null);

    // Insert old undelivered message (10 days ago) — should NOT be deleted
    db.prepare(
      `INSERT INTO outbound_messages (conversation_id, text, sender, created_at, delivered)
       VALUES (?, ?, ?, datetime('now', '-10 days'), 0)`,
    ).run('conv-cleanup', 'undelivered-msg', null);

    cleanupStaleData();

    const remaining = db
      .prepare(
        'SELECT text FROM outbound_messages WHERE conversation_id = ? ORDER BY text',
      )
      .all('conv-cleanup') as Array<{ text: string }>;

    expect(remaining.map((r) => r.text)).toEqual([
      'recent-msg',
      'undelivered-msg',
    ]);
  });

  it('retains only 100 most recent task_run_logs per task', () => {
    const paths = createTempPaths();
    initDatabase({
      persistentDbPath: paths.persistentPath,
      localDbPath: paths.localPath,
      forceReinitialize: true,
    });

    createConversation('conv-logs');
    createTask({
      id: 'task-logs',
      conversation_id: 'conv-logs',
      prompt: 'test',
      schedule_type: 'interval',
      schedule_value: '60000',
      context_mode: 'isolated',
      next_run: new Date().toISOString(),
      status: 'active',
      created_at: new Date().toISOString(),
    });

    // Insert 110 logs
    for (let i = 0; i < 110; i++) {
      const ts = new Date(Date.now() + i * 1000).toISOString();
      logTaskRun({
        task_id: 'task-logs',
        run_at: ts,
        duration_ms: 100,
        status: 'success',
        result: `log-${i}`,
        error: null,
      });
    }

    const db = getDatabase();
    const beforeCount = (
      db
        .prepare('SELECT COUNT(*) as cnt FROM task_run_logs WHERE task_id = ?')
        .get('task-logs') as { cnt: number }
    ).cnt;
    expect(beforeCount).toBe(110);

    cleanupStaleData();

    const afterCount = (
      db
        .prepare('SELECT COUNT(*) as cnt FROM task_run_logs WHERE task_id = ?')
        .get('task-logs') as { cnt: number }
    ).cnt;
    expect(afterCount).toBe(100);

    // Verify most recent logs survived (the ones with highest run_at)
    const oldest = db
      .prepare(
        'SELECT result FROM task_run_logs WHERE task_id = ? ORDER BY run_at ASC LIMIT 1',
      )
      .get('task-logs') as { result: string };
    expect(oldest.result).toBe('log-10');
  });

  it('deletes a conversation and cascades to related data', () => {
    const paths = createTempPaths();
    initDatabase({
      persistentDbPath: paths.persistentPath,
      localDbPath: paths.localPath,
      forceReinitialize: true,
    });

    createConversation('conv-del');
    storeConversationMessage({
      id: 'msg-del-1',
      conversationId: 'conv-del',
      role: 'user',
      content: 'hello',
    });

    expect(deleteConversation('conv-del')).toBe(true);
    expect(getConversation('conv-del')).toBeUndefined();

    // Non-existent returns false
    expect(deleteConversation('conv-nonexistent')).toBe(false);
  });
});
