import { Router } from 'express';
import { z } from 'zod';
import { ENERGY_PERIODS } from '../../services/energyService.js';
import type { Container } from '../../container.js';
import { asyncHandler, parseQuery } from '../http.js';

const periodSchema = z.object({
  period: z.enum(ENERGY_PERIODS).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export function energyRoutes(container: Container): Router {
  const router = Router();

  /**
   * Verbrauch und Kosten für einen Zeitraum – aufgeschlüsselt nach Gerät und
   * Raum, inklusive Hochrechnung und Standby-Verbrauchern.
   */
  router.get(
    '/energy/summary',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const query = parseQuery(periodSchema, req);
      const custom: { from?: Date; to?: Date } = {};
      if (query.from) custom.from = new Date(query.from);
      if (query.to) custom.to = new Date(query.to);

      res.json(
        await container.energy.summary(household.id, query.period ?? 'today', custom),
      );
    }),
  );

  /** Nur die Geräteliste – für Tabellen und Ranglisten. */
  router.get(
    '/energy/devices',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const query = parseQuery(periodSchema, req);
      const summary = await container.energy.summary(household.id, query.period ?? 'today');
      res.json({
        period: summary.period,
        currency: summary.currency,
        devices: summary.devices,
      });
    }),
  );

  /** Verbrauch je Raum. */
  router.get(
    '/energy/rooms',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const query = parseQuery(periodSchema, req);
      const summary = await container.energy.summary(household.id, query.period ?? 'today');
      res.json({ period: summary.period, currency: summary.currency, rooms: summary.rooms });
    }),
  );

  return router;
}
