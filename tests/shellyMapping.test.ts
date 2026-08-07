import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  namingFromConfig,
  parseComponentId,
  parseGen1Status,
  parseGen2Status,
} from '../src/adapters/shelly/mapping.ts';

const naming = { deviceName: 'Shelly', channelNames: new Map<string, string>() };

describe('Shelly Gen2/Gen3 Status', () => {
  // Ausschnitt einer echten Shelly.GetStatus-Antwort eines Plus 1PM.
  const status = {
    'switch:0': {
      id: 0,
      output: true,
      apower: 12.4,
      voltage: 230.1,
      aenergy: { total: 1234.5, by_minute: [], minute_ts: 0 },
      temperature: { tC: 44.2, tF: 111.5 },
    },
    'temperature:0': { id: 0, tC: 21.35, tF: 70.4 },
    'humidity:0': { id: 0, rh: 48.2 },
    'devicepower:0': { id: 0, battery: { V: 5.9, percent: 87 }, external: { present: false } },
    'cover:0': { id: 0, state: 'stopped', current_pos: 65, apower: 0 },
    sys: { mac: 'A8032AB', uptime: 90 },
    wifi: { sta_ip: '192.168.1.50', status: 'got ip' },
  };

  const components = parseGen2Status(status, naming);
  const byId = new Map(components.map((component) => [component.externalId, component]));

  it('erkennt den Schaltkanal inklusive Messwerten', () => {
    const relay = byId.get('switch:0');
    assert.ok(relay);
    assert.equal(relay?.state.on, true);
    assert.equal(relay?.state.powerW, 12.4);
    assert.equal(relay?.state.energyWh, 1234.5);
    assert.deepEqual(relay?.capabilities, ['switch', 'sensor.power', 'sensor.energy']);
  });

  it('legt Temperatur und Luftfeuchte als eigene Geräte an', () => {
    assert.equal(byId.get('temperature:0')?.state.temperatureC, 21.35);
    assert.deepEqual(byId.get('temperature:0')?.capabilities, ['sensor.temperature']);
    assert.equal(byId.get('humidity:0')?.state.humidity, 48.2);
  });

  it('übernimmt den Batteriestand', () => {
    assert.equal(byId.get('devicepower:0')?.state.batteryPercent, 87);
  });

  it('erkennt Rollläden mit Position', () => {
    const cover = byId.get('cover:0');
    assert.equal(cover?.state.position, 65);
    assert.ok(cover?.capabilities.includes('cover'));
  });

  it('ignoriert Systemkomponenten ohne Doppelpunkt-ID', () => {
    assert.equal(byId.has('sys'), false);
    assert.equal(byId.has('wifi'), false);
  });

  it('verwendet konfigurierte Kanalnamen', () => {
    const custom = parseGen2Status(status, {
      deviceName: 'Shelly',
      channelNames: new Map([['switch:0', 'Kaffeemaschine']]),
    });
    assert.equal(custom.find((c) => c.externalId === 'switch:0')?.name, 'Kaffeemaschine');
  });
});

describe('Shelly Gen1 Status', () => {
  it('liest Relais mit Verbrauchszähler (Watt-Minuten → Wattstunden)', () => {
    const components = parseGen1Status(
      {
        relays: [{ ison: true, has_timer: false }],
        meters: [{ power: 8.2, total: 600 }],
      },
      naming,
    );
    const relay = components[0];
    assert.equal(relay?.externalId, 'switch:0');
    assert.equal(relay?.state.on, true);
    assert.equal(relay?.state.powerW, 8.2);
    assert.equal(relay?.state.energyWh, 10, '600 Wmin sind 10 Wh');
  });

  it('liest Shelly H&T (Temperatur, Feuchte, Batterie)', () => {
    const components = parseGen1Status(
      {
        tmp: { value: 22.5, tC: 22.5, units: 'C', is_valid: true },
        hum: { value: 55, is_valid: true },
        bat: { value: 93, voltage: 2.94 },
      },
      naming,
    );
    const byId = new Map(components.map((component) => [component.externalId, component]));
    assert.equal(byId.get('temperature:0')?.state.temperatureC, 22.5);
    assert.equal(byId.get('humidity:0')?.state.humidity, 55);
    assert.equal(byId.get('devicepower:0')?.state.batteryPercent, 93);
  });

  it('verwirft als ungültig markierte Messwerte', () => {
    const components = parseGen1Status(
      { tmp: { value: 0, is_valid: false }, hum: { value: 0, is_valid: false } },
      naming,
    );
    assert.equal(components.length, 0);
  });

  it('liest Dimmer inklusive Helligkeit', () => {
    const components = parseGen1Status(
      { lights: [{ ison: true, brightness: 42, mode: 'white' }] },
      naming,
    );
    assert.equal(components[0]?.state.brightness, 42);
    assert.deepEqual(components[0]?.capabilities, ['switch', 'dimmer']);
  });

  it('liest Add-On-Temperaturfühler', () => {
    const components = parseGen1Status(
      { relays: [{ ison: false }], ext_temperature: { '0': { hC: 18.75 }, '1': { hC: 7.5 } } },
      naming,
    );
    const externals = components.filter((c) => c.externalId.startsWith('temperature:ext'));
    assert.equal(externals.length, 2);
    assert.equal(externals[0]?.state.temperatureC, 18.75);
  });

  it('legt für reine Messgeräte ohne Relais eigene Komponenten an', () => {
    const components = parseGen1Status({ emeters: [{ power: 350.5, total: 12000 }] }, naming);
    assert.equal(components[0]?.externalId, 'pm1:0');
    assert.equal(components[0]?.state.powerW, 350.5);
    assert.equal(components[0]?.state.energyWh, 12000, 'E-Meter zählen bereits in Wh');
  });
});

describe('Hilfsfunktionen', () => {
  it('zerlegt Komponenten-IDs', () => {
    assert.deepEqual(parseComponentId('switch:2'), { kind: 'switch', channel: 2 });
    assert.deepEqual(parseComponentId('temperature:ext1'), { kind: 'temperature', channel: 0 });
  });

  it('liest Kanalnamen aus der Gen2-Konfiguration', () => {
    const result = namingFromConfig(
      {
        sys: { device: { name: 'Wohnzimmer Lampe' } },
        'switch:0': { id: 0, name: 'Stehlampe' },
      },
      2,
      'fallback',
    );
    assert.equal(result.deviceName, 'Wohnzimmer Lampe');
    assert.equal(result.channelNames.get('switch:0'), 'Stehlampe');
  });

  it('liest Kanalnamen aus der Gen1-Konfiguration', () => {
    const result = namingFromConfig(
      { name: 'Flur', relays: [{ name: 'Deckenlicht' }, { name: null }] },
      1,
      'fallback',
    );
    assert.equal(result.deviceName, 'Flur');
    assert.equal(result.channelNames.get('switch:0'), 'Deckenlicht');
    assert.equal(result.channelNames.has('switch:1'), false);
  });
});
