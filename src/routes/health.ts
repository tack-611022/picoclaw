import fs from 'fs';
import path from 'path';

import { Router } from 'express';

import {
  APP_VERSION,
  BUILD_COMMIT,
  BUILD_TIME,
  MAX_EXECUTION_MS,
  MEMORY_DIR,
  SKILLS_DIR,
  STORE_DIR,
} from '../config.js';
import { getDatabaseHealth } from '../db.js';

function isDirectoryWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function healthRoutes(): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const database = getDatabaseHealth();
    const volumes = {
      memory: isDirectoryWritable(MEMORY_DIR),
      skills: fs.existsSync(SKILLS_DIR),
      // "sessions" checks $MEMORY_DIR/.claude/ (SDK session state).
      // Field name kept for API backward compatibility; not a separate volume.
      sessions: isDirectoryWritable(path.join(MEMORY_DIR, '.claude')),
      store: isDirectoryWritable(STORE_DIR),
    };

    const allHealthy =
      database.ok && volumes.memory && volumes.sessions && volumes.store;

    res.json({
      status: allHealthy ? 'ok' : 'degraded',
      version: APP_VERSION,
      commit: BUILD_COMMIT,
      build_time: BUILD_TIME,
      max_execution_ms: MAX_EXECUTION_MS,
      database,
      volumes,
    });
  });

  return router;
}
