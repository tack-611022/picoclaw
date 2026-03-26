import { NextFunction, Request, Response } from 'express';

import { API_TOKEN } from '../config.js';

/**
 * When API_TOKEN is set, validates Bearer token on every request.
 * When API_TOKEN is unset/empty, all requests pass through without
 * authentication — suitable for local development or VPC-internal
 * deployments (e.g. Alibaba Cloud FC behind SLB).
 */
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!API_TOKEN) {
    next();
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = header.slice('Bearer '.length).trim();
  if (!token || token !== API_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
