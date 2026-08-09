import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { clearSessionCookie, requireAdminUnlessOpen } from '../auth.js';
import { asyncHandler, parseBody } from '../http.js';
import { appearanceSchema, presenceSchema } from '../validation.js';

export function householdRoutes(container: Container): Router {
  const router = Router();

  router.get('/household', (_req, res) => {
    res.json(container.households.require());
  });

  router.patch(
    '/household',
    asyncHandler(async (req, res) => {
      const changes = parseBody(
        z.object({
          name: z.string().min(1).max(120).optional(),
          timezone: z.string().min(1).max(64).optional(),
          locale: z.string().min(2).max(16).optional(),
          // Grundlage der Stromkostenrechnung
          pricePerKwh: z.number().min(0).max(10).optional(),
          currency: z.string().min(1).max(8).optional(),
          basePricePerMonth: z.number().min(0).max(1000).optional(),
          // Firmware-Auto-Updates
          autoUpdate: z.boolean().optional(),
          autoUpdateFrom: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit im Format HH:MM erwartet')
            .optional(),
          autoUpdateTo: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit im Format HH:MM erwartet')
            .optional(),
          // Darstellung: Schriftgröße, Akzentfarben, Helligkeit, Bewegung
          appearance: appearanceSchema.optional(),
          // Urlaubsmodus – bedient wird er über /api/presence
          presence: presenceSchema.optional(),
        }),
        req,
      );
      res.json(await container.households.update(changes));
    }),
  );

  /** Kennzahlen für das Dashboard. */
  router.get('/household/summary', (_req, res) => {
    const household = container.households.require();
    const summary = container.devices.summary(household.id);
    const rooms = container.rooms.list(household.id);
    const integrations = container.integrations.list(household.id);

    res.json({
      household,
      ...summary,
      rooms: rooms.length,
      integrations: {
        total: integrations.length,
        linked: integrations.filter((item) => item.status === 'linked').length,
        error: integrations.filter((item) => item.status === 'error').length,
        // Fehlermeldungen gehören ins Dashboard, nicht nur in die Einstellungen.
        problems: integrations
          .filter((item) => item.status === 'error')
          .map((item) => ({ id: item.id, name: item.name, error: item.lastError })),
      },
      updatesAvailable: integrations.filter((item) => item.updateInfo?.updateAvailable).length,
      automations: container.automations.list(household.id).length,
    });
  });

  // ---------------------------------------------------------------------------
  // Zugriffstoken
  // ---------------------------------------------------------------------------

  router.get('/household/tokens', (_req, res) => {
    res.json(
      container.households.listTokens().map((token) => ({
        id: token.id,
        name: token.name,
        createdAt: token.createdAt,
        lastUsedAt: token.lastUsedAt,
      })),
    );
  });

  router.post(
    '/household/tokens',
    asyncHandler(async (req, res) => {
      const { name } = parseBody(z.object({ name: z.string().min(1).max(80) }), req);
      const household = container.households.require();
      const { token, record } = await container.households.issueToken(household.id, name);
      res.status(201).json({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        accessToken: token,
        hint: 'Das Token wird nur einmal angezeigt.',
      });
    }),
  );

  router.delete(
    '/household/tokens/:id',
    asyncHandler(async (req, res) => {
      await container.households.revokeToken(req.params.id as string);
      res.status(204).end();
    }),
  );

  /**
   * Haushalt löschen – alles weg, der Hub startet danach wieder mit dem
   * Assistenten.
   *
   * Der Name muss im Body stehen und genau stimmen. Die Oberfläche fragt
   * zusätzlich fünfmal nach; der Server verlässt sich darauf aber nicht,
   * denn er wird nicht nur von der Oberfläche aufgerufen.
   */
  router.delete(
    '/household',
    asyncHandler(async (req, res) => {
      requireAdminUnlessOpen(req, container.config.authDisabled);
      const { confirmName } = parseBody(
        z.object({ confirmName: z.string().min(1).max(120) }),
        req,
      );

      const result = await container.backup.reset(confirmName);

      // Die Hintergrunddienste liefen für einen Haushalt, den es nicht mehr
      // gibt – sie jetzt weiterlaufen zu lassen, wäre nur Lärm.
      await container.stopBackgroundServices();

      // Und die eigene Sitzung ist mit gelöscht worden.
      clearSessionCookie(req, res);

      res.json({
        ...result,
        message: 'Der Haushalt wurde gelöscht. Der Hub startet nun wieder mit der Einrichtung.',
      });
    }),
  );

  return router;
}
