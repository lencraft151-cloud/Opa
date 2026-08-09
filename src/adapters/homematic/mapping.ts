import { round } from '../../core/color.js';
import type { Capability, CoverState, DeviceState } from '../../core/types.js';
import type { HomematicChannel } from './client.js';

/**
 * Homematic beschreibt Geräte über Kanäle mit sprechenden Typnamen. Ein
 * Rollladen ist ein `BLIND_VIRTUAL_RECEIVER`, ein Heizkörperventil ein
 * `HEATING_CLIMATECONTROL_TRANSCEIVER`. Diese Namen sind über CCU2, CCU3 und
 * RaspberryMatic hinweg stabil – auch bei Geräten von 2012.
 */
export type ChannelKind =
  | 'cover'
  | 'switch'
  | 'dimmer'
  | 'thermostat'
  | 'climate'
  | 'motion'
  | 'contact'
  | 'power'
  | 'maintenance';

const KIND_BY_TYPE: Array<{ match: RegExp; kind: ChannelKind }> = [
  /*
   * Fensterkontakte heißen bei Homematic `SHUTTER_CONTACT` – „Shutter" wie
   * Fensterladen, gemeint ist aber der Kontakt. Er muss vor den Rollläden
   * stehen, sonst würde er als Antrieb durchgehen.
   */
  { match: /^(SHUTTER_CONTACT|ROTARY_HANDLE_SENSOR|CONTACT)$/, kind: 'contact' },

  /*
   * Rollläden und Jalousien.
   *
   * BidCos nennt den Kanal `BLIND` oder `JALOUSIE`, HmIP dagegen
   * `SHUTTER_VIRTUAL_RECEIVER` (Rollladen) bzw. `BLIND_VIRTUAL_RECEIVER`
   * (Jalousie mit Lamellen). Ohne die SHUTTER-Zeile bliebe jeder
   * HmIP-Rollladenaktor – HmIP-BROLL, HmIP-FROLL – unsichtbar.
   */
  { match: /^(BLIND|JALOUSIE|SHUTTER)(_VIRTUAL_RECEIVER)?$/, kind: 'cover' },
  { match: /^(BLIND|SHUTTER)_TRANSMITTER$/, kind: 'cover' },

  /*
   * Andere Motoren fahren genauso: Markise, Garagentor, Tür, Fenster, Screen.
   * Für den Hub sind sie alle ein Antrieb mit Position – „auf", „zu" und ein
   * Prozentwert. Dass eine Markise waagerecht ausfährt und ein Rollladen
   * senkrecht, ändert daran nichts.
   */
  {
    match: /^(AWNING|MARKISE|GARAGE|GARAGE_DOOR|DOOR|WINDOW_DRIVE|SCREEN|SUN_PROTECTION)(_VIRTUAL_RECEIVER|_TRANSMITTER|_RECEIVER)?$/,
    kind: 'cover',
  },

  // Heizung: Wandthermostat und Heizkörperventil
  { match: /^(HEATING_CLIMATECONTROL_TRANSCEIVER|CLIMATECONTROL_RT_TRANSCEIVER)$/, kind: 'thermostat' },
  { match: /^(THERMALCONTROL_TRANSMIT|CLIMATECONTROL_REGULATOR)$/, kind: 'thermostat' },
  { match: /^HEATING_CLIMATECONTROL_TRANSMITTER$/, kind: 'thermostat' },
  // Reine Klimasensoren
  { match: /^(CLIMATE_TRANSCEIVER|WEATHER|WEATHER_TRANSMIT|CLIMATE_SENSOR)$/, kind: 'climate' },
  { match: /^HEATING_CLIMATECONTROL_RECEIVER$/, kind: 'climate' },
  // Schalten und Dimmen
  { match: /^DIMMER(_VIRTUAL_RECEIVER|_TRANSMITTER)?$/, kind: 'dimmer' },
  { match: /^SWITCH(_VIRTUAL_RECEIVER|_TRANSMITTER)?$/, kind: 'switch' },
  // Melder
  { match: /^(MOTION_DETECTOR|MOTIONDETECTOR_TRANSCEIVER|PRESENCEDETECTOR_TRANSCEIVER)$/, kind: 'motion' },
  // Messen und Gerätezustand
  { match: /^(POWERMETER|ENERGIE_METER_TRANSMITTER)$/, kind: 'power' },
  { match: /^MAINTENANCE$/, kind: 'maintenance' },
];

