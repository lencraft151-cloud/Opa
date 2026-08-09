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

  /**
   * Erneut verbinden: neue Zugangsdaten, oder bei Hue nach einem erneuten
   * Knopfdruck. Geräte, Räume und Automationen bleiben erhalten – die
   * Integration behält ihre ID.
   */
  router.post(
    '/integrations/:id/relink',
    asyncHandler(async (req, res) => {
      const input = parseBody(
        z.object({
          host: z.string().min(3).max(255).optional(),
          username: z.string().max(64).optional(),
          password: z.string().max(128).optional(),
        }),
        req,
      );
      const result = await container.integrations.relink(req.params.id as string, input);
      res.json({
        integration: IntegrationRepository.toPublic(result.integration),
        sync: result.sync,
      });
    }),
  );

  /**
   * Was beim letzten Einlesen liegen blieb.
   *
   * Beantwortet die Frage „wo ist mein Rollladen?" mit einer Liste statt mit
   * Schweigen: Welche Kanäle der Hub gesehen und warum er sie übersprungen
   * hat. Nicht jeder Adapter kann das – dann bleibt die Liste leer.
   */
  router.get('/integrations/:id/diagnostics', (req, res) => {
    const integration = container.integrations.get(req.params.id as string);
    const adapter = container.registry.get(integration.type);
    const devices = container.devices.list(integration.householdId, {
      integrationId: integration.id,
      includeHidden: true,
    });

    const skipped = adapter.diagnostics
      ? adapter.diagnostics(container.integrations.contextFor(integration))
      : [];

    res.json({
      integrationId: integration.id,
      name: integration.name,
      type: integration.type,
      status: integration.status,
      lastError: integration.lastError,
      lastSeenAt: integration.lastSeenAt,
      deviceCount: devices.length,
      devices: devices.map((device) => ({
        id: device.id,
        name: device.name,
        externalId: device.externalId,
        capabilities: device.capabilities,
        capabilityOverride: device.capabilityOverride,
        reachable: device.reachable,
        hidden: device.hidden,
      })),
      skipped,
      supportsDiagnostics: typeof adapter.diagnostics === 'function',
    });
  });

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
