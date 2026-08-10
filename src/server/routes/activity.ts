import { Router } from 'express';
import { z } from 'zod';
import { ACTIVITY_KINDS } from '../../core/types.js';
import type { Container } from '../../container.js';
import { asyncHandler, parseQuery } from '../http.js';

/**
 * Der Verlauf: was ist wann passiert.
 *
 * Bewusst getrennt von `/telemetry`: Dort liegen Messreihen, hier Ereignisse.
 * Wer wissen will, wie warm es gestern war, fragt die Messwerte; wer wissen
 * will, warum um halb acht das Licht anging, fragt hier.
 */
export function activityRoutes(container: Container): Router {
  const router = Router();

  router.get('/activity', (req, res) => {
    const household = container.households.require();
    const query = parseQuery(
      z.object({
        kind: z.enum(ACTIVITY_KINDS).optional(),
        deviceId: z.string().max(60).optional(),
        search: z.string().max(80).optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
      }),
      req,
    );

    res.json({
      entries: container.activity.list(household.id, query),
      counts: container.activity.counts(household.id),
    });
  });

  /** Leert den Verlauf. Die Messwerte bleiben davon unberührt. */
  router.delete(
    '/activity',
    asyncHandler(async (_req, res) => {
      const household = container.households.require();
      await container.activity.clear(household.id);
      res.status(204).end();
    }),
  );

  return router;
}
