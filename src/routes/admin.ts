import { Request, Response, Router } from 'express';

import { invalidateAgentCache } from '../agent-engine.js';
import { getSkillsSummary, syncSkills } from '../skills.js';

export function adminRoutes(): Router {
  const router = Router();

  router.post('/reload-skills', (_req: Request, res: Response) => {
    syncSkills();
    invalidateAgentCache();
    const summary = getSkillsSummary();
    res.json({
      status: 'reloaded',
      skills: summary,
    });
  });

  router.get('/skills', (_req: Request, res: Response) => {
    const summary = getSkillsSummary();
    res.json({ skills: summary });
  });

  return router;
}