/**
 * Kanäle, von denen ein Gerät mehrere gleichartige hat.
 *
 * HmIP-Aktoren führen für jede Gruppenzuordnung einen eigenen
 * „virtual receiver“ – ein HmIP-BROLL hat davon fünf. Alle fünf steuern
 * denselben Motor. Ohne diese Liste stünde ein Rollladen fünfmal in der
 * Geräteliste, und niemand wüsste, welcher der richtige ist.
 */
const SINGLE_PER_DEVICE = new Set<ChannelKind>(['cover', 'switch', 'dimmer', 'thermostat']);

/**
 * Reduziert mehrfach vorhandene Aktorkanäle auf einen je Gerät.
 *
 * Bevorzugt wird der Empfängerkanal (`*_VIRTUAL_RECEIVER`) mit der
 * kleinsten Nummer: Er ist derjenige, den auch die CCU-Oberfläche anzeigt.
 * Sender- und Tastkanäle (`*_TRANSMITTER`) treten nur an, wenn es keinen
 * Empfänger gibt – bei rein sendenden Geräten.
 */
export function pickPrimaryChannels<T extends { channel: HomematicChannel; kind: ChannelKind }>(
  entries: T[],
): T[] {
  const best = new Map<string, T>();
  const result: T[] = [];

  for (const entry of entries) {
    if (!SINGLE_PER_DEVICE.has(entry.kind)) {
      result.push(entry);
      continue;
    }
    const key = `${entry.channel.deviceAddress}::${entry.kind}`;
    const current = best.get(key);
    if (!current || rank(entry.channel) < rank(current.channel)) best.set(key, entry);
  }

  return [...result, ...best.values()];
}

/** Kleinere Zahl = besserer Kanal. */
function rank(channel: HomematicChannel): number {
  const index = Number(channel.address.split(':')[1] ?? 0);
  const isReceiver = /_VIRTUAL_RECEIVER$/i.test(channel.channelType);
  const isTransmitter = /_TRANSMITTER$/i.test(channel.channelType);
  // Empfänger zuerst, dann normale Kanäle, Sender zuletzt.
  const group = isReceiver ? 0 : isTransmitter ? 2 : 1;
  return group * 1000 + (Number.isFinite(index) ? index : 999);
}

export function classifyChannel(channel: HomematicChannel): ChannelKind | null {
  const type = channel.channelType.toUpperCase();
  for (const entry of KIND_BY_TYPE) {
    if (entry.match.test(type)) return entry.kind;
  }
  return null;
}

/**
 * Was ein unbekannter Kanal ist – geraten aus dem, was er kann.
 *
 * Die Namenstabelle oben deckt ab, was wir kennen. Sie kann aber nicht
 * abdecken, was es noch gibt: Homematic ist seit 2010 gewachsen, es gibt
 * Fremdgeräte über HmIP, Zusatzpakete erfinden eigene Kanaltypen. Bisher
 * verschwand so ein Kanal wortlos – der Rollladen war einfach nicht da, und
 * niemand konnte sehen, warum.
 *
 * Deshalb dieser zweite Anlauf: Nicht der Name entscheidet, sondern die
 * Werte, die der Kanal führt. Ein Kanal mit `LEVEL` und einer Fahrtrichtung
 * ist ein Rollladen, egal wie sein Typ heißt.
 */
