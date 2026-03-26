import { randomUUID } from 'crypto';

import { Request, Response, Router } from 'express';

import { AgentRunner } from '../agent-engine.js';
import {
  ConversationBusyError,
  acquireConversationLock,
} from '../conversation-lock.js';
import {
  createTask,
  deleteTask,
  ensureConversation,
  getAllTasks,
  getDueTasks,
  getTaskById,
  updateTask,
} from '../db.js';
import { logger } from '../logger.js';
import { computeInitialNextRun, runTask } from '../task-scheduler.js';
import { ScheduledTask } from '../types.js';

interface CreateTaskBody {
  id?: string;
  prompt?: string;
  schedule_type?: ScheduledTask['schedule_type'];
  schedule_value?: string;
  context_mode?: ScheduledTask['context_mode'];
  conversation_id?: string;
}

interface UpdateTaskBody {
  prompt?: string;
  schedule_type?: ScheduledTask['schedule_type'];
  schedule_value?: string;
  context_mode?: ScheduledTask['context_mode'];
  status?: ScheduledTask['status'];
  conversation_id?: string;
}

type TaskUpdates = Partial<
  Pick<
    ScheduledTask,
    | 'prompt'
    | 'schedule_type'
    | 'schedule_value'
    | 'context_mode'
    | 'status'
    | 'conversation_id'
    | 'next_run'
  >
>;

function buildTaskId(id?: string): string {
  return id || `task-${Date.now()}-${randomUUID().slice(0, 8)}`;
}

function validateScheduleType(
  scheduleType: unknown,
): scheduleType is ScheduledTask['schedule_type'] {
  return (
    scheduleType === 'cron' ||
    scheduleType === 'interval' ||
    scheduleType === 'once'
  );
}

function validateContextMode(
  contextMode: unknown,
): contextMode is ScheduledTask['context_mode'] {
  return contextMode === 'group' || contextMode === 'isolated';
}

function validateStatus(status: unknown): status is ScheduledTask['status'] {
  return status === 'active' || status === 'paused' || status === 'completed';
}

