import { randomUUID } from 'crypto';

import { CronExpressionParser } from 'cron-parser';

import { AgentRunner } from './agent-engine.js';
import { AgentUsage } from './types.js';
import { TIMEZONE } from './config.js';
import {
  ensureConversation,
  getConversation,
  logTaskRun,
  storeConversationMessage,
  updateConversationSession,
  updateTaskAfterRun,
} from './db.js';
import { ScheduledTask } from './types.js';

function validateCron(scheduleValue: string): void {
  CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
}

function validateInterval(scheduleValue: string): number {
  const intervalMs = Number.parseInt(scheduleValue, 10);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error(`Invalid interval: ${scheduleValue}`);
  }
  return intervalMs;
}

function parseLocalTimestamp(scheduleValue: string): Date {
  if (/[Zz]$/.test(scheduleValue) || /[+-]\d{2}:\d{2}$/.test(scheduleValue)) {
    throw new Error(
      'schedule_value for once must be local time without timezone suffix',
    );
  }
  const date = new Date(scheduleValue);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid once schedule_value: ${scheduleValue}`);
  }
  return date;
}

export function computeInitialNextRun(
  scheduleType: ScheduledTask['schedule_type'],
  scheduleValue: string,
  now: Date = new Date(),
): string | null {
  if (scheduleType === 'once') {
    return parseLocalTimestamp(scheduleValue).toISOString();
  }

  if (scheduleType === 'cron') {
    validateCron(scheduleValue);
    const expression = CronExpressionParser.parse(scheduleValue, {
      currentDate: now,
      tz: TIMEZONE,
    });
    return expression.next().toISOString();
  }

  const intervalMs = validateInterval(scheduleValue);
  return new Date(now.getTime() + intervalMs).toISOString();
}

export function computeNextRun(
  task: ScheduledTask,
  now: Date = new Date(),
): string | null {
  if (task.schedule_type === 'once') {
    return null;
  }

  if (task.schedule_type === 'cron') {
    validateCron(task.schedule_value);
    const expression = CronExpressionParser.parse(task.schedule_value, {
      currentDate: now,
      tz: TIMEZONE,
    });
    return expression.next().toISOString();
  }

  const intervalMs = validateInterval(task.schedule_value);
  const anchorTime = task.next_run
    ? new Date(task.next_run).getTime()
    : now.getTime();

  let next = anchorTime + intervalMs;
  while (next <= now.getTime()) {
    next += intervalMs;
  }

  return new Date(next).toISOString();
}

export interface TaskExecutionResult {
  status: 'success' | 'timeout' | 'error';
  task_id: string;
  result: string | null;
  duration_ms: number;
  next_run: string | null;
  error?: string;
  usage?: AgentUsage;
}

export async function runTask(
  task: ScheduledTask,
  agentEngine: AgentRunner,
): Promise<TaskExecutionResult> {
  const startedAt = Date.now();
  const nowIso = new Date().toISOString();
  let resultText: string | null = null;
  let error: string | undefined;
  let status: 'success' | 'timeout' | 'error' = 'success';
  let usage: AgentUsage | undefined;

  const baseConversation =
    task.context_mode === 'group'
      ? ensureConversation(task.conversation_id)
      : undefined;
  const conversationId =
    task.context_mode === 'group'
      ? task.conversation_id
      : `task-${task.id}-${randomUUID()}`;

  if (task.context_mode === 'isolated') {
    // Isolated runs still need a concrete conversation row so MCP send_message
    // can insert outbound_messages without foreign-key violations.
    ensureConversation(conversationId);
  }

  try {
    const agentOutput = await agentEngine.run({
      prompt: task.prompt,
      conversationId,
      sessionId: baseConversation?.session_id,
      resumeAt: baseConversation?.last_assistant_uuid,
      isScheduledTask: true,
    });

    resultText = agentOutput.result;
    status = agentOutput.status;
    error = agentOutput.error;
    usage = agentOutput.usage;

    if (task.context_mode === 'group') {
      updateConversationSession(
        conversationId,
        agentOutput.newSessionId,
        agentOutput.lastAssistantUuid,
      );

      if (resultText) {
        storeConversationMessage({
          id: `msg-${randomUUID()}`,
          conversationId,
          role: 'assistant',
          sender: 'assistant',
          senderName: 'Assistant',
          content: resultText,
          createdAt: nowIso,
        });
      }
    }
  } catch (err) {
    status = 'error';
    error = err instanceof Error ? err.message : String(err);
  }

  const nextRun = computeNextRun(task, new Date());
  const summary =
    status === 'error'
      ? `Error: ${error || 'Unknown error'}`
      : status === 'timeout'
        ? `Timeout: ${(resultText || '').slice(0, 200)}`
        : (resultText || 'Completed').slice(0, 200);

  updateTaskAfterRun(task.id, nextRun, summary);

  const durationMs = Date.now() - startedAt;
  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status,
    result: resultText,
    error: error || null,
  });

  return {
    status,
    task_id: task.id,
    result: resultText,
    duration_ms: durationMs,
    next_run: nextRun,
    error,
    usage,
  };
}

export function getTaskConversation(task: ScheduledTask): string | undefined {
  if (task.context_mode !== 'group') {
    return undefined;
  }
  const conversation = getConversation(task.conversation_id);
  return conversation?.id;
}
