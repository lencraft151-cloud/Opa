import { Router } from 'express';
import { z } from 'zod';
import { CAPABILITIES } from '../../core/types.js';
import type { DeviceFilter } from '../../services/deviceService.js';
import type { Container } from '../../container.js';
import { asyncHandler, booleanQuery, parseBody, parseQuery } from '../http.js';
import { commandSchema, deviceUpdateSchema, targetSchema } from '../validation.js';

export function deviceRoutes(container: Container): Router {
  const router = Router();

  router.get('/devices', (req, res) => {
    const household = container.households.require();
    const query = parseQuery(
      z.object({
        roomId: z.string().optional(),
        integrationId: z.string().optional(),
        capability: z.enum(CAPABILITIES).optional(),
        search: z.string().max(80).optional(),
        includeHidden: booleanQuery,
        unassigned: booleanQuery,
      }),
      req,
    );

    const filter: DeviceFilter = {};
    if (query.unassigned) filter.roomId = null;
    else if (query.roomId) filter.roomId = query.roomId;
    if (query.integrationId) filter.integrationId = query.integrationId;
    if (query.capability) filter.capability = query.capability;
    if (query.search) filter.search = query.search;
    if (query.includeHidden) filter.includeHidden = true;

    res.json(container.devices.list(household.id, filter));
  });

  router.get('/devices/:id', (req, res) => {
    res.json(container.devices.get(req.params.id as string));
  });

  router.patch(
    '/devices/:id',
    asyncHandler(async (req, res) => {
      const changes = parseBody(deviceUpdateSchema, req);
      res.json(await container.devices.update(req.params.id as string, changes));
    }),
  );

  router.delete(
    '/devices/:id',
    asyncHandler(async (req, res) => {
      await container.devices.remove(req.params.id as string);
      res.status(204).end();
    }),
  );

  /**
   * Steuert ein einzelnes Gerät.
   * Body-Beispiele:
   *   {"type":"setPower","on":true}
   *   {"type":"setBrightness","brightness":40}
   *   {"type":"setColorTemperature","kelvin":2700}
   */
  router.post(
    '/devices/:id/command',
    asyncHandler(async (req, res) => {
      const command = parseBody(commandSchema, req);
      const device = await container.devices.execute(req.params.id as string, command);
      res.json(device);
    }),
  );

  /** Steuert mehrere Geräte auf einmal (Raum, Fähigkeit oder Geräteliste). */
  router.post(
    '/devices/command',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const { target, command } = parseBody(
        z.object({ target: targetSchema, command: commandSchema }),
        req,
      );
      const results = await container.devices.executeMany(household.id, target, command);
      res.json({
        results,
        succeeded: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length,
      });
    }),
  );

  return router;
}
