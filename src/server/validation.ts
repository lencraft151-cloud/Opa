import { z } from 'zod';
import { CAPABILITIES, INTEGRATION_TYPES, METRICS, SETUP_STEPS } from '../core/types.js';

export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setPower'), on: z.boolean() }),
  z.object({ type: z.literal('toggle') }),
  z.object({ type: z.literal('setBrightness'), brightness: z.number().min(0).max(100) }),
  z.object({ type: z.literal('setColorTemperature'), kelvin: z.number().min(1500).max(10000) }),
  z.object({
    type: z.literal('setColor'),
    hue: z.number().min(0).max(360),
    saturation: z.number().min(0).max(100),
  }),
  z.object({ type: z.literal('setPosition'), position: z.number().min(0).max(100) }),
  z.object({ type: z.literal('openCover') }),
  z.object({ type: z.literal('closeCover') }),
  z.object({ type: z.literal('stopCover') }),
  z.object({ type: z.literal('setTilt'), tilt: z.number().min(0).max(100) }),
  z.object({ type: z.literal('identify') }),
]);

export const targetSchema = z
  .object({
    deviceIds: z.array(z.string()).optional(),
    roomIds: z.array(z.string()).optional(),
    allWithCapability: z.enum(CAPABILITIES).optional(),
  })
  .refine(
    (value) =>
      (value.deviceIds?.length ?? 0) > 0 ||
      (value.roomIds?.length ?? 0) > 0 ||
      value.allWithCapability !== undefined,
    { message: 'Es muss mindestens ein Ziel angegeben werden' },
  );

export const operatorSchema = z.enum(['<', '<=', '>', '>=', '==', '!=']);
export const metricSchema = z.enum(METRICS);
export const integrationTypeSchema = z.enum(INTEGRATION_TYPES);
export const setupStepSchema = z.enum(SETUP_STEPS);

const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Uhrzeit im Format HH:MM erwartet');

export const triggerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('sensor'),
    deviceId: z.string().min(1),
    metric: metricSchema,
    operator: operatorSchema,
    value: z.number(),
    forSeconds: z.number().int().min(0).max(86_400).optional(),
  }),
  z.object({
    type: z.literal('deviceState'),
    deviceId: z.string().min(1),
    property: z.enum(['on', 'motion']),
    equals: z.boolean(),
  }),
  z.object({
    type: z.literal('schedule'),
    at: timeSchema,
    days: z.array(z.number().int().min(0).max(6)).default([]),
  }),
]);

export const conditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('timeRange'), from: timeSchema, to: timeSchema }),
  z.object({
    type: z.literal('deviceState'),
    deviceId: z.string().min(1),
    property: z.enum(['on', 'motion']),
    equals: z.boolean(),
  }),
  z.object({
    type: z.literal('sensor'),
    deviceId: z.string().min(1),
    metric: metricSchema,
    operator: operatorSchema,
    value: z.number(),
  }),
]);

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('command'), target: targetSchema, command: commandSchema }),
  z.object({
    type: z.literal('webhook'),
    url: z.string().url(),
    method: z.enum(['GET', 'POST']).optional(),
    body: z.unknown().optional(),
  }),
  z.object({ type: z.literal('notify'), message: z.string().min(1).max(500) }),
]);

export const ruleSchema = z.object({
  name: z.string().min(1).max(120),
  enabled: z.boolean().optional(),
  trigger: triggerSchema,
  conditions: z.array(conditionSchema).max(10).optional(),
  actions: z.array(actionSchema).min(1).max(10),
  cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
});

export const ruleUpdateSchema = ruleSchema.partial();

export const householdSchema = z.object({
  name: z.string().min(1).max(120),
  timezone: z.string().min(1).max(64).optional(),
  locale: z.string().min(2).max(16).optional(),
  // Der Assistent fragt den Strompreis gleich mit ab – ohne diese Felder
  // würde die Eingabe beim Anlegen stillschweigend verworfen.
  pricePerKwh: z.number().min(0).max(10).optional(),
  currency: z.string().min(1).max(8).optional(),
  basePricePerMonth: z.number().min(0).max(1000).optional(),
});

export const roomSchema = z.object({
  name: z.string().min(1).max(80),
  icon: z.string().max(40).optional(),
  targetTemperatureC: z.number().min(-20).max(40).nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
});

export const addIntegrationSchema = z.object({
  type: integrationTypeSchema,
  host: z.string().min(3).max(255),
  name: z.string().max(120).optional(),
  username: z.string().max(64).optional(),
  password: z.string().max(128).optional(),
  importRooms: z.boolean().optional(),
});

export const deviceUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  roomId: z.string().nullable().optional(),
  hidden: z.boolean().optional(),
});