export function taskRoutes(agentEngine: AgentRunner): Router {
  const router = Router();

  router.post('/task', (req: Request, res: Response) => {
    const body = (req.body || {}) as CreateTaskBody;

    if (!body.prompt?.trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    if (!body.schedule_value?.trim()) {
      res.status(400).json({ error: 'schedule_value is required' });
      return;
    }
    if (!validateScheduleType(body.schedule_type)) {
      res
        .status(400)
        .json({ error: 'schedule_type must be cron, interval, or once' });
      return;
    }

    const contextMode = validateContextMode(body.context_mode)
      ? body.context_mode
      : 'isolated';

    const conversationId = body.conversation_id || `conv-${randomUUID()}`;
    ensureConversation(conversationId);

    let nextRun: string | null;
    try {
      nextRun = computeInitialNextRun(body.schedule_type, body.schedule_value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
      return;
    }

    const task: Omit<ScheduledTask, 'last_run' | 'last_result'> = {
      id: buildTaskId(body.id),
      conversation_id: conversationId,
      prompt: body.prompt,
      schedule_type: body.schedule_type,
      schedule_value: body.schedule_value,
      context_mode: contextMode,
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    };

    try {
      createTask(task);
      res.status(201).json(task);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(400).json({ error: message });
    }
  });

  router.get('/tasks', (_req: Request, res: Response) => {
    res.json({ tasks: getAllTasks() });
  });

  router.put('/task/:task_id', (req: Request, res: Response) => {
    const rawTaskId = req.params.task_id;
    const taskId = Array.isArray(rawTaskId) ? rawTaskId[0] : rawTaskId;
    if (!taskId) {
      res.status(400).json({ error: 'task_id is required' });
      return;
    }

    const task = getTaskById(taskId);
    if (!task) {
      res.status(404).json({ error: `task not found: ${taskId}` });
      return;
    }

    const body = (req.body || {}) as UpdateTaskBody;
    const updates: TaskUpdates = {};

    if (body.prompt !== undefined) {
      updates.prompt = body.prompt;
    }

    if (body.context_mode !== undefined) {
      if (!validateContextMode(body.context_mode)) {
        res
          .status(400)
          .json({ error: 'context_mode must be group or isolated' });
        return;
      }
      updates.context_mode = body.context_mode;
    }

    if (body.status !== undefined) {
      if (!validateStatus(body.status)) {
        res
          .status(400)
          .json({ error: 'status must be active, paused, or completed' });
        return;
      }
      updates.status = body.status;
    }

    if (body.conversation_id !== undefined) {
      ensureConversation(body.conversation_id);
      updates.conversation_id = body.conversation_id;
    }

    const nextScheduleType = body.schedule_type ?? task.schedule_type;
    const nextScheduleValue = body.schedule_value ?? task.schedule_value;

    if (body.schedule_type !== undefined || body.schedule_value !== undefined) {
      if (!validateScheduleType(nextScheduleType)) {
        res
          .status(400)
          .json({ error: 'schedule_type must be cron, interval, or once' });
        return;
      }

      try {
        updates.schedule_type = nextScheduleType;
        updates.schedule_value = nextScheduleValue;
        updates.next_run = computeInitialNextRun(
          nextScheduleType,
          nextScheduleValue,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(400).json({ error: message });
        return;
      }
    }

    updateTask(taskId, updates);
    const updatedTask = getTaskById(taskId);
    res.json(updatedTask);
  });

  router.delete('/task/:task_id', (req: Request, res: Response) => {
    const rawTaskId = req.params.task_id;
    const taskId = Array.isArray(rawTaskId) ? rawTaskId[0] : rawTaskId;
    if (!taskId) {
      res.status(400).json({ error: 'task_id is required' });
      return;
    }

    if (!getTaskById(taskId)) {
      res.status(404).json({ error: `task not found: ${taskId}` });
      return;
    }

    deleteTask(taskId);
    res.status(204).send();
  });

  router.post('/task/trigger', async (req: Request, res: Response) => {
    const taskId = (req.body || {}).task_id as string | undefined;

    if (!taskId) {
      res.status(400).json({ error: 'task_id is required' });
      return;
    }

    const task = getTaskById(taskId);
    if (!task) {
      res.status(404).json({ error: `task not found: ${taskId}` });
      return;
    }

    let releaseLock: (() => void) | undefined;
    try {
      if (task.context_mode === 'group') {
        releaseLock = await acquireConversationLock(task.conversation_id, {
          wait: false,
        });
      }
      const result = await runTask(task, agentEngine);
      if (result.usage) {
        res.locals.usage = result.usage;
      }
      res.json(result);
    } catch (err) {
      if (err instanceof ConversationBusyError) {
        res.status(409).json({
          error: `Conversation ${task.conversation_id} is currently busy`,
          task_id: taskId,
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, taskId }, 'Failed to trigger task');
      res.status(500).json({ error: message });
    } finally {
      releaseLock?.();
    }
  });

  router.post('/task/check', async (_req: Request, res: Response) => {
    const dueTasks = getDueTasks();

    if (dueTasks.length === 0) {
      res.json({ checked: 0, message: 'No due tasks' });
      return;
    }

    const task = dueTasks[0];

    let releaseLock: (() => void) | undefined;
    try {
      if (task.context_mode === 'group') {
        releaseLock = await acquireConversationLock(task.conversation_id, {
          wait: false,
        });
      }
      const executed = await runTask(task, agentEngine);
      if (executed.usage) {
        res.locals.usage = executed.usage;
      }
      res.json({
        checked: dueTasks.length,
        executed,
        remaining: Math.max(0, dueTasks.length - 1),
      });
    } catch (err) {
      if (err instanceof ConversationBusyError) {
        res.json({
          checked: dueTasks.length,
          executed: {
            task_id: task.id,
            status: 'skipped',
            error: `Conversation ${task.conversation_id} is currently busy`,
          },
          remaining: Math.max(0, dueTasks.length - 1),
        });
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err, taskId: task.id }, 'Failed to run due task');
      res.status(500).json({
        checked: dueTasks.length,
        executed: {
          task_id: task.id,
          status: 'error',
          error: message,
        },
        remaining: Math.max(0, dueTasks.length - 1),
      });
    } finally {
      releaseLock?.();
    }
  });

  return router;
}
