import { miredToKelvin, round, xyToHsv } from '../../core/color.js';
import type { Capability, DeviceState } from '../../core/types.js';
import type { AdapterDevice } from '../types.js';

/**
 * Abbildung der Hue-API v1.
 *
 * Die alte runde Bridge (Modell BSB001) beherrscht die CLIP-API v2 nicht –
 * mit ihr ist der Hub ohne diesen Zweig blind. Auch eine neue Bridge mit sehr
 * alter Firmware fällt hierauf zurück.
 *
 * Zwei Eigenheiten der V1: Helligkeit läuft von 0..254 statt 0..100, und die
 * drei Sensoren eines Bewegungsmelders (Bewegung, Temperatur, Helligkeit)
 * erscheinen als getrennte Einträge. Sie werden über den MAC-Teil ihrer
 * `uniqueid` wieder zu einem Gerät zusammengefasst.
 */

export interface HueV1Light {
  state?: {
    on?: boolean;
    bri?: number;
    hue?: number;
    sat?: number;
    ct?: number;
    xy?: [number, number];
    colormode?: string;
    reachable?: boolean;
  };
  type?: string;
  name?: string;
  modelid?: string;
  manufacturername?: string;
  swversion?: string;
  uniqueid?: string;
}

export interface HueV1Sensor {
  state?: {
    temperature?: number;
    presence?: boolean;
    lightlevel?: number;
    dark?: boolean;
    daylight?: boolean;
    buttonevent?: number;
    lastupdated?: string;
  };
  config?: { on?: boolean; battery?: number; reachable?: boolean };
  type?: string;
  name?: string;
  modelid?: string;
  manufacturername?: string;
  swversion?: string;
  uniqueid?: string;
}

export interface HueV1Group {
  name?: string;
  lights?: string[];
  type?: string;
  class?: string;
}

/** Präfix der externen IDs, damit V1- und V2-Geräte nie verwechselt werden. */
export const V1_LIGHT_PREFIX = 'v1-light:';
export const V1_SENSOR_PREFIX = 'v1-sensor:';

