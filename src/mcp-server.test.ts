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
