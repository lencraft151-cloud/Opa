/**
 * Vorgefertigte Automationen.
 *
 * Eine Regel von Hand zu bauen setzt voraus, dass man Auslöser, Bedingungen
 * und Aktionen im Kopf zusammensetzen kann. Die Vorlagen hier drehen das um:
 * Der Nutzer wählt „Licht an, wenn sich jemand bewegt“, der Hub schlägt die
 * passenden Geräte vor, und aus den paar Angaben entsteht die fertige Regel.
 */

import { badRequest } from '../core/errors.js';
import { LIGHT_EFFECT_IDS } from '../core/types.js';
import type { Capability, Device, LightEffect, Room } from '../core/types.js';
import type { CreateRuleInput } from './automationService.js';
import { EFFECTS } from './effectService.js';

export type TemplateFieldType = 'device' | 'devices' | 'room' | 'number' | 'time' | 'choice';

export interface TemplateField {
  key: string;
  label: string;
  type: TemplateFieldType;
  /** Für Gerätefelder: welche Fähigkeit das Gerät haben muss. */
  capability?: Capability;
  /** Für `choice`: die feste Auswahl. Geräte holen sich ihre Liste selbst. */
  choices?: Array<{ value: string; label: string }>;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  /** Erklärt in Alltagssprache, wofür das Feld da ist. */
  help: string;
}

export interface AutomationTemplate {
  id: string;
  emoji: string;
  name: string;
  /** Ein Satz nach dem Muster „Wenn …, dann …“. */
  summary: string;
  /** Ausführlichere Erklärung inklusive Nutzen. */
  explanation: string;
  fields: TemplateField[];
  build(values: TemplateValues): CreateRuleInput;
}

export type TemplateValues = Record<string, string | number | string[]>;

/** Vorlage inklusive Vorbelegung und Prüfung gegen den echten Gerätebestand. */
export interface ResolvedTemplate extends Omit<AutomationTemplate, 'build'> {
  /** Lässt sich die Vorlage mit den vorhandenen Geräten anlegen? */
  applicable: boolean;
  /** Was fehlt, in Alltagssprache. */
  missing: string[];
  /** Vorbelegung der Felder – meist direkt übernehmbar. */
  defaults: TemplateValues;
  /** Auswahlmöglichkeiten für Geräte- und Raumfelder. */
  options: Record<string, Array<{ id: string; label: string }>>;
}

const str = (values: TemplateValues, key: string): string => {
  const value = values[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`Für "${key}" wurde nichts ausgewählt.`, undefined, 'Bitte alle Felder füllen.');
  }
  return value;
};

const list = (values: TemplateValues, key: string): string[] => {
  const value = values[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw badRequest(`Für "${key}" wurde nichts ausgewählt.`, undefined, 'Bitte mindestens ein Gerät wählen.');
  }
  return value;
};

const num = (values: TemplateValues, key: string): number => {
  const value = Number(values[key]);
  if (!Number.isFinite(value)) {
    throw badRequest(`Für "${key}" wurde keine Zahl angegeben.`);
  }
  return value;
};

const effect = (values: TemplateValues, key: string): LightEffect => {
  const value = str(values, key);
  const found = LIGHT_EFFECT_IDS.find((id) => id === value);
  if (!found) {
    throw badRequest(
      `"${value}" ist kein bekannter Lichteffekt.`,
      undefined,
      `Möglich sind: ${LIGHT_EFFECT_IDS.join(', ')}.`,
    );
  }
  return found;
};

const time = (values: TemplateValues, key: string): string => {
  const value = str(values, key);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw badRequest(
      `"${value}" ist keine gültige Uhrzeit.`,
      undefined,
      'Erwartet wird das Format HH:MM, zum Beispiel 07:30.',
    );
  }
  return value;
};

