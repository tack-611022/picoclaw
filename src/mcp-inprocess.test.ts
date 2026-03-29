import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initDatabase, closeDatabase, getDatabase } from './db.js';
import { createPicoClawMcpServer } from './mcp-inprocess.js';

describe('createPicoClawMcpServer', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'picoclaw-mcp-test-'));
    const localDb = path.join(tmpDir, 'local.db');
    const persistentDb = path.join(tmpDir, 'persistent.db');
    initDatabase({
      localDbPath: localDb,
      persistentDbPath: persistentDb,
      forceReinitialize: true,
    });
    // Create a test conversation for FK constraints
    getDatabase()
      .prepare(
        `INSERT INTO conversations (id, created_at, last_activity, message_count, status)
         VALUES ('conv-test', ?, ?, 0, 'idle')`,
      )
      .run(new Date().toISOString(), new Date().toISOString());
  });

  afterEach(() => {
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a McpSdkServerConfigWithInstance', () => {
    const config = createPicoClawMcpServer('conv-test', true);
    expect(config).toBeDefined();
    expect(config.type).toBe('sdk');
    expect(config.name).toBe('picoclaw');
    expect(config.instance).toBeDefined();
  });

  it('creates a new server for each call (per-request isolation)', () => {
    const a = createPicoClawMcpServer('conv-a', true);
    const b = createPicoClawMcpServer('conv-b', true);
    expect(a.instance).not.toBe(b.instance);
  });
});
