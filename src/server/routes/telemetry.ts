import { Router } from 'express';
import { z } from 'zod';
import type { TelemetryQuery } from '../../core/types.js';
import type { Container } from '../../container.js';
import { asyncHandler, numberQuery, parseQuery } from '../http.js';
import { metricSchema } from '../validation.js';

const rangeSchema = z.object({
  deviceId: z.string().optional(),
  metric: metricSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  hours: numberQuery(1, 24 * 365),
  limit: numberQuery(1, 20000),
});

export function telemetryRoutes(container: Container): Router {
  const router = Router();

  /** Rohe Messwerte. Standardzeitraum: die letzten 24 Stunden. */
  router.get(
    '/telemetry',
    asyncHandler(async (req, res) => {
      const query = parseQuery(rangeSchema, req);
      const samples = await container.telemetry.query(toQuery(query));
      res.json({ count: samples.length, samples });
    }),
  );

  /** Verdichtete Zeitreihe für Diagramme. */
  router.get(
    '/telemetry/series',
    asyncHandler(async (req, res) => {
      const query = parseQuery(
        rangeSchema.extend({ bucketMinutes: numberQuery(1, 1440) }),
        req,
      );
      const series = await container.telemetry.series(toQuery(query), query.bucketMinutes ?? 15);
      res.json({ bucketMinutes: query.bucketMinutes ?? 15, points: series.length, series });
    }),
  );

  /** Min/Max/Mittelwert je Gerät und Messgröße. */
  router.get(
    '/telemetry/aggregate',
    asyncHandler(async (req, res) => {
      const query = parseQuery(rangeSchema, req);
      res.json({ aggregates: await container.telemetry.aggregate(toQuery(query)) });
    }),
  );

  /**
   * Aktuelles Klima je Raum – die Ansicht, für die die meisten Nutzer den Hub
   * überhaupt aufmachen.
   */
  router.get('/telemetry/climate', (_req, res) => {
    const household = container.households.require();
    const rooms = container.rooms.list(household.id);
    const devices = container.devices.list(household.id);

    const perRoom = rooms.map((room) => {
      const roomDevices = devices.filter((device) => device.roomId === room.id);
      const temperatures = roomDevices
        .map((device) => device.state.temperatureC)
        .filter((value): value is number => typeof value === 'number');
      const humidities = roomDevices
        .map((device) => device.state.humidity)
        .filter((value): value is number => typeof value === 'number');

      return {
        roomId: room.id,
        roomName: room.name,
        targetTemperatureC: room.targetTemperatureC,
        temperatureC: temperatures.length > 0 ? round1(mean(temperatures)) : null,
        humidity: humidities.length > 0 ? round1(mean(humidities)) : null,
        sensors: roomDevices
          .filter(
            (device) =>
              device.capabilities.includes('sensor.temperature') ||
              device.capabilities.includes('sensor.humidity'),
          )
          .map((device) => ({
            deviceId: device.id,
            name: device.name,
            vendor: device.vendor,
            temperatureC: device.state.temperatureC ?? null,
            humidity: device.state.humidity ?? null,
            batteryPercent: device.state.batteryPercent ?? null,
            reachable: device.reachable,
            updatedAt: device.state.updatedAt ?? null,
          })),
      };
    });

    const unassigned = devices.filter(
      (device) => device.roomId === null && typeof device.state.temperatureC === 'number',
    );

    res.json({
      rooms: perRoom,
      unassignedSensors: unassigned.map((device) => ({
        deviceId: device.id,
        name: device.name,
        temperatureC: device.state.temperatureC ?? null,
        humidity: device.state.humidity ?? null,
      })),
    });
  });

  return router;
}

function toQuery(query: z.infer<typeof rangeSchema>): TelemetryQuery {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - (query.hours ?? 24) * 60 * 60 * 1000);

  const result: TelemetryQuery = { from, to };
  if (query.deviceId) result.deviceId = query.deviceId;
  if (query.metric) result.metric = query.metric;
  if (query.limit !== undefined) result.limit = query.limit;
  return result;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
