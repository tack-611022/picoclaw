import { CronExpressionParser } from 'cron-parser';

import { getDatabase } from './db.js';

const timezone =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Compute next_run timestamp for a scheduled task.
 * Shared between the in-process MCP server and the stdio MCP server.
 */
export function computeNextRun(
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

/**
 * Validate that the given task belongs to the specified conversation.
 * When isMain is true, all tasks are accessible.
 */
export function validateTaskOwnership(
  taskId: string,
  conversationId: string,
  isMain: boolean,
): boolean {
  if (isMain) {
    return true;
  }

  const db = getDatabase();
  const row = db
    .prepare('SELECT conversation_id FROM scheduled_tasks WHERE id = ?')
    .get(taskId) as { conversation_id: string } | undefined;

  if (!row) {
    return false;
  }

  return row.conversation_id === conversationId;
}
