import { Router } from 'express';
import { z } from 'zod';
import { IntegrationRepository } from '../../storage/repositories.js';
import type { Container } from '../../container.js';
import { asyncHandler, booleanQuery, parseBody, parseQuery } from '../http.js';
import { addIntegrationSchema, integrationTypeSchema } from '../validation.js';

export function integrationRoutes(container: Container): Router {
  const router = Router();

  router.get('/integrations', (_req, res) => {
    const household = container.households.require();
    res.json(
      container.integrations
        .list(household.id)
        .map((integration) => ({
          ...IntegrationRepository.toPublic(integration),
          deviceCount: container.repos.devices.listByIntegration(integration.id).length,
        })),
    );
  });

  /**
   * Sucht Hue Bridges und Shelly-Geräte im Netzwerk.
   * `scan=true` scannt zusätzlich das gesamte Subnetz (dauert länger, findet
   * aber auch Geräte, die auf mDNS nicht antworten).
   */
  router.get(
    '/integrations/discover',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const query = parseQuery(
        z.object({ type: integrationTypeSchema.optional(), scan: booleanQuery }),
        req,
      );
      const found = await container.integrations.discover(
        household.id,
        query.type,
        query.scan ?? false,
      );
      res.json({ found, scanned: query.scan ?? false });
    }),
  );

  /**
   * Bindet eine Bridge bzw. ein Gerät ein.
   * Bei Hue muss zuvor der Knopf auf der Bridge gedrückt werden – sonst
   * antwortet die Route mit HTTP 428 und dem Code `link_button_required`.
   */
  router.post(
    '/integrations',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const input = parseBody(addIntegrationSchema, req);
      const { integration, sync } = await container.integrations.add(household.id, input);

      // Neu verbundene Integration sofort in den Hintergrunddienst aufnehmen.
      await container.startBackgroundServices();

      res.status(201).json({
        integration: IntegrationRepository.toPublic(integration),
        devices: sync.devices,
        summary: { added: sync.added, updated: sync.updated, removed: sync.removed },
      });
    }),
  );

  router.get('/integrations/:id', (req, res) => {
    const integration = container.integrations.get(req.params.id as string);
    res.json({
      ...IntegrationRepository.toPublic(integration),
      devices: container.repos.devices.listByIntegration(integration.id),
    });
  });

  router.patch(
    '/integrations/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const changes = parseBody(
        z.object({ name: z.string().min(1).max(120).optional(), enabled: z.boolean().optional() }),
        req,
      );
      let integration = container.integrations.get(id);
      if (changes.name !== undefined) integration = await container.integrations.rename(id, changes.name);
      if (changes.enabled !== undefined) {
        integration = await container.integrations.setEnabled(id, changes.enabled);
      }
      res.json(IntegrationRepository.toPublic(integration));
    }),
  );

  /** Liest die Geräteliste neu ein (neue Lampen, entfernte Sensoren …). */
  router.post(
    '/integrations/:id/sync',
    asyncHandler(async (req, res) => {
      const result = await container.integrations.sync(req.params.id as string);
      res.json(result);
    }),
  );

  router.post(
    '/integrations/:id/test',
    asyncHandler(async (req, res) => {
      const integration = await container.integrations.test(req.params.id as string);
      res.json(IntegrationRepository.toPublic(integration));
    }),
  );

  router.delete(
    '/integrations/:id',
    asyncHandler(async (req, res) => {
      const result = await container.integrations.remove(req.params.id as string);
      res.json(result);
    }),
  );

  return router;
}
