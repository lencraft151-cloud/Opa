import { Router } from 'express';
import { z } from 'zod';
import type { Device } from '../../core/types.js';
import type { Container } from '../../container.js';
import { asyncHandler, parseBody } from '../http.js';
import { commandSchema, roomSchema } from '../validation.js';

export function roomRoutes(container: Container): Router {
  const router = Router();

  router.get('/rooms', (_req, res) => {
    const household = container.households.require();
    const rooms = container.rooms.list(household.id);
    const devices = container.devices.list(household.id);

    res.json(
      rooms.map((room) => {
        const roomDevices = devices.filter((device) => device.roomId === room.id);
        return { ...room, deviceCount: roomDevices.length, climate: climateOf(roomDevices) };
      }),
    );
  });

  router.get('/rooms/:id', (req, res) => {
    const room = container.rooms.get(req.params.id as string);
    const devices = container.devices.list(room.householdId, { roomId: room.id });
    res.json({ ...room, devices, climate: climateOf(devices) });
  });

  router.post(
    '/rooms',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const input = parseBody(roomSchema, req);
      res.status(201).json(await container.rooms.create(household.id, input));
    }),
  );

  router.patch(
    '/rooms/:id',
    asyncHandler(async (req, res) => {
      const changes = parseBody(roomSchema.partial(), req);
      res.json(await container.rooms.update(req.params.id as string, changes));
    }),
  );

  router.delete(
    '/rooms/:id',
    asyncHandler(async (req, res) => {
      await container.rooms.remove(req.params.id as string);
      res.status(204).end();
    }),
  );

  router.post(
    '/rooms/reorder',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const { order } = parseBody(z.object({ order: z.array(z.string()).min(1) }), req);
      res.json(await container.rooms.reorder(household.id, order));
    }),
  );

  /** Schaltet alle passenden Geräte eines Raums (z. B. „Licht aus im Bad“). */
  router.post(
    '/rooms/:id/command',
    asyncHandler(async (req, res) => {
      const room = container.rooms.get(req.params.id as string);
      const command = parseBody(commandSchema, req);
      const results = await container.devices.executeMany(
        room.householdId,
        { roomIds: [room.id] },
        command,
      );
      res.json({ results });
    }),
  );

  return router;
}

/** Aktuelles Raumklima aus allen Sensoren im Raum. */
function climateOf(devices: Device[]): {
  temperatureC: number | null;
  humidity: number | null;
  powerW: number;
  sensorCount: number;
} {
  const temperatures = devices
    .map((device) => device.state.temperatureC)
    .filter((value): value is number => typeof value === 'number');
  const humidities = devices
    .map((device) => device.state.humidity)
    .filter((value): value is number => typeof value === 'number');
  const power = devices.reduce(
    (sum, device) => sum + (typeof device.state.powerW === 'number' ? device.state.powerW : 0),
    0,
  );

  return {
    temperatureC: temperatures.length > 0 ? average(temperatures) : null,
    humidity: humidities.length > 0 ? average(humidities) : null,
    powerW: Math.round(power * 100) / 100,
    sensorCount: temperatures.length + humidities.length,
  };
}

function average(values: number[]): number {
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}
