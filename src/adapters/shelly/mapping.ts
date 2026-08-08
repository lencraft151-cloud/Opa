import { rgbToHsv, round } from '../../core/color.js';
import type { Capability, CoverState, DeviceState } from '../../core/types.js';

/**
 * Ein Shelly ist ein physisches Gerät mit mehreren Komponenten (Relais,
 * Rollladen, Temperaturfühler …). Der Hub bildet jede Komponente auf ein
 * eigenes Gerät ab – so lässt sich z. B. Kanal 1 einem anderen Raum zuordnen
 * als Kanal 2.
 */
export interface ShellyComponent {
  /** Komponenten-ID im Gen2-Stil, z. B. `switch:0`, `temperature:ext1`. */
  externalId: string;
  name: string;
  capabilities: Capability[];
  state: DeviceState;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
}

function arr(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export interface ShellyNaming {
  deviceName: string;
  /** Komponenten-ID → benutzerdefinierter Name aus der Gerätekonfiguration. */
  channelNames: Map<string, string>;
}

function label(naming: ShellyNaming, externalId: string, fallback: string): string {
  const custom = naming.channelNames.get(externalId);
  if (custom) return custom;
  return `${naming.deviceName} · ${fallback}`;
}

// ---------------------------------------------------------------------------
// Gen2 / Gen3 / Gen4 (JSON-RPC)
// ---------------------------------------------------------------------------

export function parseGen2Status(status: Json, naming: ShellyNaming): ShellyComponent[] {
  const components: ShellyComponent[] = [];

  for (const [key, rawValue] of Object.entries(status)) {
    const value = obj(rawValue);
    if (!value) continue;
    const [kind, indexRaw] = key.split(':');
    if (!kind || indexRaw === undefined) continue;
    const index = Number(indexRaw);
    const channel = Number.isFinite(index) ? index : 0;

    switch (kind) {
      case 'switch': {
        const state: DeviceState = {};
        const capabilities: Capability[] = ['switch'];
        const on = bool(value['output']);
        if (on !== undefined) state.on = on;
        const power = num(value['apower']);
        if (power !== undefined) {
          state.powerW = round(power, 2);
          capabilities.push('sensor.power');
        }
        const energy = num(obj(value['aenergy'])?.['total']);
        if (energy !== undefined) {
          state.energyWh = round(energy, 2);
          capabilities.push('sensor.energy');
        }
        components.push({
          externalId: key,
          name: label(naming, key, `Schalter ${channel + 1}`),
          capabilities,
          state,
        });
        break;
      }

      case 'light':
      case 'rgbw':
      case 'rgb': {
        const state: DeviceState = {};
        const capabilities: Capability[] = ['switch', 'dimmer'];
        const on = bool(value['output']);
        if (on !== undefined) state.on = on;
        const brightness = num(value['brightness']);
        if (brightness !== undefined) state.brightness = round(brightness, 1);
        const rgb = arr(value['rgb']);
        if (rgb && rgb.length >= 3) {
          const hsv = rgbToHsv({
            r: num(rgb[0]) ?? 0,
            g: num(rgb[1]) ?? 0,
            b: num(rgb[2]) ?? 0,
          });
          state.hue = hsv.hue;
          state.saturation = hsv.saturation;
          capabilities.push('color');
        }
        components.push({
          externalId: key,
          name: label(naming, key, `Licht ${channel + 1}`),
          capabilities,
          state,
        });
        break;
      }

      case 'cover': {
        const state: DeviceState = {};
        const capabilities: Capability[] = ['cover'];
        const position = num(value['current_pos']);
        if (position !== undefined) state.position = position;
        state.coverState = normalizeCoverState(str(value['state']), position, 2);

        // Jalousien melden zusätzlich die Lamellenstellung.
        const tilt = num(value['slat_pos']) ?? num(obj(value['slat'])?.['pos']);
        if (tilt !== undefined) {
          state.tilt = tilt;
          capabilities.push('cover.tilt');
        }

        const power = num(value['apower']);
        if (power !== undefined) {
          state.powerW = round(power, 2);
          capabilities.push('sensor.power');
        }
        components.push({
          externalId: key,
          name: label(naming, key, `Rollladen ${channel + 1}`),
          capabilities,
          state,
        });
        break;
      }

      case 'temperature': {
        const tC = num(value['tC']);
        if (tC === undefined) break;
        components.push({
          externalId: key,
          name: label(naming, key, `Temperatur ${channel + 1}`),
          capabilities: ['sensor.temperature'],
          state: { temperatureC: round(tC, 2) },
        });
        break;
      }

      case 'humidity': {
        const rh = num(value['rh']);
        if (rh === undefined) break;
        components.push({
          externalId: key,
          name: label(naming, key, `Luftfeuchte ${channel + 1}`),
          capabilities: ['sensor.humidity'],
          state: { humidity: round(rh, 1) },
        });
        break;
      }

      case 'thermostat': {
        // Wall Display und BLU TRV melden Soll- und Istwert getrennt.
        const target = num(value['target_C']) ?? num(obj(value['target_t'])?.['value']);
        const current = num(value['current_C']) ?? num(value['tC']);
        if (target === undefined && current === undefined) break;
        const state: DeviceState = {};
        if (target !== undefined) state.targetTemperatureC = round(target, 1);
        if (current !== undefined) state.temperatureC = round(current, 2);
        const capabilities: Capability[] = ['thermostat'];
        if (current !== undefined) capabilities.push('sensor.temperature');
        components.push({
          externalId: key,
          name: label(naming, key, `Heizung ${channel + 1}`),
          capabilities,
          state,
        });
        break;
      }

      case 'devicepower': {
        const percent = num(obj(value['battery'])?.['percent']);
        if (percent === undefined) break;
        components.push({
          externalId: key,
          name: label(naming, key, 'Batterie'),
          capabilities: ['sensor.battery'],
          state: { batteryPercent: round(percent, 0) },
        });
        break;
      }

      case 'pm1':
      case 'em1':
      case 'em': {
        const power =
          num(value['apower']) ?? num(value['act_power']) ?? num(value['total_act_power']);
        if (power === undefined) break;
        const state: DeviceState = { powerW: round(power, 2) };
        const capabilities: Capability[] = ['sensor.power'];
        const energy =
          num(obj(value['aenergy'])?.['total']) ?? num(obj(value['total_act_energy'])?.['total']);
        if (energy !== undefined) {
          state.energyWh = round(energy, 2);
          capabilities.push('sensor.energy');
        }
        components.push({
          externalId: key,
          name: label(naming, key, `Verbrauch ${channel + 1}`),
          capabilities,
          state,
        });
        break;
      }

      default:
        break;
    }
  }

  return components;
}

// ---------------------------------------------------------------------------
// Gen1 (REST)
// ---------------------------------------------------------------------------

export function parseGen1Status(status: Json, naming: ShellyNaming): ShellyComponent[] {
  const components: ShellyComponent[] = [];
  const meters = arr(status['meters']) ?? arr(status['emeters']) ?? [];
  const isEmeter = arr(status['meters']) === undefined && arr(status['emeters']) !== undefined;

  const relays = arr(status['relays']) ?? [];
  relays.forEach((rawRelay, index) => {
    const relay = obj(rawRelay);
    if (!relay) return;
    const externalId = `switch:${index}`;
    const state: DeviceState = {};
    const capabilities: Capability[] = ['switch'];
    const on = bool(relay['ison']);
    if (on !== undefined) state.on = on;

    const meter = obj(meters[index]);
    if (meter) {
      const power = num(meter['power']);
      if (power !== undefined) {
        state.powerW = round(power, 2);
        capabilities.push('sensor.power');
      }
      const total = num(meter['total']);
      if (total !== undefined) {
        // Gen1-Zähler liefern Watt-Minuten, E-Meter dagegen Wattstunden.
        state.energyWh = round(isEmeter ? total : total / 60, 2);
        capabilities.push('sensor.energy');
      }
    }

    components.push({
      externalId,
      name: label(naming, externalId, `Schalter ${index + 1}`),
      capabilities,
      state,
    });
  });

  const lights = arr(status['lights']) ?? [];
  lights.forEach((rawLight, index) => {
    const light = obj(rawLight);
    if (!light) return;
    const externalId = `light:${index}`;
    const state: DeviceState = {};
    const capabilities: Capability[] = ['switch', 'dimmer'];
    const on = bool(light['ison']);
    if (on !== undefined) state.on = on;
    const brightness = num(light['brightness']);
    if (brightness !== undefined) state.brightness = round(brightness, 1);
    const red = num(light['red']);
    const green = num(light['green']);
    const blue = num(light['blue']);
    if (red !== undefined && green !== undefined && blue !== undefined) {
      const hsv = rgbToHsv({ r: red, g: green, b: blue });
      state.hue = hsv.hue;
      state.saturation = hsv.saturation;
      capabilities.push('color');
    }
    components.push({
      externalId,
      name: label(naming, externalId, `Licht ${index + 1}`),
      capabilities,
      state,
    });
  });

  const rollers = arr(status['rollers']) ?? [];
  rollers.forEach((rawRoller, index) => {
    const roller = obj(rawRoller);
    if (!roller) return;
    const externalId = `cover:${index}`;
    const state: DeviceState = {};
    const position = num(roller['current_pos']);
    if (position !== undefined) state.position = position;
    state.coverState = normalizeCoverState(str(roller['state']), position, 1);
    const power = num(roller['power']);
    const capabilities: Capability[] = ['cover'];
    if (power !== undefined) {
      state.powerW = round(power, 2);
      capabilities.push('sensor.power');
    }
    components.push({
      externalId,
      name: label(naming, externalId, `Rollladen ${index + 1}`),
      capabilities,
      state,
    });
  });

  // Reine Messgeräte (Shelly EM/3EM) ohne Relais
  if (relays.length === 0 && meters.length > 0) {
    meters.forEach((rawMeter, index) => {
      const meter = obj(rawMeter);
      if (!meter) return;
      const power = num(meter['power']);
      if (power === undefined) return;
      const externalId = `pm1:${index}`;
      const state: DeviceState = { powerW: round(power, 2) };
      const capabilities: Capability[] = ['sensor.power'];
      const total = num(meter['total']);
      if (total !== undefined) {
        state.energyWh = round(isEmeter ? total : total / 60, 2);
        capabilities.push('sensor.energy');
      }
      components.push({
        externalId,
        name: label(naming, externalId, `Verbrauch ${index + 1}`),
        capabilities,
        state,
      });
    });
  }

  /*
   * Shelly TRV (SHTRV-01): das Heizkörperventil meldet Soll- und Isttemperatur
   * sowie die Ventilstellung in einem eigenen Abschnitt. Es ist Gen1 und
   * bekommt keine neue Firmware mehr – ohne diesen Zweig bliebe es unerkannt.
   */
  const thermostats = arr(status['thermostats']) ?? [];
  thermostats.forEach((rawThermostat, index) => {
    const thermostat = obj(rawThermostat);
    if (!thermostat) return;
    const externalId = `thermostat:${index}`;
    const state: DeviceState = {};
    const capabilities: Capability[] = ['thermostat'];

    const target = num(obj(thermostat['target_t'])?.['value']);
    if (target !== undefined) state.targetTemperatureC = round(target, 1);
    const current = num(obj(thermostat['tmp'])?.['value']);
    if (current !== undefined) {
      state.temperatureC = round(current, 2);
      capabilities.push('sensor.temperature');
    }
    const valve = num(thermostat['pos']);
    if (valve !== undefined) state.valvePosition = round(valve, 0);

    components.push({
      externalId,
      name: label(naming, externalId, `Heizung ${index + 1}`),
      capabilities,
      state,
    });
  });

  // Shelly H&T / Flood / Door-Window
  const tmp = obj(status['tmp']);
  const tmpValue = num(tmp?.['tC']) ?? num(tmp?.['value']);
  if (tmpValue !== undefined && tmp?.['is_valid'] !== false) {
    components.push({
      externalId: 'temperature:0',
      name: label(naming, 'temperature:0', 'Temperatur'),
      capabilities: ['sensor.temperature'],
      state: { temperatureC: round(tmpValue, 2) },
    });
  }

  const hum = obj(status['hum']);
  const humValue = num(hum?.['value']);
  if (humValue !== undefined && hum?.['is_valid'] !== false) {
    components.push({
      externalId: 'humidity:0',
      name: label(naming, 'humidity:0', 'Luftfeuchte'),
      capabilities: ['sensor.humidity'],
      state: { humidity: round(humValue, 1) },
    });
  }

  const lux = obj(status['lux']);
  const luxValue = num(lux?.['value']);
  if (luxValue !== undefined && lux?.['is_valid'] !== false) {
    components.push({
      externalId: 'illuminance:0',
      name: label(naming, 'illuminance:0', 'Helligkeit'),
      capabilities: ['sensor.illuminance'],
      state: { illuminanceLux: round(luxValue, 1) },
    });
  }

  const bat = obj(status['bat']);
  const batValue = num(bat?.['value']);
  if (batValue !== undefined) {
    components.push({
      externalId: 'devicepower:0',
      name: label(naming, 'devicepower:0', 'Batterie'),
      capabilities: ['sensor.battery'],
      state: { batteryPercent: round(batValue, 0) },
    });
  }

  // Add-On-Sensoren (z. B. DS18B20 am Shelly 1)
  const extTemp = obj(status['ext_temperature']);
  for (const [key, rawEntry] of Object.entries(extTemp ?? {})) {
    const value = num(obj(rawEntry)?.['hC']) ?? num(obj(rawEntry)?.['tC']);
    if (value === undefined) continue;
    const externalId = `temperature:ext${key}`;
    components.push({
      externalId,
      name: label(naming, externalId, `Temperatur Sensor ${Number(key) + 1}`),
      capabilities: ['sensor.temperature'],
      state: { temperatureC: round(value, 2) },
    });
  }

  const extHum = obj(status['ext_humidity']);
  for (const [key, rawEntry] of Object.entries(extHum ?? {})) {
    const value = num(obj(rawEntry)?.['hum']);
    if (value === undefined) continue;
    const externalId = `humidity:ext${key}`;
    components.push({
      externalId,
      name: label(naming, externalId, `Luftfeuchte Sensor ${Number(key) + 1}`),
      capabilities: ['sensor.humidity'],
      state: { humidity: round(value, 1) },
    });
  }

  return components;
}

// ---------------------------------------------------------------------------
// Namen aus der Gerätekonfiguration
// ---------------------------------------------------------------------------

export function namingFromConfig(
  config: Json | undefined,
  generation: 1 | 2,
  fallbackName: string,
): ShellyNaming {
  const channelNames = new Map<string, string>();
  let deviceName = fallbackName;

  if (!config) return { deviceName, channelNames };

  if (generation === 2) {
    const sys = obj(config['sys']);
    const device = obj(sys?.['device']);
    deviceName = str(device?.['name']) ?? fallbackName;
    for (const [key, rawValue] of Object.entries(config)) {
      const name = str(obj(rawValue)?.['name']);
      if (name && key.includes(':')) channelNames.set(key, name);
    }
  } else {
    deviceName = str(config['name']) ?? str(obj(config['device'])?.['hostname']) ?? fallbackName;
    const setChannelNames = (list: unknown, prefix: string): void => {
      arr(list)?.forEach((entry, index) => {
        const name = str(obj(entry)?.['name']);
        if (name) channelNames.set(`${prefix}:${index}`, name);
      });
    };
    setChannelNames(config['relays'], 'switch');
    setChannelNames(config['lights'], 'light');
    setChannelNames(config['rollers'], 'cover');
  }

  return { deviceName, channelNames };
}

/**
 * Vereinheitlicht den Fahrzustand eines Rollladens.
 *
 * Die beiden Generationen benennen dasselbe unterschiedlich: Gen2 meldet mit
 * `open` den Endzustand „ganz offen“, Gen1 dagegen die Fahrt nach oben. Ohne
 * diese Unterscheidung würde die UI einen stehenden Rollladen als fahrend
 * anzeigen.
 */
export function normalizeCoverState(
  raw: string | undefined,
  position: number | undefined,
  generation: 1 | 2,
): CoverState {
  const fromPosition = (): CoverState => {
    if (position === undefined) return 'stopped';
    if (position <= 0) return 'closed';
    if (position >= 100) return 'open';
    return 'stopped';
  };

  if (!raw) return fromPosition();

  if (generation === 1) {
    switch (raw) {
      case 'open':
        return 'opening';
      case 'close':
        return 'closing';
      default:
        return fromPosition();
    }
  }

  switch (raw) {
    case 'opening':
      return 'opening';
    case 'closing':
      return 'closing';
    case 'open':
      return 'open';
    case 'closed':
      return 'closed';
    default:
      return fromPosition();
  }
}

/** Zerlegt `switch:2` in Typ und Kanalnummer. */
export function parseComponentId(externalId: string): { kind: string; channel: number } {
  const [kind, index] = externalId.split(':');
  const parsed = Number(index);
  return { kind: kind ?? '', channel: Number.isFinite(parsed) ? parsed : 0 };
}