export function inferKind(
  values: Record<string, unknown>,
  deviceType = '',
  channelType = '',
): ChannelKind | null {
  const hasValue = (key: string): boolean => key in values;
  const name = `${deviceType} ${channelType}`.toUpperCase();

  // Solltemperatur ist eindeutig: Das kann nur eine Heizung sein.
  if (hasValue('SET_POINT_TEMPERATURE') || hasValue('SET_TEMPERATURE')) return 'thermostat';

  // Fahrtrichtung oder Lamellen – ein Antrieb, kein Dimmer.
  if (
    hasValue('LEVEL') &&
    (hasValue('LEVEL_SLATS') ||
      hasValue('LEVEL_2') ||
      hasValue('ACTIVITY_STATE') ||
      hasValue('DIRECTION') ||
      hasValue('SECTION'))
  ) {
    return 'cover';
  }

  /*
   * Bleibt der Fall „nur LEVEL“: Rollladen und Dimmer sehen dann gleich aus.
   * Hier hilft der Gerätename weiter – eQ-3 benennt seine Modelle sprechend
   * (HmIP-BROLL, HM-LC-Bl1-FM, HmIP-BBL für Jalousien).
   */
  if (hasValue('LEVEL')) {
    /*
     * Neben Rollläden fahren auch Markisen, Tore und Fensterantriebe – eQ-3
     * und Fremdhersteller benennen sie sprechend. Ein falsch geratener
     * Antrieb ist hier ungefährlich: Er bekommt „auf/zu/Position", und genau
     * das kann er.
     */
    if (/ROLL|BLIND|JALOU|SHUTTER|MARKI|AWNING|GARAGE|TOR\b|SCREEN|BBL|BL1|BL-/.test(name)) {
      return 'cover';
    }
    if (/DIM|DIMMER|PD-|LC-DW/.test(name)) return 'dimmer';
    // Unentschieden: Ein falsch geratener Rollladen ist ärgerlicher als ein
    // falsch geratener Dimmer – beide lassen sich in der Oberfläche
    // richtigstellen, aber der Dimmer richtet keinen Schaden an.
    return 'dimmer';
  }

  if (hasValue('STATE') && typeof values['STATE'] === 'boolean') {
    return /MOTION|PRESENCE/.test(name) ? 'motion' : 'switch';
  }
  if (hasValue('MOTION')) return 'motion';
  if (hasValue('ACTUAL_TEMPERATURE') || hasValue('HUMIDITY') || hasValue('TEMPERATURE')) {
    return 'climate';
  }
  if (hasValue('POWER') || hasValue('ENERGY_COUNTER')) return 'power';
  if (hasValue('LOWBAT') || hasValue('LOW_BAT') || hasValue('OPERATING_VOLTAGE_LEVEL')) {
    return 'maintenance';
  }

  return null;
}

export function capabilitiesFor(kind: ChannelKind, values: Record<string, unknown>): Capability[] {
  switch (kind) {
    case 'cover': {
      const capabilities: Capability[] = ['cover'];
      if ('LEVEL_SLATS' in values || 'LEVEL_2' in values) capabilities.push('cover.tilt');
      return capabilities;
    }
    case 'switch':
      return 'POWER' in values ? ['switch', 'sensor.power'] : ['switch'];
    case 'dimmer':
      return ['switch', 'dimmer'];
    case 'thermostat': {
      const capabilities: Capability[] = ['thermostat'];
      if ('ACTUAL_TEMPERATURE' in values) capabilities.push('sensor.temperature');
      if ('HUMIDITY' in values) capabilities.push('sensor.humidity');
      return capabilities;
    }
    case 'climate': {
      const capabilities: Capability[] = [];
      if ('ACTUAL_TEMPERATURE' in values) capabilities.push('sensor.temperature');
      if ('HUMIDITY' in values) capabilities.push('sensor.humidity');
      return capabilities;
    }
    case 'motion': {
      const capabilities: Capability[] = ['sensor.motion'];
      if ('ILLUMINATION' in values || 'BRIGHTNESS' in values) capabilities.push('sensor.illuminance');
      return capabilities;
    }
    case 'contact':
      // Fenster- und Türkontakte melden offen/zu – im Hub als Bewegung/Zustand.
      return ['sensor.motion'];
    case 'power':
      return 'ENERGY_COUNTER' in values ? ['sensor.power', 'sensor.energy'] : ['sensor.power'];
    case 'maintenance':
      return ['sensor.battery'];
    default:
      return [];
  }
}

const num = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // Die CCU liefert Zahlen gelegentlich als Zeichenkette.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const bool = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 1) return true;
  if (value === 'false' || value === 0) return false;
  return undefined;
};

/** Homematic rechnet Pegel als 0..1, der Hub in Prozent. */
const levelToPercent = (value: unknown): number | undefined => {
  const raw = num(value);
  if (raw === undefined) return undefined;
  // Manche HmIP-Kanäle liefern bereits Prozent.
  return round(raw <= 1 ? raw * 100 : raw, 1);
};

