import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import {
  LOCAL_DB_PATH,
  OUTBOUND_TTL_DAYS,
  STORE_DIR,
  TASK_LOG_RETENTION,
} from './config.js';
import {
  Conversation,
  ConversationMessage,
  OutboundMessage,
  PromptMessage,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

interface DatabasePaths {
  persistentDbPath: string;
  localDbPath: string;
}

export interface DatabaseInitOptions {
  persistentDbPath?: string;
  localDbPath?: string;
  forceReinitialize?: boolean;
}

let db: Database.Database | null = null;
let dbPaths: DatabasePaths = {
  persistentDbPath: path.join(STORE_DIR, 'messages.db'),
  localDbPath: LOCAL_DB_PATH,
};

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      last_assistant_uuid TEXT,
      created_at TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'idle'
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      sender TEXT,
      sender_name TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation_time
      ON messages(conversation_id, created_at);

    CREATE TABLE IF NOT EXISTS outbound_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      text TEXT NOT NULL,
      sender TEXT,
      created_at TEXT NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_outbound_conversation_delivery
      ON outbound_messages(conversation_id, delivered, created_at);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT NOT NULL DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_next_run
      ON scheduled_tasks(status, next_run);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs
      ON task_run_logs(task_id, run_at);
  `);
}

function getNowIso(): string {
  return new Date().toISOString();
}

function getDbOrThrow(): Database.Database {
  if (!db) {
    throw new Error('Database is not initialized. Call initDatabase() first.');
  }
  return db;
}

function withTransaction<T>(fn: (database: Database.Database) => T): T {
  const database = getDbOrThrow();
  const tx = database.transaction(() => fn(database));
  return tx();
}

export function getDatabase(): Database.Database {
  return getDbOrThrow();
}

export function getLocalDatabasePath(): string {
  return dbPaths.localDbPath;
}

export function initDatabase(options: DatabaseInitOptions = {}): void {
  if (
    db &&
    !options.forceReinitialize &&
    !options.persistentDbPath &&
    !options.localDbPath
  ) {
    return;
  }

  if (db && options.forceReinitialize) {
    db.close();
    db = null;
  }

  if (options.persistentDbPath) {
    dbPaths.persistentDbPath = options.persistentDbPath;
  }
  if (options.localDbPath) {
    dbPaths.localDbPath = options.localDbPath;
  }

  const persistentDir = path.dirname(dbPaths.persistentDbPath);
  const localDir = path.dirname(dbPaths.localDbPath);
  fs.mkdirSync(persistentDir, { recursive: true });
  fs.mkdirSync(localDir, { recursive: true });

  if (fs.existsSync(dbPaths.persistentDbPath)) {
    fs.copyFileSync(dbPaths.persistentDbPath, dbPaths.localDbPath);
  }

  db = new Database(dbPaths.localDbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  createSchema(db);
}

export function cleanupStaleData(): void {
  if (!db) return;

  // Remove delivered outbound messages older than OUTBOUND_TTL_DAYS
  db.prepare(
    `DELETE FROM outbound_messages
     WHERE delivered = 1
       AND created_at < datetime('now', '-' || ? || ' days')`,
  ).run(OUTBOUND_TTL_DAYS);

  // Keep only TASK_LOG_RETENTION most recent logs per task
  const taskIds = db
    .prepare(
      `SELECT DISTINCT task_id FROM task_run_logs
       GROUP BY task_id HAVING COUNT(*) > ?`,
    )
    .all(TASK_LOG_RETENTION) as Array<{ task_id: string }>;

  const deleteStmt = db.prepare(
    `DELETE FROM task_run_logs
     WHERE task_id = ?
       AND id NOT IN (
         SELECT id FROM task_run_logs
         WHERE task_id = ?
         ORDER BY run_at DESC
         LIMIT ?
       )`,
  );

  for (const { task_id } of taskIds) {
    deleteStmt.run(task_id, task_id, TASK_LOG_RETENTION);
  }
}

export function syncDatabaseToVolume(): void {
  if (!db) return;
  cleanupStaleData();
  db.pragma('wal_checkpoint(TRUNCATE)');
  fs.mkdirSync(path.dirname(dbPaths.persistentDbPath), { recursive: true });
  fs.copyFileSync(dbPaths.localDbPath, dbPaths.persistentDbPath);
}

export interface DatabaseHealth {
  ok: boolean;
  conversations: number;
  tasks: number;
}

export function getDatabaseHealth(): DatabaseHealth {
  try {
    const database = getDbOrThrow();
    const { conversations } = database
      .prepare('SELECT COUNT(*) AS conversations FROM conversations')
      .get() as { conversations: number };
    const { tasks } = database
      .prepare('SELECT COUNT(*) AS tasks FROM scheduled_tasks')
      .get() as { tasks: number };
    return { ok: true, conversations, tasks };
  } catch {
    return { ok: false, conversations: 0, tasks: 0 };
  }
}

export function closeDatabase(): void {
  if (!db) return;
  db.close();
  db = null;
}

export function _resetDatabaseForTests(): void {
  closeDatabase();
  dbPaths = {
    persistentDbPath: path.join(STORE_DIR, 'messages.db'),
    localDbPath: LOCAL_DB_PATH,
  };
}

function mapConversation(row: {
  id: string;
  session_id: string | null;
  last_assistant_uuid: string | null;
  created_at: string;
  last_activity: string;
  message_count: number;
  status: string;
}): Conversation {
  return {
    id: row.id,
    session_id: row.session_id ?? undefined,
    last_assistant_uuid: row.last_assistant_uuid ?? undefined,
    created_at: row.created_at,
    last_activity: row.last_activity,
    message_count: row.message_count,
    status: row.status === 'running' ? 'running' : 'idle',
  };
}

export function createConversation(conversationId: string): Conversation {
  const now = getNowIso();
  const database = getDbOrThrow();
  database
    .prepare(
      `
      INSERT INTO conversations (id, created_at, last_activity, message_count, status)
      VALUES (?, ?, ?, 0, 'idle')
      ON CONFLICT(id) DO NOTHING
    `,
    )
    .run(conversationId, now, now);

  const row = database
    .prepare(
      `
      SELECT id, session_id, last_assistant_uuid, created_at, last_activity, message_count, status
      FROM conversations
      WHERE id = ?
    `,
    )
    .get(conversationId) as
    | {
        id: string;
        session_id: string | null;
        last_assistant_uuid: string | null;
        created_at: string;
        last_activity: string;
        message_count: number;
        status: string;
      }
    | undefined;

  if (!row) {
    throw new Error(`Failed to create conversation ${conversationId}`);
  }

  return mapConversation(row);
}

export function getConversation(
  conversationId: string,
): Conversation | undefined {
  const row = getDbOrThrow()
    .prepare(
      `
      SELECT id, session_id, last_assistant_uuid, created_at, last_activity, message_count, status
      FROM conversations
      WHERE id = ?
    `,
    )
    .get(conversationId) as
    | {
        id: string;
        session_id: string | null;
        last_assistant_uuid: string | null;
        created_at: string;
        last_activity: string;
        message_count: number;
        status: string;
      }
    | undefined;

  return row ? mapConversation(row) : undefined;
}

export function ensureConversation(conversationId: string): Conversation {
  return getConversation(conversationId) || createConversation(conversationId);
}

export function getAllConversations(): Conversation[] {
  const rows = getDbOrThrow()
    .prepare(
      `
      SELECT id, session_id, last_assistant_uuid, created_at, last_activity, message_count, status
      FROM conversations
      ORDER BY last_activity DESC
    `,
    )
    .all() as Array<{
    id: string;
    session_id: string | null;
    last_assistant_uuid: string | null;
    created_at: string;
    last_activity: string;
    message_count: number;
    status: string;
  }>;

  return rows.map(mapConversation);
}

export function deleteConversation(conversationId: string): boolean {
  const conversation = getConversation(conversationId);
  if (!conversation) {
    return false;
  }
  // CASCADE deletes messages, outbound_messages, and scheduled_tasks (+ task_run_logs)
  getDbOrThrow()
    .prepare('DELETE FROM conversations WHERE id = ?')
    .run(conversationId);
  return true;
}

export function setConversationStatus(
  conversationId: string,
  status: 'idle' | 'running',
): void {
  const now = getNowIso();
  getDbOrThrow()
    .prepare(
      `
      UPDATE conversations
      SET status = ?, last_activity = ?
      WHERE id = ?
    `,
    )
    .run(status, now, conversationId);
}

export function updateConversationSession(
  conversationId: string,
  sessionId?: string,
  lastAssistantUuid?: string,
): void {
  const now = getNowIso();
  getDbOrThrow()
    .prepare(
      `
      UPDATE conversations
      SET
        session_id = COALESCE(?, session_id),
        last_assistant_uuid = COALESCE(?, last_assistant_uuid),
        last_activity = ?
      WHERE id = ?
    `,
    )
    .run(sessionId ?? null, lastAssistantUuid ?? null, now, conversationId);
}

interface StoreMessageInput {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  sender?: string;
  senderName?: string;
  content: string;
  createdAt?: string;
}

export function storeConversationMessage(
  input: StoreMessageInput,
): ConversationMessage {
  const createdAt = input.createdAt || getNowIso();

  withTransaction((database) => {
    database
      .prepare(
        `
        INSERT INTO messages (id, conversation_id, role, sender, sender_name, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        input.id,
        input.conversationId,
        input.role,
        input.sender || null,
        input.senderName || null,
        input.content,
        createdAt,
      );

    database
      .prepare(
        `
        UPDATE conversations
        SET
          message_count = message_count + 1,
          last_activity = ?,
          status = 'idle'
        WHERE id = ?
      `,
      )
      .run(createdAt, input.conversationId);
  });

  return {
    id: input.id,
    conversation_id: input.conversationId,
    role: input.role,
    sender: input.sender || null,
    sender_name: input.senderName || null,
    content: input.content,
    created_at: createdAt,
  };
}

