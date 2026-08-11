import { round } from '../../core/color.js';
import type { Capability, CoverState, DeviceState } from '../../core/types.js';
import { child, childNumber, childText, type XmlNode } from '../../util/xml.js';

/**
 * Was ein FRITZ!Box-Gerät kann, steht in einer Bitmaske.
 *
 * AVM beschreibt jedes Gerät über `functionbitmask` – eine Zahl, in der jedes
 * Bit für eine Fähigkeit steht. Das ist sparsam und über alle Modelle hinweg
 * gleich: Eine FRITZ!DECT 200 von 2013 und eine DECT 500 von heute melden
 * sich nach demselben Schema.
 */
export const FUNCTION = {
  hanFunDevice: 1 << 0,
  lightOrAlarm: 1 << 2,
  alarmSensor: 1 << 4,
  button: 1 << 5,
  /** Heizkörperregler (HKR) */
  thermostat: 1 << 6,
  energyMeter: 1 << 7,
  temperatureSensor: 1 << 8,
  outlet: 1 << 9,
  repeater: 1 << 10,
  microphone: 1 << 11,
  hanFunUnit: 1 << 13,
  /** An-/ausschaltbar (Steckdose, Lampe, Aktor) */
  switchable: 1 << 15,
  /** Einstellbares Niveau: Dimmen, Rollladenhöhe */
  level: 1 << 16,
  /** Lampe mit Farbe oder Farbtemperatur */
  color: 1 << 17,
  /** Rollladen: auf, zu, stopp */
  blind: 1 << 18,
  humiditySensor: 1 << 19,
} as const;

export const has = (mask: number, bit: number): boolean => (mask & bit) !== 0;

export interface FritzDevice {
  /** AIN – die Kennung, mit der die Box das Gerät anspricht. */
  ain: string;
  name: string;
  productName: string;
  manufacturer: string;
  firmware: string;
  functionMask: number;
  present: boolean;
  capabilities: Capability[];
  state: DeviceState;
}

/**
 * Liest ein `<device>`- oder `<group>`-Element aus der Geräteliste.
 *
 * Gruppen sind für den Hub gewöhnliche Geräte: Wer in der FRITZ!Box-App eine
 * Gruppe „Wohnzimmer“ angelegt hat, will sie hier auch schalten können.
 */