export function stateFromValues(
  kind: ChannelKind,
  values: Record<string, unknown>,
): DeviceState {
  const state: DeviceState = {};

  switch (kind) {
    case 'cover': {
      const position = levelToPercent(values['LEVEL']);
      if (position !== undefined) state.position = position;
      const tilt = levelToPercent(values['LEVEL_SLATS'] ?? values['LEVEL_2']);
      if (tilt !== undefined) state.tilt = tilt;
      state.coverState = coverStateFrom(values, position);
      break;
    }
    case 'switch': {
      const on = bool(values['STATE']);
      if (on !== undefined) state.on = on;
      const power = num(values['POWER']);
      if (power !== undefined) state.powerW = round(power, 2);
      break;
    }
    case 'dimmer': {
      const brightness = levelToPercent(values['LEVEL']);
      if (brightness !== undefined) {
        state.brightness = brightness;
        state.on = brightness > 0;
      }
      break;
    }
    case 'thermostat': {
      const target = num(values['SET_POINT_TEMPERATURE'] ?? values['SET_TEMPERATURE']);
      if (target !== undefined) state.targetTemperatureC = round(target, 1);
      const actual = num(values['ACTUAL_TEMPERATURE']);
      if (actual !== undefined) state.temperatureC = round(actual, 2);
      const humidity = num(values['HUMIDITY']);
      if (humidity !== undefined) state.humidity = round(humidity, 1);
      const valve = levelToPercent(values['LEVEL']);
      if (valve !== undefined) state.valvePosition = valve;
      break;
    }
    case 'climate': {
      const actual = num(values['ACTUAL_TEMPERATURE']);
      if (actual !== undefined) state.temperatureC = round(actual, 2);
      const humidity = num(values['HUMIDITY']);
      if (humidity !== undefined) state.humidity = round(humidity, 1);
      break;
    }
    case 'motion': {
      const motion = bool(values['MOTION']) ?? bool(values['PRESENCE_DETECTION_STATE']);
      if (motion !== undefined) state.motion = motion;
      const lux = num(values['ILLUMINATION'] ?? values['BRIGHTNESS']);
      if (lux !== undefined) state.illuminanceLux = round(lux, 1);
      break;
    }
    case 'contact': {
      const open = bool(values['STATE']);
      if (open !== undefined) state.motion = open;
      break;
    }
    case 'power': {
      const power = num(values['POWER']);
      if (power !== undefined) state.powerW = round(power, 2);
      const energy = num(values['ENERGY_COUNTER']);
      if (energy !== undefined) state.energyWh = round(energy, 2);
      break;
    }
    case 'maintenance': {
      const percent = num(values['OPERATING_VOLTAGE_LEVEL']);
      if (percent !== undefined) {
        state.batteryPercent = round(percent <= 1 ? percent * 100 : percent, 0);
        break;
      }
      // Ältere BidCos-Geräte melden nur "Batterie schwach" statt eines Pegels.
      const low = bool(values['LOW_BAT']) ?? bool(values['LOWBAT']);
      if (low !== undefined) state.batteryPercent = low ? 10 : 100;
      break;
    }
    default:
      break;
  }

  return state;
}

function coverStateFrom(values: Record<string, unknown>, position: number | undefined): CoverState {
  // HmIP meldet die Fahrt in ACTIVITY_STATE, BidCos in DIRECTION.
  const activity = String(values['ACTIVITY_STATE'] ?? '').toUpperCase();
  if (activity === 'UP') return 'opening';
  if (activity === 'DOWN') return 'closing';

  const direction = num(values['DIRECTION']);
  if (direction === 1) return 'opening';
  if (direction === 2) return 'closing';

  if (position === undefined) return 'stopped';
  if (position <= 0) return 'closed';
  if (position >= 100) return 'open';
  return 'stopped';
}

// ---------------------------------------------------------------------------
// Schreiben
// ---------------------------------------------------------------------------

export interface WriteSpec {
  valueKey: string;
  value: number | boolean;
  valueType: 'double' | 'boolean' | 'int';
}

/**
 * Welcher Wertename für die Solltemperatur gilt, hängt an der Gerätefamilie:
 * HmIP nutzt `SET_POINT_TEMPERATURE`, die älteren BidCos-Thermostate
 * `SET_TEMPERATURE`. Entschieden wird anhand der gelesenen Werte, nicht anhand
 * des Modellnamens – so greift es auch bei Geräten, die wir nicht kennen.
 */
export function targetTemperatureKey(values: Record<string, unknown>): string {
  return 'SET_POINT_TEMPERATURE' in values ? 'SET_POINT_TEMPERATURE' : 'SET_TEMPERATURE';
}

export function tiltKey(values: Record<string, unknown>): string {
  return 'LEVEL_SLATS' in values ? 'LEVEL_SLATS' : 'LEVEL_2';
}
