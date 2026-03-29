import { randomUUID } from 'crypto';

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import {
  deleteTask,
  ensureConversation,
  getAllTasks,
  getDatabase,
  getTaskById,
  queueOutboundMessage,
  updateTask,
} from './db.js';
import { computeNextRun, validateTaskOwnership } from './task-utils.js';

/**
 * Create an in-process MCP server for the built-in picoclaw tools.
 *
 * Uses the SDK's `createSdkMcpServer()` + `tool()` to run MCP tools
 * in the same process as PicoClaw, eliminating the stdio subprocess
 * spawn overhead (~100ms per request).
 *
 * The returned config is passed directly to `query()` as:
 *   `mcpServers: { picoclaw: createPicoClawMcpServer(...) }`
 */
export function createPicoClawMcpServer(
  conversationId: string,
  isMain: boolean,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'picoclaw',
    version: '1.0.0',
    tools: [
      tool(
        'send_message',
        'Queue a message for delivery back to the HTTP caller while the agent is still running.',
        {
          text: z.string().describe('Message content'),
          sender: z.string().optional().describe('Optional sender alias'),
        },
        async (args) => {
          queueOutboundMessage(
            conversationId,
            args.text,
            args.sender ?? undefined,
          );
          return {
            content: [{ type: 'text' as const, text: 'Message queued.' }],
          };
        },
      ),

      tool(
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
            const targetConversation =
              args.target_conversation_id || conversationId;
            const nextRun = computeNextRun(
              args.schedule_type,
              args.schedule_value,
            );

            ensureConversation(targetConversation);

            const db = getDatabase();
            db.prepare(
              `
              INSERT INTO scheduled_tasks (
                id, conversation_id, prompt, schedule_type, schedule_value,
                context_mode, next_run, status, created_at
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
                { type: 'text' as const, text: `Task created: ${taskId}` },
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
      ),

      tool('list_tasks', 'List scheduled tasks.', {}, async () => {
        const allTasks = getAllTasks();
        const rows = isMain
          ? allTasks
          : allTasks.filter((t) => t.conversation_id === conversationId);

        if (rows.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No tasks found.' }],
          };
        }

        const text = rows
          .map(
            (row) =>
              `- ${row.id} (${row.schedule_type}: ${row.schedule_value}) [${row.status}] next=${row.next_run || 'n/a'} conv=${row.conversation_id}`,
          )
          .join('\n');

        return { content: [{ type: 'text' as const, text }] };
      }),

      tool(
        'pause_task',
        'Pause a task.',
        { task_id: z.string() },
        async ({ task_id }) => {
          if (!validateTaskOwnership(task_id, conversationId, isMain)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Task not found or access denied.',
                },
              ],
              isError: true,
            };
          }

          updateTask(task_id, { status: 'paused' });
          return {
            content: [
              { type: 'text' as const, text: `Task ${task_id} paused.` },
            ],
          };
        },
      ),

      tool(
        'resume_task',
        'Resume a paused task.',
        { task_id: z.string() },
        async ({ task_id }) => {
          if (!validateTaskOwnership(task_id, conversationId, isMain)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Task not found or access denied.',
                },
              ],
              isError: true,
            };
          }

          updateTask(task_id, { status: 'active' });
          return {
            content: [
              { type: 'text' as const, text: `Task ${task_id} resumed.` },
            ],
          };
        },
      ),

      tool(
        'cancel_task',
        'Delete a task.',
        { task_id: z.string() },
        async ({ task_id }) => {
          if (!validateTaskOwnership(task_id, conversationId, isMain)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Task not found or access denied.',
                },
              ],
              isError: true,
            };
          }

          deleteTask(task_id);
          return {
            content: [
              { type: 'text' as const, text: `Task ${task_id} canceled.` },
            ],
          };
        },
      ),

      tool(
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
          if (!validateTaskOwnership(args.task_id, conversationId, isMain)) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Task not found or access denied.',
                },
              ],
              isError: true,
            };
          }

          const task = getTaskById(args.task_id);
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
            updateTask(args.task_id, {
              schedule_type: nextScheduleType,
              schedule_value: nextScheduleValue,
              next_run: nextRun,
              ...(args.prompt !== undefined && { prompt: args.prompt }),
              ...(args.context_mode !== undefined && {
                context_mode: args.context_mode,
              }),
            });

            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Task ${args.task_id} updated.`,
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
      ),
    ],
  });
}
