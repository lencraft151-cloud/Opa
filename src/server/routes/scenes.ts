import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { announcePresence } from '../../services/presenceService.js';
import { asyncHandler, parseBody } from '../http.js';
import { presenceSchema, sceneSchema, sceneUpdateSchema } from '../validation.js';

/**
 * Szenen und Urlaubsmodus.
 *
 * Beides beantwortet dieselbe Frage – „wie soll das Zuhause gerade sein?" –
 * nur einmal auf Knopfdruck und einmal von allein.
 */
export function sceneRoutes(container: Container): Router {
  const router = Router();

  router.get('/scenes', (_req, res) => {
    const household = container.households.require();
    res.json(container.scenes.list(household.id));
  });

  router.get('/scenes/:id', (req, res) => {
    res.json(container.scenes.get(req.params.id as string));
  });

  /**
   * Legt eine Szene aus dem *aktuellen* Zustand der genannten Geräte an.
   * Man stellt sein Zuhause ein, wie man es haben will, und drückt sichern.
   */
  router.post(
    '/scenes',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const input = parseBody(sceneSchema, req);
      res.status(201).json(await container.scenes.create(household.id, input));
    }),
  );

  router.patch(
    '/scenes/:id',
    asyncHandler(async (req, res) => {
      const changes = parseBody(sceneUpdateSchema, req);
      res.json(await container.scenes.update(req.params.id as string, changes));
    }),
  );

  /** Nimmt die Zustände neu auf – „so wie es jetzt ist". */
  router.post(
    '/scenes/:id/restamp',
    asyncHandler(async (req, res) => {
      res.json(await container.scenes.restamp(req.params.id as string));
    }),
  );

  router.post(
    '/scenes/:id/apply',
    asyncHandler(async (req, res) => {
      res.json(await container.scenes.apply(req.params.id as string));
    }),
  );

  router.delete(
    '/scenes/:id',
    asyncHandler(async (req, res) => {
      await container.scenes.remove(req.params.id as string);
      res.status(204).end();
    }),
  );

  /**
   * Vorschau: Was würde gesichert werden? Die Oberfläche zeigt damit vor dem
   * Speichern, welche Kommandos in der Szene landen.
   */
  router.post(
    '/scenes/preview',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const { deviceIds } = parseBody(
        z.object({ deviceIds: z.array(z.string()).min(1).max(200) }),
        req,
      );
      res.json({ entries: container.scenes.capture(household.id, deviceIds) });
    }),
  );

  // -------------------------------------------------------------------------
  // Urlaubsmodus
  // -------------------------------------------------------------------------

  router.get('/presence', (_req, res) => {
    res.json(container.presence.status());
  });

  router.patch(
    '/presence',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const changes = parseBody(presenceSchema, req);
      const before = container.presence.status().settings.enabled;

      await container.households.update({ presence: changes });
      const status = container.presence.status();

      // Beim Abschalten bleibt kein Licht an, das die Simulation angemacht hat.
      if (before && !status.settings.enabled) await container.presence.reset();
      if (before !== status.settings.enabled) {
        announcePresence(household.id, status.settings.enabled, status.candidates);
      }

      res.json(status);
    }),
  );

  return router;
}