// ---------------------------------------------------------------------------
// Die Vorlagen
// ---------------------------------------------------------------------------

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'motion-light',
    emoji: '🚶',
    name: 'Licht an, wenn sich jemand bewegt',
    summary: 'Wenn der Bewegungsmelder auslöst, geht das Licht an.',
    explanation:
      'Praktisch für Flur, Keller oder Bad. Das Licht schaltet sich nicht von selbst wieder aus – ' +
      'dafür kannst du zusätzlich die Vorlage „Licht abends aus“ anlegen.',
    fields: [
      {
        key: 'sensor',
        label: 'Bewegungsmelder',
        type: 'device',
        capability: 'sensor.motion',
        help: 'Das Gerät, das die Bewegung meldet.',
      },
      {
        key: 'lights',
        label: 'Was eingeschaltet wird',
        type: 'devices',
        capability: 'switch',
        help: 'Eine oder mehrere Lampen bzw. Steckdosen.',
      },
      {
        key: 'cooldownMinutes',
        label: 'Frühestens wieder nach',
        type: 'number',
        unit: 'Minuten',
        min: 0,
        max: 120,
        step: 1,
        help: 'Verhindert, dass die Regel bei jeder kleinen Bewegung erneut schaltet.',
      },
    ],
    build: (values) => ({
      name: 'Licht bei Bewegung',
      trigger: {
        type: 'deviceState',
        deviceId: str(values, 'sensor'),
        property: 'motion',
        equals: true,
      },
      actions: [
        {
          type: 'command',
          target: { deviceIds: list(values, 'lights') },
          command: { type: 'setPower', on: true },
        },
      ],
      cooldownSeconds: num(values, 'cooldownMinutes') * 60,
    }),
  },

  {
    id: 'cold-room-heat',
    emoji: '🌡️',
    name: 'Heizen, wenn es zu kalt wird',
    summary: 'Wenn die Temperatur unter einen Wert fällt, geht die Steckdose an.',
    explanation:
      'Gedacht für einen Heizlüfter oder eine Elektroheizung an einer schaltbaren Steckdose. ' +
      'Die Regel wartet ein paar Minuten, damit ein kurzer Luftzug am Sensor nicht sofort heizt.',
    fields: [
      {
        key: 'sensor',
        label: 'Temperatursensor',
        type: 'device',
        capability: 'sensor.temperature',
        help: 'Der Sensor im Raum, der beobachtet wird.',
      },
      {
        key: 'heater',
        label: 'Heizung an dieser Steckdose',
        type: 'devices',
        capability: 'switch',
        help: 'Wird eingeschaltet, sobald es zu kalt ist.',
      },
      {
        key: 'below',
        label: 'Einschalten unter',
        type: 'number',
        unit: '°C',
        min: 5,
        max: 30,
        step: 0.5,
        help: 'Unterhalb dieser Temperatur wird geheizt.',
      },
      {
        key: 'forMinutes',
        label: 'So lange anhaltend',
        type: 'number',
        unit: 'Minuten',
        min: 0,
        max: 120,
        step: 1,
        help: 'Die Temperatur muss so lange darunter bleiben, bevor geschaltet wird.',
      },
    ],
    build: (values) => ({
      name: 'Heizen bei Kälte',
      trigger: {
        type: 'sensor',
        deviceId: str(values, 'sensor'),
        metric: 'temperatureC',
        operator: '<',
        value: num(values, 'below'),
        forSeconds: num(values, 'forMinutes') * 60,
      },
      actions: [
        {
          type: 'command',
          target: { deviceIds: list(values, 'heater') },
          command: { type: 'setPower', on: true },
        },
      ],
      cooldownSeconds: 900,
    }),
  },

  {
    id: 'covers-morning',
    emoji: '🌅',
    name: 'Rollläden morgens hochfahren',
    summary: 'Zur eingestellten Uhrzeit fahren alle Rollläden auf.',
    explanation:
      'Gilt an den gewählten Wochentagen. Wochenends später aufzustehen geht, indem du zwei ' +
      'Regeln anlegst – eine für Werktage, eine fürs Wochenende.',
    fields: [
      {
        key: 'at',
        label: 'Uhrzeit',
        type: 'time',
        help: 'Wann die Rollläden hochfahren sollen.',
      },
      {
        key: 'covers',
        label: 'Diese Rollläden',
        type: 'devices',
        capability: 'cover',
        help: 'Leer lassen ist nicht möglich – wähle mindestens einen.',
      },
      {
        key: 'weekdaysOnly',
        label: 'Nur an Werktagen',
        type: 'number',
        min: 0,
        max: 1,
        step: 1,
        help: '1 = nur Montag bis Freitag, 0 = jeden Tag.',
      },
    ],
    build: (values) => ({
      name: 'Rollläden morgens auf',
      trigger: {
        type: 'schedule',
        at: time(values, 'at'),
        days: num(values, 'weekdaysOnly') === 1 ? [1, 2, 3, 4, 5] : [],
      },
      actions: [
        {
          type: 'command',
          target: { deviceIds: list(values, 'covers') },
          command: { type: 'openCover' },
        },
      ],
      cooldownSeconds: 0,
    }),
  },

  {
    id: 'covers-evening',
    emoji: '🌆',
    name: 'Rollläden abends schließen',
    summary: 'Zur eingestellten Uhrzeit fahren alle Rollläden zu.',
    explanation:
      'Hält abends die Wärme drinnen und die Blicke draußen. Die Uhrzeit ist fest – der Hub ' +
      'kennt keinen Sonnenuntergang.',
    fields: [
      { key: 'at', label: 'Uhrzeit', type: 'time', help: 'Wann die Rollläden schließen sollen.' },
      {
        key: 'covers',
        label: 'Diese Rollläden',
        type: 'devices',
        capability: 'cover',
        help: 'Wähle mindestens einen Rollladen.',
      },
    ],
    build: (values) => ({
      name: 'Rollläden abends zu',
      trigger: { type: 'schedule', at: time(values, 'at'), days: [] },
      actions: [
        {
          type: 'command',
          target: { deviceIds: list(values, 'covers') },
          command: { type: 'closeCover' },
        },
      ],
      cooldownSeconds: 0,
    }),
  },

  {
    id: 'all-off-night',
    emoji: '🌙',
    name: 'Nachts alles ausschalten',
    summary: 'Zur eingestellten Uhrzeit gehen alle schaltbaren Geräte aus.',
    explanation:
      'Fängt vergessene Lampen und Steckdosen ab. Betrifft alle Geräte mit Schaltfunktion – ' +
      'was dauerhaft laufen soll (Kühlschrank, Router), sollte nicht an einer schaltbaren ' +
      'Steckdose hängen.',
    fields: [
      { key: 'at', label: 'Uhrzeit', type: 'time', help: 'Wann abgeschaltet wird.' },
    ],
    build: (values) => ({
      name: 'Nachts alles aus',
      trigger: { type: 'schedule', at: time(values, 'at'), days: [] },
      actions: [
        {
          type: 'command',
          target: { allWithCapability: 'switch' },
          command: { type: 'setPower', on: false },
        },
      ],
      cooldownSeconds: 0,
    }),
  },

  {
    id: 'airing-reminder',
    emoji: '🪟',
    name: 'Regelmäßig ans Lüften erinnern',
    summary: 'Wiederholt sich im eingestellten Takt, nur tagsüber.',
    explanation:
      'Ein Beispiel für eine wiederholende Regel: Sie läuft nicht zu einer festen Uhrzeit, ' +
      'sondern immer wieder im gewählten Abstand – und nur innerhalb des Zeitfensters. ' +
      'Die Meldung erscheint in der App.',
    fields: [
      {
        key: 'everyMinutes',
        label: 'Abstand',
        type: 'number',
        unit: 'Minuten',
        min: 5,
        max: 1440,
        step: 5,
        help: 'So oft wiederholt sich die Regel, solange das Zeitfenster gilt.',
      },
      { key: 'from', label: 'Frühestens ab', type: 'time', help: 'Vor dieser Uhrzeit passiert nichts.' },
      { key: 'to', label: 'Spätestens bis', type: 'time', help: 'Danach ruht die Regel bis zum nächsten Tag.' },
    ],
    build: (values) => ({
      name: 'Lüften nicht vergessen',
      trigger: {
        type: 'interval',
        everyMinutes: num(values, 'everyMinutes'),
        from: time(values, 'from'),
        to: time(values, 'to'),
      },
      actions: [{ type: 'notify', message: 'Zeit zum Lüften – kurz das Fenster öffnen.' }],
      cooldownSeconds: 0,
    }),
  },

  {
    id: 'heating-night-setback',
    emoji: '🌡️',
    name: 'Heizung nachts absenken',
    summary: 'Zur eingestellten Uhrzeit wird die Solltemperatur gesenkt.',
    explanation:
      'Spart Heizkosten, ohne dass jemand daran denken muss. Braucht ein Thermostat oder ' +
      'Heizkörperventil – etwa von Homematic oder einen Shelly TRV. Fürs Hochheizen am ' +
      'Morgen legst du dieselbe Vorlage ein zweites Mal an.',
    fields: [
      { key: 'at', label: 'Uhrzeit', type: 'time', help: 'Wann abgesenkt wird.' },
      {
        key: 'thermostats',
        label: 'Diese Heizungen',
        type: 'devices',
        capability: 'thermostat',
        help: 'Wähle mindestens ein Thermostat.',
      },
      {
        key: 'targetTemperature',
        label: 'Solltemperatur',
        type: 'number',
        unit: '°C',
        min: 4,
        max: 30,
        step: 0.5,
        help: '17 °C sind nachts für Wohnräume ein üblicher Wert.',
      },
    ],
    build: (values) => ({
      name: 'Heizung nachts absenken',
      trigger: { type: 'schedule', at: time(values, 'at'), days: [] },
      actions: [
        {
          type: 'command',
          target: { deviceIds: list(values, 'thermostats') },
          command: {
            type: 'setTargetTemperature',
            targetTemperatureC: num(values, 'targetTemperature'),
          },
        },
      ],
      cooldownSeconds: 0,
    }),
  },

  {
    id: 'low-battery',
    emoji: '🔋',
    name: 'Warnen bei schwacher Batterie',
    summary: 'Wenn die Batterie eines Sensors zur Neige geht, gibt es eine Meldung.',
    explanation:
      'Ein leerer Batteriesensor meldet keine Werte mehr – und das fällt oft erst auf, wenn die ' +
      'Heizungsautomatik nicht mehr schaltet. Die Meldung erscheint in der App.',
    fields: [
      {
        key: 'sensor',
        label: 'Gerät mit Batterie',
        type: 'device',
        capability: 'sensor.battery',
        help: 'Zum Beispiel ein Hue-Bewegungsmelder oder ein Shelly H&T.',
      },
      {
        key: 'below',
        label: 'Warnen unter',
        type: 'number',
        unit: '%',
        min: 5,
        max: 50,
        step: 5,
        help: 'Bei diesem Ladestand wird gemeldet.',
      },
    ],
    build: (values) => ({
      name: 'Batteriewarnung',
      trigger: {
        type: 'sensor',
        deviceId: str(values, 'sensor'),
        metric: 'batteryPercent',
        operator: '<',
        value: num(values, 'below'),
      },
      actions: [
        {
          type: 'notify',
          message: `Die Batterie eines Sensors ist unter ${num(values, 'below')} % gefallen.`,
        },
      ],
      cooldownSeconds: 86_400,
    }),
  },

  {
    id: 'humidity-fan',
    emoji: '💧',
    name: 'Lüften bei hoher Luftfeuchte',
    summary: 'Wenn die Luftfeuchte steigt, geht der Lüfter an.',
    explanation:
      'Beugt Schimmel im Bad vor. Der Lüfter muss an einer schaltbaren Steckdose hängen.',
    fields: [
      {
        key: 'sensor',
        label: 'Feuchtesensor',
        type: 'device',
        capability: 'sensor.humidity',
        help: 'Der Sensor im Bad oder in der Küche.',
      },
      {
        key: 'fan',
        label: 'Lüfter an dieser Steckdose',
        type: 'devices',
        capability: 'switch',
        help: 'Wird eingeschaltet, wenn es zu feucht wird.',
      },
      {
        key: 'above',
        label: 'Einschalten über',
        type: 'number',
        unit: '%',
        min: 40,
        max: 95,
        step: 5,
        help: 'Über diesem Wert wird gelüftet. 65 % ist ein guter Startwert.',
      },
      {
        key: 'forMinutes',
        label: 'So lange anhaltend',
        type: 'number',
        unit: 'Minuten',
        min: 0,
        max: 60,
        step: 1,
        help: 'Kurze Spitzen beim Duschen lösen damit nicht sofort aus.',
      },
    ],
    build: (values) => ({
      name: 'Lüften bei Feuchte',
      trigger: {
        type: 'sensor',
        deviceId: str(values, 'sensor'),
        metric: 'humidity',
        operator: '>',
        value: num(values, 'above'),
        forSeconds: num(values, 'forMinutes') * 60,
      },
      actions: [
        {
          type: 'command',
          target: { deviceIds: list(values, 'fan') },
          command: { type: 'setPower', on: true },
        },
      ],
      cooldownSeconds: 1800,
    }),
  },

  /*
   * Die drei Effekt-Vorlagen unterscheiden sich nur im Auslöser. Sie stehen
   * trotzdem einzeln da, weil „Wenn das Licht ausgeht" und „Wenn das Licht
   * angeht" zwei verschiedene Absichten sind – und niemand vor einer Vorlage
   * stehen soll, die erst nach dem Lesen eines Auswahlfeldes verrät, was sie
   * eigentlich tut.
   */
  {
    id: 'effect-when-off',
    emoji: '👻',
    name: 'Effekt starten, wenn das Licht ausgeht',
    summary: 'Sobald die gewählte Lampe ausgeschaltet wird, startet der Effekt.',
    explanation:
      'Der Klassiker für den Gruselmodus: Licht aus – und im Raum fängt es an zu flackern. ' +
      'Der Effekt läuft die eingestellte Zeit und stellt danach her, wie das Licht vorher war. ' +
      'Dass er sich dabei selbst erneut auslöst, verhindert der Hub.',
    fields: [
      {
        key: 'watch',
        label: 'Diese Lampe wird beobachtet',
        type: 'device',
        capability: 'switch',
        help: 'Der Effekt startet, sobald sie ausgeht.',
      },
      {
        key: 'effect',
        label: 'Effekt',
        type: 'choice',
        choices: effectChoices(),
        help: 'Disco und Farbwechsel brauchen Lampen, die Farbe können.',
      },
      {
        key: 'lights',
        label: 'Diese Lampen zeigen den Effekt',
        type: 'devices',
        capability: 'dimmer',
        help: 'Darf dieselbe Lampe sein, die beobachtet wird.',
      },
      {
        key: 'minutes',
        label: 'Wie lange',
        type: 'number',
        unit: 'Minuten',
        min: 1,
        max: 120,
        step: 1,
        help: 'Danach hört der Effekt von selbst auf.',
      },
    ],
    build: (values) => ({
      name: `${EFFECTS[effect(values, 'effect')].label}, wenn das Licht ausgeht`,
      trigger: {
        type: 'deviceState',
        deviceId: str(values, 'watch'),
        property: 'on',
        equals: false,
      },
      actions: [
        {
          type: 'effect',
          effect: effect(values, 'effect'),
          target: { deviceIds: list(values, 'lights') },
          minutes: num(values, 'minutes'),
        },
      ],
      cooldownSeconds: 60,
    }),
  },

  {
    id: 'effect-when-on',
    emoji: '🪩',
    name: 'Effekt starten, wenn das Licht angeht',
    summary: 'Sobald die gewählte Lampe eingeschaltet wird, startet der Effekt.',
    explanation:
      'Das Gegenstück: Licht an – und statt gewöhnlichem Weiß gibt es Disco. Praktisch für ' +
      'einen Schalter, der die Party startet, ohne dass jemand das Handy hervorholen muss.',
    fields: [
      {
        key: 'watch',
        label: 'Diese Lampe wird beobachtet',
        type: 'device',
        capability: 'switch',
        help: 'Der Effekt startet, sobald sie angeht.',
      },
      {
        key: 'effect',
        label: 'Effekt',
        type: 'choice',
        choices: effectChoices(),
        help: 'Disco und Farbwechsel brauchen Lampen, die Farbe können.',
      },
      {
        key: 'lights',
        label: 'Diese Lampen zeigen den Effekt',
        type: 'devices',
        capability: 'dimmer',
        help: 'Darf dieselbe Lampe sein, die beobachtet wird.',
      },
      {
        key: 'minutes',
        label: 'Wie lange',
        type: 'number',
        unit: 'Minuten',
        min: 1,
        max: 120,
        step: 1,
        help: 'Danach hört der Effekt von selbst auf.',
      },
    ],
    build: (values) => ({
      name: `${EFFECTS[effect(values, 'effect')].label}, wenn das Licht angeht`,
      trigger: {
        type: 'deviceState',
        deviceId: str(values, 'watch'),
        property: 'on',
        equals: true,
      },
      actions: [
        {
          type: 'effect',
          effect: effect(values, 'effect'),
          target: { deviceIds: list(values, 'lights') },
          minutes: num(values, 'minutes'),
        },
      ],
      cooldownSeconds: 60,
    }),
  },

  {
    id: 'effect-at-time',
    emoji: '🕯️',
    name: 'Effekt zu einer Uhrzeit',
    summary: 'Zur eingestellten Uhrzeit startet der gewählte Lichteffekt.',
    explanation:
      'Für den Kerzenschein ab acht oder den Gruselmodus, wenn abends die Klingel geht. ' +
      'Die Uhrzeit ist fest – Sonnenuntergang kennt der Hub nicht.',
    fields: [
      { key: 'at', label: 'Uhrzeit', type: 'time', help: 'Wann der Effekt losgeht.' },
      {
        key: 'effect',
        label: 'Effekt',
        type: 'choice',
        choices: effectChoices(),
        help: 'Disco und Farbwechsel brauchen Lampen, die Farbe können.',
      },
      {
        key: 'lights',
        label: 'Diese Lampen',
        type: 'devices',
        capability: 'dimmer',
        help: 'Wähle mindestens eine Lampe.',
      },
      {
        key: 'minutes',
        label: 'Wie lange',
        type: 'number',
        unit: 'Minuten',
        min: 1,
        max: 120,
        step: 1,
        help: 'Danach hört der Effekt von selbst auf.',
      },
    ],
    build: (values) => ({
      name: `${EFFECTS[effect(values, 'effect')].label} zur festen Zeit`,
      trigger: { type: 'schedule', at: time(values, 'at'), days: [] },
      actions: [
        {
          type: 'effect',
          effect: effect(values, 'effect'),
          target: { deviceIds: list(values, 'lights') },
          minutes: num(values, 'minutes'),
        },
      ],
      cooldownSeconds: 0,
    }),
  },

  {
    id: 'effect-stop-when-on',
    emoji: '🛑',
    name: 'Effekte beenden, wenn das Licht angeht',
    summary: 'Sobald die gewählte Lampe eingeschaltet wird, hören alle Effekte auf.',
    explanation:
      'Der Notausgang am Lichtschalter: Wer genug hat vom Flackern, schaltet die Lampe ein – ' +
      'und alles läuft wieder normal. Sinnvoll mit einer Lampe, die selbst nicht am Effekt ' +
      'beteiligt ist, etwa der im Flur.',
    fields: [
      {
        key: 'watch',
        label: 'Diese Lampe beendet die Effekte',
        type: 'device',
        capability: 'switch',
        help: 'Am besten eine, die nicht selbst mitflackert.',
      },
    ],
    build: (values) => ({
      name: 'Effekte am Schalter beenden',
      trigger: {
        type: 'deviceState',
        deviceId: str(values, 'watch'),
        property: 'on',
        equals: true,
      },
      actions: [{ type: 'stopEffect' }],
      cooldownSeconds: 5,
    }),
  },
];

