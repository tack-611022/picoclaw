import Database from 'better-sqlite3';
import { CronExpressionParser } from 'cron-parser';
import { randomUUID } from 'crypto';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const conversationId =
  process.env.PICOCLAW_CONVERSATION_ID ||
  process.env.NANOCLAW_CONVERSATION_ID ||
  'default';
const dbPath =
  process.env.PICOCLAW_DB_PATH ||
  process.env.NANOCLAW_DB_PATH ||
  '/tmp/messages.db';
const isMain =
  (process.env.PICOCLAW_IS_MAIN || process.env.NANOCLAW_IS_MAIN) === '1';
const timezone =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

const db = new Database(dbPath, { readonly: false });
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

function validateTaskOwnership(taskId: string): boolean {
  if (isMain) {
    return true;
  }

  const row = db
    .prepare('SELECT conversation_id FROM scheduled_tasks WHERE id = ?')
    .get(taskId) as { conversation_id: string } | undefined;

  if (!row) {
    return false;
  }

  return row.conversation_id === conversationId;
}

function ensureConversationExists(id: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO conversations (id, created_at, last_activity, message_count, status)
      VALUES (?, ?, ?, 0, 'idle')
      ON CONFLICT(id) DO NOTHING
    `,
  ).run(id, now, now);
}

function computeNextRun(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
): string | null {
  if (scheduleType === 'once') {
    if (/[Zz]$/.test(scheduleValue) || /[+-]\d{2}:\d{2}$/.test(scheduleValue)) {
      throw new Error(
        'once schedule must be local timestamp without timezone suffix',
      );
    }
    const date = new Date(scheduleValue);
    if (Number.isNaN(date.getTime())) {
      throw new Error('Invalid once schedule timestamp');
    }
    return date.toISOString();
  }

  if (scheduleType === 'cron') {
    const expression = CronExpressionParser.parse(scheduleValue, {
      tz: timezone,
    });
    return expression.next().toISOString();
  }

  const intervalMs = Number.parseInt(scheduleValue, 10);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(
      'interval schedule must be a positive integer in milliseconds',
    );
  }

  return new Date(Date.now() + intervalMs).toISOString();
}

const server = new McpServer({
  name: 'picoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  'Queue a message for delivery back to the HTTP caller while the agent is still running.',
  {
    text: z.string().describe('Message content'),
    sender: z.string().optional().describe('Optional sender alias'),
  },
  async (args) => {
    db.prepare(
      `
      INSERT INTO outbound_messages (conversation_id, text, sender, created_at, delivered)
      VALUES (?, ?, ?, ?, 0)
    `,
    ).run(
      conversationId,
      args.text,
      args.sender || null,
      new Date().toISOString(),
    );

    return {
      content: [{ type: 'text' as const, text: 'Message queued.' }],
    };
  },
);

server.tool(
  'schedule_task',
  'Create a scheduled task for follow-up execution.',
  {
    prompt: z.string().describe('Prompt to run when task executes'),
    schedule_type: z.enum(['cron', 'interval', 'once']),
    schedule_value: z.string(),
    context_mode: z.enum(['group', 'isolated']).default('isolated'),
    target_conversation_id: z.string().optional(),
  },
  async (args) => {
    try {
      const taskId = `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
      const targetConversation = args.target_conversation_id || conversationId;
      const nextRun = computeNextRun(args.schedule_type, args.schedule_value);

      ensureConversationExists(targetConversation);

      db.prepare(
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
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
        `,
      ).run(
        taskId,
        targetConversation,
        args.prompt,
        args.schedule_type,
        args.schedule_value,
        args.context_mode,
        nextRun,
        new Date().toISOString(),
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: `Task created: ${taskId}`,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: message }],
        isError: true,
      };
    }
  },
);

server.tool('list_tasks', 'List scheduled tasks.', {}, async () => {
  const rows = isMain
    ? (db
        .prepare(
          'SELECT id, conversation_id, schedule_type, schedule_value, status, next_run FROM scheduled_tasks ORDER BY created_at DESC',
        )
        .all() as Array<{
        id: string;
        conversation_id: string;
        schedule_type: string;
        schedule_value: string;
        status: string;
        next_run: string | null;
      }>)
    : (db
        .prepare(
          `
            SELECT id, conversation_id, schedule_type, schedule_value, status, next_run
            FROM scheduled_tasks
            WHERE conversation_id = ?
            ORDER BY created_at DESC
          `,
        )
        .all(conversationId) as Array<{
        id: string;
        conversation_id: string;
        schedule_type: string;
        schedule_value: string;
        status: string;
        next_run: string | null;
      }>);

  if (rows.length === 0) {
    return { content: [{ type: 'text' as const, text: 'No tasks found.' }] };
  }

  const text = rows
    .map(
      (row) =>
        `- ${row.id} (${row.schedule_type}: ${row.schedule_value}) [${row.status}] next=${row.next_run || 'n/a'} conv=${row.conversation_id}`,
    )
    .join('\n');

  return { content: [{ type: 'text' as const, text }] };
});

server.tool(
  'pause_task',
  'Pause a task.',
  { task_id: z.string() },
  async ({ task_id }) => {
    if (!validateTaskOwnership(task_id)) {
      return {
        content: [
          { type: 'text' as const, text: 'Task not found or access denied.' },
        ],
        isError: true,
      };
    }

    db.prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?').run(
      'paused',
      task_id,
    );

    return {
      content: [{ type: 'text' as const, text: `Task ${task_id} paused.` }],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string() },
  async ({ task_id }) => {
    if (!validateTaskOwnership(task_id)) {
      return {
        content: [
          { type: 'text' as const, text: 'Task not found or access denied.' },
        ],
        isError: true,
      };
    }

    db.prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?').run(
      'active',
      task_id,
    );

    return {
      content: [{ type: 'text' as const, text: `Task ${task_id} resumed.` }],
    };
  },
);

server.tool(
  'cancel_task',
  'Delete a task.',
  { task_id: z.string() },
  async ({ task_id }) => {
    if (!validateTaskOwnership(task_id)) {
      return {
        content: [
          { type: 'text' as const, text: 'Task not found or access denied.' },
        ],
        isError: true,
      };
    }

    const tx = db.transaction(() => {
      db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(task_id);
      db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(task_id);
    });

    tx();

    return {
      content: [{ type: 'text' as const, text: `Task ${task_id} canceled.` }],
    };
  },
);

server.tool(
  'update_task',
  'Update task prompt and/or schedule.',
  {
    task_id: z.string(),
    prompt: z.string().optional(),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
    schedule_value: z.string().optional(),
    context_mode: z.enum(['group', 'isolated']).optional(),
  },
  async (args) => {
    if (!validateTaskOwnership(args.task_id)) {
      return {
        content: [
          { type: 'text' as const, text: 'Task not found or access denied.' },
        ],
        isError: true,
      };
    }

    const task = db
      .prepare(
        `
        SELECT schedule_type, schedule_value
        FROM scheduled_tasks
        WHERE id = ?
      `,
      )
      .get(args.task_id) as
      | { schedule_type: 'cron' | 'interval' | 'once'; schedule_value: string }
      | undefined;

    if (!task) {
      return {
        content: [{ type: 'text' as const, text: 'Task not found.' }],
        isError: true,
      };
    }

    const nextScheduleType = args.schedule_type || task.schedule_type;
    const nextScheduleValue = args.schedule_value || task.schedule_value;

    try {
      const nextRun = computeNextRun(nextScheduleType, nextScheduleValue);
      const fields: string[] = [
        'schedule_type = ?',
        'schedule_value = ?',
        'next_run = ?',
      ];
      const values: unknown[] = [nextScheduleType, nextScheduleValue, nextRun];

      if (args.prompt !== undefined) {
        fields.push('prompt = ?');
        values.push(args.prompt);
      }
      if (args.context_mode !== undefined) {
        fields.push('context_mode = ?');
        values.push(args.context_mode);
      }

      values.push(args.task_id);
      db.prepare(
        `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
      ).run(...values);

      return {
        content: [
          { type: 'text' as const, text: `Task ${args.task_id} updated.` },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: message }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
