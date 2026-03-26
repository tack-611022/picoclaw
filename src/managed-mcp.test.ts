import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('managed-mcp', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-mcp-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function loadWithOrgDir(
    orgDir: string,
  ): Promise<typeof import('./managed-mcp.js')> {
    vi.stubEnv('ORG_DIR', orgDir);
    return import('./managed-mcp.js');
  }

  it('returns empty when ORG_DIR is not set', async () => {
    vi.stubEnv('ORG_DIR', '');
    const mod = await import('./managed-mcp.js');
    const servers = mod.loadManagedMcpServers();
    expect(servers).toEqual({});
    expect(mod.getManagedMcpNames()).toEqual([]);
  });

  it('parses valid managed-mcp.json with http and sse servers', async () => {
    const orgDir = path.join(tmpDir, 'org');
    fs.mkdirSync(orgDir);
    fs.writeFileSync(
      path.join(orgDir, 'managed-mcp.json'),
      JSON.stringify({
        mcpServers: {
          finance: { type: 'http', url: 'http://example.com/mcp' },
          analytics: {
            type: 'sse',
            url: 'http://example.com/sse',
            headers: { Authorization: 'Bearer tok' },
          },
        },
      }),
    );

    const mod = await loadWithOrgDir(orgDir);
    const servers = mod.loadManagedMcpServers();

    expect(servers).toEqual({
      finance: { type: 'http', url: 'http://example.com/mcp' },
      analytics: {
        type: 'sse',
        url: 'http://example.com/sse',
        headers: { Authorization: 'Bearer tok' },
      },
    });
    expect(mod.getManagedMcpNames()).toEqual(['finance', 'analytics']);
    expect(mod.getManagedMcpServers()).toBe(servers);
  });

  it('parses stdio server config', async () => {
    const orgDir = path.join(tmpDir, 'org');
    fs.mkdirSync(orgDir);
    fs.writeFileSync(
      path.join(orgDir, 'managed-mcp.json'),
      JSON.stringify({
        mcpServers: {
          local: {
            type: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: { DEBUG: '1' },
          },
        },
      }),
    );

    const mod = await loadWithOrgDir(orgDir);
    const servers = mod.loadManagedMcpServers();

    expect(servers).toEqual({
      local: {
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
        env: { DEBUG: '1' },
      },
    });
  });

  it('skips invalid entries and keeps valid ones', async () => {
    const orgDir = path.join(tmpDir, 'org');
    fs.mkdirSync(orgDir);
    fs.writeFileSync(
      path.join(orgDir, 'managed-mcp.json'),
      JSON.stringify({
        mcpServers: {
          good: { type: 'http', url: 'http://valid.com/mcp' },
          bad1: { type: 'http' },
          bad2: 'not-an-object',
          bad3: { type: 'stdio' },
        },
      }),
    );

    const mod = await loadWithOrgDir(orgDir);
    const servers = mod.loadManagedMcpServers();

    expect(Object.keys(servers)).toEqual(['good']);
    expect(servers.good).toEqual({ type: 'http', url: 'http://valid.com/mcp' });
  });

  it('returns empty on malformed JSON', async () => {
    const orgDir = path.join(tmpDir, 'org');
    fs.mkdirSync(orgDir);
    fs.writeFileSync(path.join(orgDir, 'managed-mcp.json'), '{invalid json');

    const mod = await loadWithOrgDir(orgDir);
    const servers = mod.loadManagedMcpServers();
    expect(servers).toEqual({});
  });

  it('rejects reserved name picoclaw in managed-mcp.json', async () => {
    const orgDir = path.join(tmpDir, 'org');
    fs.mkdirSync(orgDir);
    fs.writeFileSync(
      path.join(orgDir, 'managed-mcp.json'),
      JSON.stringify({
        mcpServers: {
          picoclaw: { type: 'http', url: 'http://should-be-rejected.com' },
          valid: { type: 'http', url: 'http://valid.com/mcp' },
        },
      }),
    );

    const mod = await loadWithOrgDir(orgDir);
    const servers = mod.loadManagedMcpServers();

    expect(Object.keys(servers)).toEqual(['valid']);
    expect(servers).not.toHaveProperty('picoclaw');
  });

  it('returns empty when file does not exist', async () => {
    const orgDir = path.join(tmpDir, 'org');
    fs.mkdirSync(orgDir);
    // No managed-mcp.json file

    const mod = await loadWithOrgDir(orgDir);
    const servers = mod.loadManagedMcpServers();
    expect(servers).toEqual({});
  });
});

describe('validateSingleMcpServer', () => {
  // Import directly — no ORG_DIR dependency
  async function getValidator() {
    const mod = await import('./managed-mcp.js');
    return mod.validateSingleMcpServer;
  }

  it('returns config for valid http server', async () => {
    const validate = await getValidator();
    const result = validate({ type: 'http', url: 'http://example.com/mcp' });
    expect(result.config).toEqual({
      type: 'http',
      url: 'http://example.com/mcp',
    });
    expect(result.reason).toBeUndefined();
  });

  it('returns config for valid stdio server', async () => {
    const validate = await getValidator();
    const result = validate({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
    });
    expect(result.config).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
    });
    expect(result.reason).toBeUndefined();
  });

  it('returns reason when config is not an object', async () => {
    const validate = await getValidator();

    const r1 = validate('string');
    expect(r1.config).toBeNull();
    expect(r1.reason).toContain('expected an object');
    expect(r1.reason).toContain('string');

    const r2 = validate(null);
    expect(r2.config).toBeNull();
    expect(r2.reason).toContain('null');

    const r3 = validate([1, 2]);
    expect(r3.config).toBeNull();
    expect(r3.reason).toContain('array');
  });

  it('returns reason when http server missing url', async () => {
    const validate = await getValidator();
    const result = validate({ type: 'http' });
    expect(result.config).toBeNull();
    expect(result.reason).toContain('url');
    expect(result.reason).toContain('http');
  });

  it('returns reason when sse server has empty url', async () => {
    const validate = await getValidator();
    const result = validate({ type: 'sse', url: '' });
    expect(result.config).toBeNull();
    expect(result.reason).toContain('url');
    expect(result.reason).toContain('sse');
  });

  it('returns reason when stdio server missing command', async () => {
    const validate = await getValidator();
    const result = validate({ type: 'stdio' });
    expect(result.config).toBeNull();
    expect(result.reason).toContain('command');
    expect(result.reason).toContain('stdio');
  });

  it('returns reason for unsupported transport type', async () => {
    const validate = await getValidator();
    const result = validate({ type: 'websocket', url: 'ws://example.com' });
    expect(result.config).toBeNull();
    expect(result.reason).toContain('unsupported');
    expect(result.reason).toContain('websocket');
  });
});
