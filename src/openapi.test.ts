import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRunner } from './agent-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const specPath = path.join(projectRoot, 'docs', 'api', 'openapi.json');

interface OpenApiSpec {
  paths: Record<string, Record<string, unknown>>;
}

function loadSpec(): OpenApiSpec {
  const raw = fs.readFileSync(specPath, 'utf-8');
  return JSON.parse(raw) as OpenApiSpec;
}

/**
 * Convert OpenAPI path template to a concrete path for supertest.
 * e.g. /chat/{conversation_id} → /chat/test-id
 */
function concretePath(template: string): string {
  return template.replace(/\{[^}]+\}/g, 'test-id');
}

describe('openapi spec alignment', () => {
  let app: import('express').Express;

  beforeEach(async () => {
    vi.resetModules();
    process.env.API_TOKEN = 'test-token';

    const os = await import('os');
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-test-'));

    const dbModule = await import('./db.js');
    dbModule.initDatabase({
      persistentDbPath: path.join(rootDir, 'store', 'messages.db'),
      localDbPath: path.join(rootDir, 'tmp', 'messages.db'),
      forceReinitialize: true,
    });

    const fakeEngine: AgentRunner = {
      async run() {
        return {
          status: 'success',
          result: 'mock',
          newSessionId: 'sess',
          lastAssistantUuid: 'uuid',
        };
      },
    };

    const serverModule = await import('./server.js');
    app = serverModule.createServer(fakeEngine);
  });

  afterEach(async () => {
    const dbModule = await import('./db.js');
    dbModule.closeDatabase();
    dbModule._resetDatabaseForTests();
  });

  it('openapi.json is valid JSON and has paths', () => {
    const spec = loadSpec();
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  it('every spec path+method exists in the Express app (not 404)', async () => {
    const spec = loadSpec();
    const httpMethods = ['get', 'post', 'put', 'delete', 'patch'] as const;

    for (const [pathTemplate, methods] of Object.entries(spec.paths)) {
      for (const method of httpMethods) {
        if (!(method in methods)) continue;

        const url = concretePath(pathTemplate);
        const res = await (request(app) as any)[method](url);

        // A registered route returns anything except 404.
        // Unauthed routes return 401, bad input returns 400, etc. — all fine.
        expect(
          res.status,
          `${method.toUpperCase()} ${pathTemplate} → ${url} should not be 404`,
        ).not.toBe(404);
      }
    }
  });
});
