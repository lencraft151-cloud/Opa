import { Router } from 'express';
import { z } from 'zod';
import { LIGHT_EFFECT_IDS } from '../../core/types.js';
import type { Container } from '../../container.js';
import { asyncHandler, parseBody } from '../http.js';

/**
 * Lichteffekte: Disco, Farbwechsel, Gruselmodus, Kerze, Gewitter.
 *
 * Getrennt von `/devices/command`, weil ein Effekt kein Zustand ist, sondern
 * ein Vorgang: Er läuft weiter, bis die Zeit um ist oder jemand ihn beendet.
 */
export function effectRoutes(container: Container): Router {
  const router = Router();

  router.get('/effects', (_req, res) => {
    const household = container.households.require();
    res.json(container.effects.overview(household.id));
  });

  router.post(
    '/effects/:effect/start',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const effect = z.enum(LIGHT_EFFECT_IDS).parse(req.params.effect);
      const options = parseBody(
        z.object({
          deviceIds: z.array(z.string().max(60)).max(200).optional(),
          roomIds: z.array(z.string().max(60)).max(50).optional(),
          minutes: z.number().int().min(1).max(120).optional(),
        }),
        req,
      );
      res.json(await container.effects.start(household.id, effect, options));
    }),
  );

  /** Beendet einen Effekt – und stellt das Licht wieder her, wie es war. */
  router.post(
    '/effects/:effect/stop',
    asyncHandler(async (req, res) => {
      container.households.require();
      const effect = z.enum(LIGHT_EFFECT_IDS).parse(req.params.effect);
      res.json({ stopped: await container.effects.stop(effect) });
    }),
  );

  /** Der Panikknopf: alles aus, Licht wieder normal. */
  router.post(
    '/effects/stop',
    asyncHandler(async (_req, res) => {
      container.households.require();
      res.json({ stopped: await container.effects.stop() });
    }),
  );

  return router;
}