export function parseDevice(node: XmlNode): FritzDevice | null {
  const ain = (node.attrs['identifier'] ?? '').trim();
  if (!ain) return null;

  const functionMask = Number(node.attrs['functionbitmask'] ?? '0');
  const state: DeviceState = {};
  const capabilities: Capability[] = [];

  // Nicht erreichbare Geräte werden trotzdem gelistet – sie sind ja da,
  // nur gerade stumm. `present` steuert die Anzeige.
  const present = childText(node, 'present') === '1';

  // --- Schalten -----------------------------------------------------------
  const switchNode = child(node, 'switch');
  if (has(functionMask, FUNCTION.switchable) || switchNode) {
    const on = childText(switchNode, 'state');
    if (on === '0' || on === '1') state.on = on === '1';
    capabilities.push('switch');
  }

  // --- Rollladen ----------------------------------------------------------
  // Muss vor dem Dimmen stehen: Ein Rollladen hat ebenfalls ein „Level“,
  // meint damit aber die Höhe und nicht die Helligkeit.
  const blindNode = child(node, 'blind');
  if (has(functionMask, FUNCTION.blind) || blindNode) {
    capabilities.length = 0; // Ein Rollladen ist kein Schalter.
    capabilities.push('cover');

    const levelNode = child(node, 'levelcontrol');
    const percent = childNumber(levelNode, 'levelpercentage');
    if (percent !== undefined) {
      // AVM zählt wie die Rollladenhöhe: 0 = offen, 100 = geschlossen.
      // Der Hub zählt umgekehrt (100 = offen), wie überall sonst auch.
      state.position = round(100 - percent, 0);
    }
    state.coverState = blindState(childText(blindNode, 'endpositionsset'), state.position);
    return finish(node, ain, functionMask, present, capabilities, state);
  }

  // --- Dimmen und Farbe ---------------------------------------------------
  const levelNode = child(node, 'levelcontrol');
  if (has(functionMask, FUNCTION.level) && levelNode) {
    const percent = childNumber(levelNode, 'levelpercentage');
    if (percent !== undefined) state.brightness = round(percent, 0);
    capabilities.push('dimmer');
  }

  const colorNode = child(node, 'colorcontrol');
  if (colorNode) {
    const mode = colorNode.attrs['current_mode'];
    const hue = childNumber(colorNode, 'hue');
    const saturation = childNumber(colorNode, 'saturation');
    const kelvin = childNumber(colorNode, 'temperature');

    // Modus 1 = Farbe, Modus 4 = Weißton. Die Box liefert oft beides;
    // maßgeblich ist, was gerade eingestellt ist.
    if (mode === '1' && hue !== undefined && saturation !== undefined) {
      state.hue = round(hue, 0);
      // AVM zählt Sättigung in 0..255.
      state.saturation = round((saturation / 255) * 100, 1);
    } else if (kelvin !== undefined) {
      state.colorTemperatureK = kelvin;
    }

    if (hue !== undefined || saturation !== undefined) capabilities.push('color');
    if (kelvin !== undefined) capabilities.push('color_temperature');
  }

  // --- Heizkörperregler ---------------------------------------------------
  const hkr = child(node, 'hkr');
  if (hkr) {
    capabilities.push('thermostat');
    const target = childNumber(hkr, 'tsoll');
    if (target !== undefined) {
      const celsius = halfDegreesToCelsius(target);
      if (celsius !== null) state.targetTemperatureC = celsius;
    }
    const current = childNumber(hkr, 'tist');
    if (current !== undefined) {
      state.temperatureC = round(current / 2, 1);
      if (!capabilities.includes('sensor.temperature')) capabilities.push('sensor.temperature');
    }
    // Ventilstellung meldet AVM nicht direkt; „Fenster offen“ und Batterie
    // schon.
    const battery = childNumber(node, 'battery');
    if (battery !== undefined) {
      state.batteryPercent = round(battery, 0);
      if (!capabilities.includes('sensor.battery')) capabilities.push('sensor.battery');
    }
  }

  // --- Messwerte ----------------------------------------------------------
  const temperature = child(node, 'temperature');
  const celsius = childNumber(temperature, 'celsius');
  if (celsius !== undefined && !capabilities.includes('sensor.temperature')) {
    // Zehntelgrad: 235 sind 23,5 °C.
    state.temperatureC = round(celsius / 10, 1);
    capabilities.push('sensor.temperature');
  }

  const humidity = childNumber(child(node, 'humidity'), 'rel_humidity');
  if (humidity !== undefined) {
    state.humidity = round(humidity, 0);
    capabilities.push('sensor.humidity');
  }

  const powerNode = child(node, 'powermeter');
  const power = childNumber(powerNode, 'power');
  if (power !== undefined) {
    // Milliwatt.
    state.powerW = round(power / 1000, 2);
    capabilities.push('sensor.power');
  }
  const energy = childNumber(powerNode, 'energy');
  if (energy !== undefined) {
    // Wattstunden.
    state.energyWh = round(energy, 1);
    capabilities.push('sensor.energy');
  }

  const alert = childText(child(node, 'alert'), 'state');
  if (alert === '0' || alert === '1') {
    // Fenster- und Bewegungsmelder melden hier ihren Zustand.
    state.motion = alert === '1';
    capabilities.push('sensor.motion');
  }

  const battery = childNumber(node, 'battery');
  if (battery !== undefined && !capabilities.includes('sensor.battery')) {
    state.batteryPercent = round(battery, 0);
    capabilities.push('sensor.battery');
  }

  return finish(node, ain, functionMask, present, capabilities, state);
}

function finish(
  node: XmlNode,
  ain: string,
  functionMask: number,
  present: boolean,
  capabilities: Capability[],
  state: DeviceState,
): FritzDevice | null {
  // Reine Taster und Repeater ohne Messwerte ergeben keine Karte.
  if (capabilities.length === 0) return null;

  return {
    ain,
    name: childText(node, 'name') ?? node.attrs['identifier'] ?? 'FRITZ!Box-Gerät',
    productName: node.attrs['productname'] ?? '',
    manufacturer: node.attrs['manufacturer'] || 'AVM',
    firmware: node.attrs['fwversion'] ?? '',
    functionMask,
    present,
    capabilities: [...new Set(capabilities)],
    state,
  };
}

/**
 * Der Heizkörperregler zählt in halben Grad. Zwei Werte bedeuten etwas
 * anderes als eine Temperatur: 253 heißt „ganz aus“, 254 „dauerhaft auf“.
 */
export function halfDegreesToCelsius(value: number): number | null {
  if (value === 253) return 8; // „Aus“ entspricht dem Frostschutz.
  if (value === 254) return 28; // „An“ ist die Maximalstellung.
  if (value < 16 || value > 56) return null;
  return round(value / 2, 1);
}

/** Umgekehrt – zum Schreiben. AVM erwartet 16..56 (8 bis 28 °C). */
export function celsiusToHalfDegrees(celsius: number): number {
  return Math.min(56, Math.max(16, Math.round(celsius * 2)));
}

/**
 * Fahrzustand eines Rollladens.
 *
 * Die Box meldet keine Fahrtrichtung, nur ob eine Endlage erreicht ist.
 * Mehr lässt sich daraus ehrlich nicht ableiten – „fährt gerade“ zu
 * behaupten, wäre geraten.
 */
export function blindState(endpositions: string | undefined, position?: number): CoverState {
  if (position === 100) return 'open';
  if (position === 0) return 'closed';
  return endpositions === '1' ? 'stopped' : 'stopped';
}

/** Aus dem AIN wird die externe Kennung – Leerzeichen stören in URLs nicht. */
export function normalizeAin(ain: string): string {
  return ain.trim();
}
