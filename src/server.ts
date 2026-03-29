import express, { Express, NextFunction, Request, Response } from 'express';

import { AgentEngine, AgentRunner } from './agent-engine.js';
import { APP_VERSION, BUILD_COMMIT } from './config.js';
import { syncDatabaseToVolume } from './db.js';
import { logger } from './logger.js';
import { authMiddleware } from './middleware/auth.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { adminRoutes } from './routes/admin.js';
import { chatRoutes } from './routes/chat.js';
import { controlRoutes } from './routes/control.js';
import { healthRoutes } from './routes/health.js';
import { taskRoutes } from './routes/task.js';

export interface ServerOptions {
  onStop?: (reason: string) => Promise<void> | void;
}

export function createServer(
  agentEngine: AgentRunner = new AgentEngine(),
  options: ServerOptions = {},
): Express {
  const app = express();

  app.use(express.json({ limit: '1mb' }));
  app.use(requestIdMiddleware);

  // Build metadata headers on every response
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Build-Version', APP_VERSION);
    res.setHeader('X-Build-Commit', BUILD_COMMIT);
    next();
  });

  // Per-request logging (route handlers can set res.locals.usage for token metrics)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const durationMs = Date.now() - start;
      const usage = res.locals.usage as
        | {
            inputTokens?: number;
            outputTokens?: number;
            totalCostUsd?: number;
          }
        | undefined;
      const entry = {
        requestId: req.requestId,
        method: req.method,
        url: req.originalUrl,
        statusCode: res.statusCode,
        durationMs,
        ...(usage && {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalCostUsd: usage.totalCostUsd,
        }),
      };
      // Health probes log at debug to avoid flooding production logs
      const isHealthProbe = req.originalUrl === '/health';
      if (res.statusCode >= 500) {
        logger.warn(entry, 'Request completed');
      } else if (isHealthProbe) {
        logger.debug(entry, 'Request completed');
      } else {
        logger.info(entry, 'Request completed');
      }
    });
    next();
  });

  // Sync database to persistent volume after each response
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      try {
        syncDatabaseToVolume();
      } catch (err) {
        logger.error({ err }, 'Failed to sync database to volume');
      }
    });
    next();
  });

  app.use('/health', healthRoutes());

  app.use(authMiddleware);
  app.use('/chat', chatRoutes(agentEngine));
  app.use(taskRoutes(agentEngine));
  app.use('/admin', adminRoutes());
  app.use('/control', controlRoutes({ onStop: options.onStop }));

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  return app;
}
