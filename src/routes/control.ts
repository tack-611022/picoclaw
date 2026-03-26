import { Request, Response, Router } from 'express';

import { logger } from '../logger.js';

export interface ControlRouteOptions {
  onStop?: (reason: string) => Promise<void> | void;
}

interface StopRequestBody {
  reason?: string;
}

export function controlRoutes(options: ControlRouteOptions = {}): Router {
  const router = Router();

  router.post('/stop', async (req: Request, res: Response) => {
    if (!options.onStop) {
      res.status(501).json({
        error: 'Stop callback is not configured for this runtime',
      });
      return;
    }

    const body = (req.body || {}) as StopRequestBody;
    const reason = body.reason?.trim() || 'api-stop';

    res.json({
      status: 'stopping',
      reason,
      message:
        'Shutdown accepted. The runtime will sync data and exit gracefully.',
    });

    setImmediate(async () => {
      try {
        await options.onStop?.(reason);
      } catch (err) {
        logger.error({ err, reason }, 'Failed to complete stop callback');
      }
    });
  });

  return router;
}
