import { miredToKelvin, round, xyToHsv } from '../../core/color.js';
import type { Capability, DeviceState } from '../../core/types.js';
import type { HueResource } from './client.js';

/** Service-IDs, die zu einem Hue-Gerät gehören. */
export interface HueDeviceServices {
  light?: string;
  temperature?: string;
  motion?: string;
  lightLevel?: string;
  devicePower?: string;
  connectivity?: string;
  buttons: string[];
}

export interface HueIndex {
  /** Alle Ressourcen nach ID. */
  byId: Map<string, HueResource>;
  /** Geräte-ID → zugehörige Services. */
  services: Map<string, HueDeviceServices>;
  /** Geräte-ID → Raumname (aus den Hue-Räumen). */
  roomByDevice: Map<string, string>;
  /** Service-ID → Geräte-ID (Besitzer). */
  ownerByService: Map<string, string>;
}

const SERVICE_FIELD: Record<string, keyof Omit<HueDeviceServices, 'buttons'>> = {
  light: 'light',
  temperature: 'temperature',
  motion: 'motion',
  light_level: 'lightLevel',
  device_power: 'devicePower',
  zigbee_connectivity: 'connectivity',
};

export function indexResources(resources: HueResource[]): HueIndex {
  const byId = new Map<string, HueResource>();
  const services = new Map<string, HueDeviceServices>();
  const roomByDevice = new Map<string, string>();
  const ownerByService = new Map<string, string>();

  for (const resource of resources) byId.set(resource.id, resource);

  for (const resource of resources) {
    if (resource.type !== 'device') continue;
    const entry: HueDeviceServices = { buttons: [] };
    for (const service of resource.services ?? []) {
      ownerByService.set(service.rid, resource.id);
      if (service.rtype === 'button') {
        entry.buttons.push(service.rid);
        continue;
      }
      const field = SERVICE_FIELD[service.rtype];
      if (field) entry[field] = service.rid;
    }
    services.set(resource.id, entry);
  }

  for (const resource of resources) {
    if (resource.type !== 'room' && resource.type !== 'zone') continue;
    const name = resource.metadata?.name;
    if (!name) continue;
    for (const child of resource.children ?? []) {
      if (child.rtype === 'device' && !roomByDevice.has(child.rid)) {
        roomByDevice.set(child.rid, name);
      }
    }
  }

  return { byId, services, roomByDevice, ownerByService };
}

export function capabilitiesFor(deviceId: string, index: HueIndex): Capability[] {
  const services = index.services.get(deviceId);
  if (!services) return [];
  const capabilities: Capability[] = [];

  if (services.light) {
    capabilities.push('switch');
    const light = index.byId.get(services.light);
    if (light?.dimming) capabilities.push('dimmer');
    if (light?.color_temperature) capabilities.push('color_temperature');
    if (light?.color) capabilities.push('color');
  }
  if (services.temperature) capabilities.push('sensor.temperature');
  if (services.motion) capabilities.push('sensor.motion');
  if (services.lightLevel) capabilities.push('sensor.illuminance');
  if (services.devicePower) capabilities.push('sensor.battery');
  if (services.buttons.length > 0) capabilities.push('button');

  return capabilities;
}

/** Hue liefert das Lichtniveau logarithmisch: lux = 10^((level - 1) / 10000). */
export function hueLightLevelToLux(level: number): number {
  if (level <= 0) return 0;
  return round(10 ** ((level - 1) / 10000), 1);
}

export function stateFor(deviceId: string, index: HueIndex): DeviceState {
  const services = index.services.get(deviceId);
  const state: DeviceState = {};
  if (!services) return state;

  if (services.light) {
    const light = index.byId.get(services.light);
    if (light) {
      if (light.on) state.on = light.on.on;
      if (light.dimming) state.brightness = round(light.dimming.brightness, 1);
      if (light.color_temperature?.mirek && light.color_temperature.mirek_valid !== false) {
        state.colorTemperatureK = miredToKelvin(light.color_temperature.mirek);
      }
      if (light.color?.xy) {
        const hsv = xyToHsv(light.color.xy);
        state.hue = hsv.hue;
        state.saturation = hsv.saturation;
      }
    }
  }

  if (services.temperature) {
    const sensor = index.byId.get(services.temperature);
    const value = sensor?.temperature?.temperature_report?.temperature ?? sensor?.temperature?.temperature;
    if (typeof value === 'number' && sensor?.temperature?.temperature_valid !== false) {
      state.temperatureC = round(value, 2);
    }
  }

  if (services.motion) {
    const sensor = index.byId.get(services.motion);
    const value = sensor?.motion?.motion_report?.motion ?? sensor?.motion?.motion;
    if (typeof value === 'boolean' && sensor?.motion?.motion_valid !== false) {
      state.motion = value;
    }
  }

  if (services.lightLevel) {
    const sensor = index.byId.get(services.lightLevel);
    const level = sensor?.light?.light_level_report?.light_level ?? sensor?.light?.light_level;
    if (typeof level === 'number' && sensor?.light?.light_level_valid !== false) {
      state.illuminanceLux = hueLightLevelToLux(level);
    }
  }

  if (services.devicePower) {
    const power = index.byId.get(services.devicePower);
    if (typeof power?.power_state?.battery_level === 'number') {
      state.batteryPercent = power.power_state.battery_level;
    }
  }

  return state;
}

export function isReachable(deviceId: string, index: HueIndex): boolean {
  const services = index.services.get(deviceId);
  if (!services?.connectivity) return true; // Ohne Info gehen wir von erreichbar aus.
  const connectivity = index.byId.get(services.connectivity);
  return connectivity?.status !== 'connectivity_issue';
}

/**
 * Die Bridge selbst taucht als `device` auf, ist für den Hub aber kein
 * steuerbares Gerät.
 */
export function isControllableDevice(deviceId: string, index: HueIndex): boolean {
  return capabilitiesFor(deviceId, index).length > 0;
}

export function deviceNameOf(resource: HueResource): string {
  return resource.metadata?.name ?? resource.product_data?.product_name ?? 'Hue-Gerät';
}
