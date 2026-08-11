import { Router } from 'express';
import { z } from 'zod';
import { badRequest } from '../../core/errors.js';
import type { Container } from '../../container.js';
import { MAX_POLL_SECONDS, MIN_POLL_SECONDS } from '../../services/nextcloudService.js';
import { asyncHandler, parseBody } from '../http.js';

const connectSchema = z.object({
  baseUrl: z.string().min(1).max(300),
  username: z.string().min(1).max(120),
  appPassword: z.string().min(1).max(300),
  pollIntervalSeconds: z.number().min(MIN_POLL_SECONDS).max(MAX_POLL_SECONDS).optional(),
});

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    pollIntervalSeconds: z.number().min(MIN_POLL_SECONDS).max(MAX_POLL_SECONDS).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Es wurde nichts angegeben, was geändert werden soll',
  });

/**
 * Nextcloud – Verbindung und Benachrichtigungen.
 *
 * Keine Geräte, deshalb auch keine Integration unter `/integrations`: Hier
 * gibt es nichts zu schalten, nur etwas zu lesen.
 */
export function nextcloudRoutes(container: Container): Router {
  const router = Router();

  router.get('/nextcloud', (_req, res) => {
    const household = container.households.require();
    res.json(container.nextcloud.status(household.id));
  });

  router.post(
    '/nextcloud',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const input = parseBody(connectSchema, req);
      res.status(201).json(await container.nextcloud.connect(household.id, input));
    }),
  );

  router.patch(
    '/nextcloud',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const changes = parseBody(updateSchema, req);
      res.json(await container.nextcloud.update(household.id, changes));
    }),
  );

  router.delete(
    '/nextcloud',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      await container.nextcloud.disconnect(household.id);
      res.status(204).end();
    }),
  );

  /** Jetzt nachsehen – dieselbe Abfrage, die auch im Hintergrund läuft. */
  router.post(
    '/nextcloud/refresh',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      res.json({ notifications: await container.nextcloud.refresh(household.id) });
    }),
  );

  router.delete(
    '/nextcloud/notifications',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      await container.nextcloud.dismissAll(household.id);
      res.status(204).end();
    }),
  );

  router.delete(
    '/nextcloud/notifications/:id',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        throw badRequest('Die Kennung der Benachrichtigung muss eine Zahl sein.');
      }
      await container.nextcloud.dismiss(household.id, id);
      res.status(204).end();
    }),
  );

  return router;
}