/** Die Auswahl der Effekte – Beschriftung samt Symbol aus dem Effektdienst. */
function effectChoices(): Array<{ value: string; label: string }> {
  return LIGHT_EFFECT_IDS.map((id) => ({
    value: id,
    label: `${EFFECTS[id].icon} ${EFFECTS[id].label}`,
  }));
}

// ---------------------------------------------------------------------------
// Vorbelegung anhand des echten Gerätebestands
// ---------------------------------------------------------------------------

/**
 * Voreinstellungen je Vorlage und Feld.
 *
 * Bewusst zweistufig: `below` bedeutet bei der Heizung 19 °C und bei der
 * Batteriewarnung 20 % – ein gemeinsamer Wert für beide wäre in einem der
 * beiden Fälle Unsinn.
 */
const FIELD_DEFAULTS: Record<string, Record<string, string | number>> = {
  'motion-light': { cooldownMinutes: 5 },
  'cold-room-heat': { below: 19, forMinutes: 5 },
  'humidity-fan': { above: 65, forMinutes: 10 },
  'low-battery': { below: 20 },
  'covers-morning': { at: '07:30', weekdaysOnly: 1 },
  'covers-evening': { at: '21:00' },
  'all-off-night': { at: '23:30' },
  'airing-reminder': { everyMinutes: 180, from: '08:00', to: '20:00' },
  'heating-night-setback': { at: '22:30', targetTemperature: 17 },
  // Die Effekte kommen mit der Laufzeit, die zu ihnen passt: Gruseln zwanzig
  // Minuten, Disco zehn, Kerzenschein den ganzen Abend.
  'effect-when-off': { effect: 'gruselig', minutes: 20 },
  'effect-when-on': { effect: 'disco', minutes: 10 },
  'effect-at-time': { at: '20:00', effect: 'kerze', minutes: 60 },
};

