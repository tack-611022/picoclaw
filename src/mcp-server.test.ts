/**
 * Regression tests for the MCP server's zod version compatibility and
 * context_mode default consistency.
 *
 * History: @modelcontextprotocol/sdk@1.12.1 internally depended on zod v3 and
 * called _parse() on schema instances. zod v4 schemas lack _parse, causing
 * "keyValidator._parse is not a function" at runtime. The fix was upgrading to
 * @modelcontextprotocol/sdk@1.27.1 which supports both zod v3 and v4.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

/**
 * Helper: create a linked McpServer + Client pair, register one tool, and
 * attempt to call it. Returns the call result or throws.
 */
async function callToolWithZod(
  toolArgs: Record<string, string>,
): Promise<{ content: unknown[] }> {
  const server = new McpServer({ name: 'test', version: '0.0.1' });

  server.tool(
    'echo',
    'Echo the input text back',
    { text: z.string().describe('Text to echo') },
    async (args) => ({
      content: [{ type: 'text' as const, text: args.text }],
    }),
  );

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);

  const result = await client.callTool({
    name: 'echo',
    arguments: toolArgs,
  });

  await client.close();
  await server.close();

  return result as { content: unknown[] };
}

describe('mcp zod compatibility', () => {
  it('zod v4 schemas work with MCP SDK (regression: v4 failed on SDK 1.12.1)', async () => {
    // Before: @modelcontextprotocol/sdk@1.12.1 called _parse() on schema
    // instances, which does not exist in zod v4, causing runtime errors for
    // all MCP tools with parameters (send_message, schedule_task, etc.).
    // After: SDK 1.27.1 supports zod ^3.25 || ^4.0, so v4 schemas work.
    const result = await callToolWithZod({ text: 'hello' });

    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('zod v4 schemas with optional fields work correctly', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });

    server.tool(
      'greet',
      'Greet with optional name',
      {
        text: z.string(),
        name: z.string().optional().describe('Optional name'),
      },
      async (args) => ({
        content: [
          {
            type: 'text' as const,
            text: args.name ? `${args.text}, ${args.name}` : args.text,
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(clientTransport);

    // Call without optional field
    const result = await client.callTool({
      name: 'greet',
      arguments: { text: 'hello' },
    });

    expect(result.content).toEqual([{ type: 'text', text: 'hello' }]);

    await client.close();
    await server.close();
  });
});

describe('mcp picoclaw tool schemas (real tool signatures)', () => {
  /**
   * Verify that every picoclaw MCP tool schema registers and validates
   * correctly with the current @modelcontextprotocol/sdk version.
   *
   * This catches two failure modes:
   *   1. Zod v4 incompatibility (the 1.12.1 _parse regression)
   *   2. MCP SDK 1.28.0 stricter validation rejecting non-Zod schemas
   *
   * Each tool uses the exact same Zod schema shape as src/mcp-server.ts.
   */
  async function registerAndCallTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown[] }> {
    const server = new McpServer({ name: 'test', version: '0.0.1' });

    server.tool(
      name,
      description,
      schema as Record<string, import('zod').ZodTypeAny>,
      async (parsed) => ({
        content: [{ type: 'text' as const, text: JSON.stringify(parsed) }],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(clientTransport);

    const result = await client.callTool({ name, arguments: args });

    await client.close();
    await server.close();

    return result as { content: unknown[] };
  }

  it('send_message schema: string + optional string', async () => {
    const result = await registerAndCallTool(
      'send_message',
      'Queue a message',
      {
        text: z.string().describe('Message content'),
        sender: z.string().optional().describe('Optional sender alias'),
      },
      { text: 'hello' },
    );
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.text).toBe('hello');
    expect(parsed.sender).toBeUndefined();
  });

  it('schedule_task schema: string + enum + default', async () => {
    const result = await registerAndCallTool(
      'schedule_task',
      'Create a scheduled task',
      {
        prompt: z.string().describe('Prompt to run when task executes'),
        schedule_type: z.enum(['cron', 'interval', 'once']),
        schedule_value: z.string(),
        context_mode: z.enum(['group', 'isolated']).default('isolated'),
        target_conversation_id: z.string().optional(),
      },
      {
        prompt: 'test',
        schedule_type: 'once',
        schedule_value: '2026-01-01T00:00:00',
      },
    );
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.prompt).toBe('test');
    expect(parsed.context_mode).toBe('isolated');
  });

  it('list_tasks schema: empty object', async () => {
    const result = await registerAndCallTool(
      'list_tasks',
      'List scheduled tasks',
      {},
      {},
    );
    expect(result.content).toBeDefined();
  });

  it('update_task schema: string + multiple optionals', async () => {
    const result = await registerAndCallTool(
      'update_task',
      'Update task prompt and/or schedule',
      {
        task_id: z.string(),
        prompt: z.string().optional(),
        schedule_type: z.enum(['cron', 'interval', 'once']).optional(),
        schedule_value: z.string().optional(),
        context_mode: z.enum(['group', 'isolated']).optional(),
      },
      { task_id: 'task-123', prompt: 'updated prompt' },
    );
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.task_id).toBe('task-123');
    expect(parsed.prompt).toBe('updated prompt');
    expect(parsed.schedule_type).toBeUndefined();
  });
});

describe('mcp schedule_task context_mode default', () => {
  it('context_mode defaults to isolated (matching HTTP API and docs)', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.1' });

    // Register a tool that captures the parsed args to verify the default
    let capturedArgs: Record<string, unknown> = {};

    server.tool(
      'check_default',
      'Verify context_mode default',
      {
        context_mode: z.enum(['group', 'isolated']).default('isolated'),
      },
      async (args) => {
        capturedArgs = args;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(args) }],
        };
      },
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '0.0.1' });
    await client.connect(clientTransport);

    // Call without providing context_mode — the default should apply
    const result = await client.callTool({
      name: 'check_default',
      arguments: {},
    });

    expect(capturedArgs.context_mode).toBe('isolated');
    expect(result.content).toEqual([
      { type: 'text', text: '{"context_mode":"isolated"}' },
    ]);

    await client.close();
    await server.close();
  });
});