export function parseV1ExternalId(
  externalId: string,
): { kind: 'light' | 'sensor'; id: string } | null {
  if (externalId.startsWith(V1_LIGHT_PREFIX)) {
    return { kind: 'light', id: externalId.slice(V1_LIGHT_PREFIX.length) };
  }
  if (externalId.startsWith(V1_SENSOR_PREFIX)) {
    return { kind: 'sensor', id: externalId.slice(V1_SENSOR_PREFIX.length) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Leuchten
// ---------------------------------------------------------------------------

export function lightState(light: HueV1Light): DeviceState {
  const state: DeviceState = {};
  const raw = light.state ?? {};

  if (typeof raw.on === 'boolean') state.on = raw.on;
  // V1 zählt Helligkeit in 1..254, der Hub in Prozent.
  if (typeof raw.bri === 'number') state.brightness = round((raw.bri / 254) * 100, 1);
  if (typeof raw.ct === 'number' && raw.ct > 0 && raw.colormode !== 'hs') {
    state.colorTemperatureK = miredToKelvin(raw.ct);
  }
  if (raw.colormode === 'hs' && typeof raw.hue === 'number' && typeof raw.sat === 'number') {
    state.hue = round((raw.hue / 65535) * 360, 1);
    state.saturation = round((raw.sat / 254) * 100, 1);
  } else if (raw.xy && raw.xy.length === 2) {
    const hsv = xyToHsv({ x: raw.xy[0], y: raw.xy[1] });
    state.hue = hsv.hue;
    state.saturation = hsv.saturation;
  }
  return state;
}

export function lightCapabilities(light: HueV1Light): Capability[] {
  const capabilities: Capability[] = ['switch'];
  const raw = light.state ?? {};
  if (typeof raw.bri === 'number') capabilities.push('dimmer');
  if (typeof raw.ct === 'number') capabilities.push('color_temperature');
  if (raw.xy || typeof raw.hue === 'number') capabilities.push('color');
  return capabilities;
}

// ---------------------------------------------------------------------------
// Sensoren
// ---------------------------------------------------------------------------

/** Nur diese Sensortypen liefern für den Hub verwertbare Messwerte. */
const USEFUL_SENSOR_TYPES = new Set([
  'ZLLTemperature',
  'ZLLPresence',
  'ZLLLightLevel',
  'ZLLSwitch',
  'ZGPSwitch',
]);

/** MAC-Teil der uniqueid – identifiziert das physische Gerät. */
export function sensorGroupKey(sensor: HueV1Sensor, fallback: string): string {
  const unique = sensor.uniqueid;
  if (!unique) return fallback;
  const mac = unique.split('-')[0];
  return mac && mac.length > 0 ? mac : fallback;
}

/** Hue liefert das Lichtniveau logarithmisch: lux = 10^((level - 1) / 10000). */
export function v1LightLevelToLux(level: number): number {
  if (level <= 0) return 0;
  return round(10 ** ((level - 1) / 10000), 1);
}

/**
 * Fasst Leuchten, Sensoren und Räume der V1-API zu Hub-Geräten zusammen.
 */
export function buildV1Devices(input: {
  lights: Record<string, HueV1Light>;
  sensors: Record<string, HueV1Sensor>;
  groups: Record<string, HueV1Group>;
}): AdapterDevice[] {
  const devices: AdapterDevice[] = [];

  // Raumzuordnung: Gruppen vom Typ "Room" nennen ihre Leuchten.
  const roomByLight = new Map<string, string>();
  for (const group of Object.values(input.groups ?? {})) {
    if (!group.name) continue;
    if (group.type && group.type !== 'Room' && group.type !== 'Zone') continue;
    for (const lightId of group.lights ?? []) {
      if (!roomByLight.has(lightId)) roomByLight.set(lightId, group.name);
    }
  }

  for (const [id, light] of Object.entries(input.lights ?? {})) {
    const device: AdapterDevice = {
      externalId: `${V1_LIGHT_PREFIX}${id}`,
      name: light.name ?? `Leuchte ${id}`,
      capabilities: lightCapabilities(light),
      state: lightState(light),
      reachable: light.state?.reachable !== false,
    };
    if (light.manufacturername) device.manufacturer = light.manufacturername;
    if (light.modelid) device.model = light.modelid;
    if (light.swversion) device.firmware = light.swversion;
    const room = roomByLight.get(id);
    if (room) device.suggestedRoom = room;
    devices.push(device);
  }

  // Sensoren des gleichen Geräts zusammenführen.
  const grouped = new Map<
    string,
    { sensors: HueV1Sensor[]; firstId: string }
  >();
  for (const [id, sensor] of Object.entries(input.sensors ?? {})) {
    if (!sensor.type || !USEFUL_SENSOR_TYPES.has(sensor.type)) continue;
    const key = sensorGroupKey(sensor, id);
    const entry = grouped.get(key) ?? { sensors: [], firstId: id };
    entry.sensors.push(sensor);
    grouped.set(key, entry);
  }

  for (const [key, entry] of grouped) {
    const capabilities: Capability[] = [];
    const state: DeviceState = {};
    let name: string | undefined;
    let model: string | undefined;
    let manufacturer: string | undefined;
    let firmware: string | undefined;
    let reachable = true;

    for (const sensor of entry.sensors) {
      manufacturer ??= sensor.manufacturername;
      model ??= sensor.modelid;
      firmware ??= sensor.swversion;
      if (sensor.config?.reachable === false) reachable = false;

      const battery = sensor.config?.battery;
      if (typeof battery === 'number' && !capabilities.includes('sensor.battery')) {
        capabilities.push('sensor.battery');
        state.batteryPercent = battery;
      }

      switch (sensor.type) {
        case 'ZLLTemperature': {
          const raw = sensor.state?.temperature;
          if (typeof raw === 'number') {
            // V1 liefert Hundertstel Grad: 2150 sind 21,50 °C.
            state.temperatureC = round(raw / 100, 2);
            capabilities.push('sensor.temperature');
          }
          break;
        }
        case 'ZLLPresence': {
          if (typeof sensor.state?.presence === 'boolean') {
            state.motion = sensor.state.presence;
            capabilities.push('sensor.motion');
          }
          // Der Bewegungssensor trägt den Namen, den der Nutzer vergeben hat.
          name = sensor.name ?? name;
          break;
        }
        case 'ZLLLightLevel': {
          const level = sensor.state?.lightlevel;
          if (typeof level === 'number') {
            state.illuminanceLux = v1LightLevelToLux(level);
            capabilities.push('sensor.illuminance');
          }
          break;
        }
        case 'ZLLSwitch':
        case 'ZGPSwitch': {
          capabilities.push('button');
          name = sensor.name ?? name;
          break;
        }
        default:
          break;
      }
    }

    if (capabilities.length === 0) continue;

    const device: AdapterDevice = {
      externalId: `${V1_SENSOR_PREFIX}${key}`,
      name: name ?? entry.sensors[0]?.name ?? `Sensor ${key}`,
      capabilities,
      state,
      reachable,
    };
    if (manufacturer) device.manufacturer = manufacturer;
    if (model) device.model = model;
    if (firmware) device.firmware = firmware;
    devices.push(device);
  }

  return devices;
}

// ---------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------

export interface HueV1LightState {
  on?: boolean;
  bri?: number;
  ct?: number;
  hue?: number;
  sat?: number;
}

export function percentToBri(percent: number): number {
  return Math.max(1, Math.min(254, Math.round((percent / 100) * 254)));
}

export function degreesToHue(degrees: number): number {
  return Math.max(0, Math.min(65535, Math.round((degrees / 360) * 65535)));
}

export function percentToSat(percent: number): number {
  return Math.max(0, Math.min(254, Math.round((percent / 100) * 254)));
}