/** Zeitfelder, die nicht die Standardvorgabe bekommen sollen. */
const MULTI_TIME_TEMPLATES = new Set(['airing-reminder']);

export function templateById(id: string): AutomationTemplate {
  const template = AUTOMATION_TEMPLATES.find((entry) => entry.id === id);
  if (!template) {
    throw badRequest(
      `Die Vorlage "${id}" gibt es nicht.`,
      undefined,
      'Die verfügbaren Vorlagen liefert GET /api/automations/templates.',
    );
  }
  return template;
}

/**
 * Ergänzt jede Vorlage um Auswahlmöglichkeiten und eine Vorbelegung.
 *
 * Bei der Vorbelegung wird versucht, Sensor und Aktor im selben Raum zu
 * paaren – ein Bewegungsmelder im Flur soll das Flurlicht schalten, nicht das
 * im Schlafzimmer.
 */
export function resolveTemplates(devices: Device[], rooms: Room[]): ResolvedTemplate[] {
  const roomName = new Map(rooms.map((room) => [room.id, room.name]));
  const visible = devices.filter((device) => !device.hidden);

  const withCapability = (capability: Capability): Device[] =>
    visible.filter((device) => device.capabilities.includes(capability));

  const label = (device: Device): string =>
    device.roomId
      ? `${device.name} (${roomName.get(device.roomId) ?? 'ohne Raum'})`
      : device.name;

  return AUTOMATION_TEMPLATES.map((template) => {
    const options: ResolvedTemplate['options'] = {};
    const defaults: TemplateValues = {};
    const missing: string[] = [];

    // Erst den Sensor bestimmen – er gibt den Raum für die Aktoren vor.
    const sensorField = template.fields.find((field) => field.type === 'device');
    const sensorDevice = sensorField?.capability
      ? withCapability(sensorField.capability)[0]
      : undefined;

    const presets = FIELD_DEFAULTS[template.id] ?? {};

    for (const field of template.fields) {
      if (field.type === 'number') {
        defaults[field.key] = presets[field.key] ?? field.min ?? 0;
        continue;
      }
      if (field.type === 'time') {
        defaults[field.key] =
          presets[field.key] ?? (MULTI_TIME_TEMPLATES.has(template.id) ? '08:00' : '07:00');
        continue;
      }
      if (field.type === 'choice') {
        // Die Auswahl steht in der Vorlage; hier fehlt nur die Vorbelegung.
        options[field.key] = (field.choices ?? []).map((choice) => ({
          id: choice.value,
          label: choice.label,
        }));
        defaults[field.key] = presets[field.key] ?? field.choices?.[0]?.value ?? '';
        continue;
      }
      if (!field.capability) continue;

      const candidates = withCapability(field.capability);
      options[field.key] = candidates.map((device) => ({ id: device.id, label: label(device) }));

      if (candidates.length === 0) {
        missing.push(describeMissing(field));
        continue;
      }

      if (field.type === 'device') {
        defaults[field.key] = candidates[0]?.id as string;
      } else {
        // Aktoren bevorzugt aus dem Raum des Sensors.
        const sameRoom = sensorDevice?.roomId
          ? candidates.filter((device) => device.roomId === sensorDevice.roomId)
          : [];
        const chosen = sameRoom.length > 0 ? sameRoom : candidates.slice(0, 1);
        defaults[field.key] = chosen.map((device) => device.id);
      }
    }

    const { build: _build, ...rest } = template;
    return { ...rest, applicable: missing.length === 0, missing, defaults, options };
  });
}

function describeMissing(field: TemplateField): string {
  const labels: Partial<Record<Capability, string>> = {
    'sensor.motion': 'Es ist kein Bewegungsmelder eingebunden.',
    'sensor.temperature': 'Es ist kein Temperatursensor eingebunden.',
    'sensor.humidity': 'Es ist kein Feuchtesensor eingebunden.',
    'sensor.battery': 'Kein Gerät meldet einen Batteriestand.',
    switch: 'Es ist kein schaltbares Gerät eingebunden.',
    dimmer: 'Es ist keine dimmbare Lampe eingebunden – ohne die gibt es nichts zu sehen.',
    cover: 'Es ist kein Rollladen eingebunden.',
    thermostat: 'Es ist keine Heizung mit Solltemperatur eingebunden.',
  };
  return (
    labels[field.capability as Capability] ??
    `Für "${field.label}" fehlt ein passendes Gerät.`
  );
}
