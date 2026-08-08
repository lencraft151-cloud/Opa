import { Router } from 'express';
import type { Container } from '../../container.js';
import { asyncHandler } from '../http.js';

export function updateRoutes(container: Container): Router {
  const router = Router();

  /** Übersicht: Was ist aktuell, wofür liegt eine neue Firmware bereit? */
  router.get('/updates', (_req, res) => {
    const household = container.households.require();
    res.json(container.updates.overview(household.id));
  });

  /** Prüft alle Integrationen sofort. */
  router.post(
    '/updates/check',
    asyncHandler(async (_req, res) => {
      const household = container.households.require();
      await container.updates.checkAll(household.id);
      res.json(container.updates.overview(household.id));
    }),
  );

  /** Prüft eine einzelne Integration. */
  router.post(
    '/updates/:integrationId/check',
    asyncHandler(async (req, res) => {
      res.json(await container.updates.check(req.params.integrationId as string));
    }),
  );

  /**
   * Installiert die bereitstehende Firmware. Das Gerät startet dabei neu und
   * ist einige Minuten nicht erreichbar.
   */
  router.post(
    '/updates/:integrationId/install',
    asyncHandler(async (req, res) => {
      await container.updates.install(req.params.integrationId as string);
      res.status(202).json({
        started: true,
        message: 'Die Installation läuft. Das Gerät startet neu und ist kurz nicht erreichbar.',
      });
    }),
  );

  return router;
}