export function getConversationMessages(
  conversationId: string,
): ConversationMessage[] {
  return getDbOrThrow()
    .prepare(
      `
      SELECT id, conversation_id, role, sender, sender_name, content, created_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `,
    )
    .all(conversationId) as ConversationMessage[];
}

export function getPromptMessages(conversationId: string): PromptMessage[] {
  return getDbOrThrow()
    .prepare(
      `
      SELECT id,
             COALESCE(sender, role) AS sender,
             COALESCE(sender_name, sender, role) AS sender_name,
             content,
             created_at AS timestamp
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC
    `,
    )
    .all(conversationId) as PromptMessage[];
}

export function queueOutboundMessage(
  conversationId: string,
  text: string,
  sender?: string,
): void {
  getDbOrThrow()
    .prepare(
      `
      INSERT INTO outbound_messages (conversation_id, text, sender, created_at, delivered)
      VALUES (?, ?, ?, ?, 0)
    `,
    )
    .run(conversationId, text, sender || null, getNowIso());
}

export function consumeOutboundMessages(
  conversationId: string,
): OutboundMessage[] {
  return withTransaction((database) => {
    const rows = database
      .prepare(
        `
        SELECT id, conversation_id, text, sender, created_at
        FROM outbound_messages
        WHERE conversation_id = ? AND delivered = 0
        ORDER BY created_at ASC
      `,
      )
      .all(conversationId) as OutboundMessage[];

    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    database
      .prepare(
        `UPDATE outbound_messages SET delivered = 1 WHERE id IN (${placeholders})`,
      )
      .run(...ids);

    return rows;
  });
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  getDbOrThrow()
    .prepare(
      `
      INSERT INTO scheduled_tasks (
        id,
        conversation_id,
        prompt,
        schedule_type,
        schedule_value,
        context_mode,
        next_run,
        status,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      task.id,
      task.conversation_id,
      task.prompt,
      task.schedule_type,
      task.schedule_value,
      task.context_mode,
      task.next_run,
      task.status,
      task.created_at,
    );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return getDbOrThrow()
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as ScheduledTask | undefined;
}

export function getAllTasks(): ScheduledTask[] {
  return getDbOrThrow()
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function getDueTasks(): ScheduledTask[] {
  const now = getNowIso();
  return getDbOrThrow()
    .prepare(
      `
      SELECT *
      FROM scheduled_tasks
      WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
      ORDER BY next_run ASC
    `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTask(
  taskId: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'schedule_type'
      | 'schedule_value'
      | 'context_mode'
      | 'next_run'
      | 'status'
      | 'conversation_id'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.context_mode !== undefined) {
    fields.push('context_mode = ?');
    values.push(updates.context_mode);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }
  if (updates.conversation_id !== undefined) {
    fields.push('conversation_id = ?');
    values.push(updates.conversation_id);
  }

  if (fields.length === 0) {
    return;
  }

  values.push(taskId);
  getDbOrThrow()
    .prepare(`UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`)
    .run(...values);
}

export function updateTaskAfterRun(
  taskId: string,
  nextRun: string | null,
  lastResult: string,
  status: 'active' | 'completed' = 'active',
): void {
  const nextStatus = nextRun === null ? 'completed' : status;
  getDbOrThrow()
    .prepare(
      `
      UPDATE scheduled_tasks
      SET
        next_run = ?,
        last_run = ?,
        last_result = ?,
        status = ?
      WHERE id = ?
    `,
    )
    .run(nextRun, getNowIso(), lastResult, nextStatus, taskId);
}

export function deleteTask(taskId: string): void {
  withTransaction((database) => {
    database.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(taskId);
    database.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(taskId);
  });
}

export function logTaskRun(log: TaskRunLog): void {
  getDbOrThrow()
    .prepare(
      `
      INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      log.task_id,
      log.run_at,
      log.duration_ms,
      log.status,
      log.result,
      log.error,
    );
}
