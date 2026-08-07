/**
 * Zentrale Domänen-Typen des Hubs.
 *
 * Bewusst ohne `enum`, damit die Dateien auch vom nativen Node-Type-Stripping
 * (`node --experimental-strip-types`) verarbeitet werden können.
 */

// ---------------------------------------------------------------------------
// Integrationen
// ---------------------------------------------------------------------------

export const INTEGRATION_TYPES = ['hue', 'shelly'] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export const INTEGRATION_STATUS = ['pending', 'linked', 'error', 'disabled'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUS)[number];

/** Öffentlich sichtbare Konfiguration einer Hue Bridge. */
export interface HueIntegrationConfig {
  host: string;
  bridgeId: string;
  modelId?: string;
  apiVersion?: string;
  swVersion?: string;
}

/** Öffentlich sichtbare Konfiguration eines Shelly-Geräts. */
export interface ShellyIntegrationConfig {
  host: string;
  /** 1 = Gen1 (REST), 2 = Gen2/3/4 (JSON-RPC) */
  generation: 1 | 2;
  deviceId: string;
  model?: string;
  firmware?: string;
  authRequired: boolean;
  /** Benutzername für Digest/Basic-Auth. Gen2 verwendet immer "admin". */
  username?: string;
}

export type IntegrationConfig = HueIntegrationConfig | ShellyIntegrationConfig;

/** Verschlüsselt abgelegte Zugangsdaten einer Integration. */
export interface HueIntegrationSecrets {
  applicationKey: string;
  clientKey?: string;
}

export interface ShellyIntegrationSecrets {
  password?: string;
}

export type IntegrationSecrets = HueIntegrationSecrets | ShellyIntegrationSecrets;

export interface Integration {
  id: string;
  householdId: string;
  type: IntegrationType;
  name: string;
  status: IntegrationStatus;
  config: IntegrationConfig;
  /** AES-256-GCM verschlüsselte Secrets (siehe util/crypto.ts). */
  secretsEnc: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Integration ohne Secrets – das ist die Form, die über die API geht. */
export type PublicIntegration = Omit<Integration, 'secretsEnc'> & { hasSecrets: boolean };

// ---------------------------------------------------------------------------
// Haushalt / Räume
// ---------------------------------------------------------------------------

export const SETUP_STEPS = ['household', 'integrations', 'rooms', 'assign', 'done'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface Household {
  id: string;
  name: string;
  timezone: string;
  /** Land/Region, nur informativ (z. B. für Anzeigeformate). */
  locale: string;
  setupStep: SetupStep;
  setupCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Room {
  id: string;
  householdId: string;
  name: string;
  /** Freier Bezeichner für die UI, z. B. "living", "bedroom". */
  icon: string;
  /** Optionale Solltemperatur; wird von Automationen genutzt. */
  targetTemperatureC: number | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

export const CAPABILITIES = [
  'switch',
  'dimmer',
  'color',
  'color_temperature',
  'cover',
  'sensor.temperature',
  'sensor.humidity',
  'sensor.motion',
  'sensor.illuminance',
  'sensor.power',
  'sensor.energy',
  'sensor.battery',
  'button',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Messgrößen, die als Zeitreihe archiviert werden. */
export const METRICS = [
  'temperatureC',
  'humidity',
  'illuminanceLux',
  'powerW',
  'energyWh',
  'batteryPercent',
  'brightness',
] as const;
export type Metric = (typeof METRICS)[number];

export interface DeviceState {
  on?: boolean;
  /** 0..100 */
  brightness?: number;
  /** Farbtemperatur in Kelvin */
  colorTemperatureK?: number;
  /** Farbton 0..360 */
  hue?: number;
  /** Sättigung 0..100 */
  saturation?: number;
  /** Rollladen-/Jalousie-Position 0 (zu) .. 100 (offen) */
  position?: number;
  temperatureC?: number;
  humidity?: number;
  motion?: boolean;
  illuminanceLux?: number;
  powerW?: number;
  energyWh?: number;
  batteryPercent?: number;
  updatedAt?: string;
}

export interface Device {
  id: string;
  householdId: string;
  integrationId: string;
  roomId: string | null;
  /** ID innerhalb der Integration (Hue-Resource-ID bzw. Shelly-Komponente). */
  externalId: string;
  vendor: IntegrationType;
  name: string;
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
  capabilities: Capability[];
  state: DeviceState;
  reachable: boolean;
  /** Vom Nutzer ausgeblendete Geräte tauchen im Dashboard nicht auf. */
  hidden: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Kommandos
// ---------------------------------------------------------------------------

export type DeviceCommand =
  | { type: 'setPower'; on: boolean }
  | { type: 'toggle' }
  | { type: 'setBrightness'; brightness: number }
  | { type: 'setColorTemperature'; kelvin: number }
  | { type: 'setColor'; hue: number; saturation: number }
  | { type: 'setPosition'; position: number }
  | { type: 'identify' };

// ---------------------------------------------------------------------------
// Automationen
// ---------------------------------------------------------------------------

export type ComparisonOperator = '<' | '<=' | '>' | '>=' | '==' | '!=';

export type RuleTrigger =
  | {
      type: 'sensor';
      deviceId: string;
      metric: Metric;
      operator: ComparisonOperator;
      value: number;
      /** Bedingung muss so lange ununterbrochen erfüllt sein. */
      forSeconds?: number;
    }
  | { type: 'deviceState'; deviceId: string; property: 'on' | 'motion'; equals: boolean }
  | { type: 'schedule'; at: string; days: number[] };

export type RuleCondition =
  | { type: 'timeRange'; from: string; to: string }
  | { type: 'deviceState'; deviceId: string; property: 'on' | 'motion'; equals: boolean }
  | { type: 'sensor'; deviceId: string; metric: Metric; operator: ComparisonOperator; value: number };

export interface RuleTarget {
  deviceIds?: string[];
  roomIds?: string[];
  /** Alle Geräte des Haushalts mit passender Capability. */
  allWithCapability?: Capability;
}

export type RuleAction =
  | { type: 'command'; target: RuleTarget; command: DeviceCommand }
  | { type: 'webhook'; url: string; method?: 'GET' | 'POST'; body?: unknown }
  | { type: 'notify'; message: string };

export interface AutomationRule {
  id: string;
  householdId: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  actions: RuleAction[];
  cooldownSeconds: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Zugriffstoken
// ---------------------------------------------------------------------------

export interface AccessToken {
  id: string;
  householdId: string;
  name: string;
  /** SHA-256 des Tokens – das Klartext-Token wird nur einmal ausgegeben. */
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// ---------------------------------------------------------------------------
// Telemetrie
// ---------------------------------------------------------------------------

export interface TelemetrySample {
  /** ISO-Zeitstempel */
  t: string;
  deviceId: string;
  metric: Metric;
  value: number;
}

export interface TelemetryQuery {
  deviceId?: string;
  metric?: Metric;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface TelemetryAggregate {
  deviceId: string;
  metric: Metric;
  count: number;
  min: number;
  max: number;
  avg: number;
  first: TelemetrySample;
  last: TelemetrySample;
}
