import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { HueResource } from '../src/adapters/hue/client.ts';
import { parseEventStreamChunk } from '../src/adapters/hue/client.ts';
import {
  capabilitiesFor,
  hueLightLevelToLux,
  indexResources,
  isControllableDevice,
  isReachable,
  stateFor,
} from '../src/adapters/hue/mapping.ts';
import { buildLightUpdate } from '../src/adapters/hue/adapter.ts';

const resources: HueResource[] = [
  {
    id: 'dev-lamp',
    type: 'device',
    metadata: { name: 'Stehlampe' },
    product_data: {
      manufacturer_name: 'Signify Netherlands B.V.',
      model_id: 'LCT015',
      product_name: 'Hue color lamp',
      software_version: '1.104.2',
    },
    services: [
      { rid: 'light-1', rtype: 'light' },
      { rid: 'zig-1', rtype: 'zigbee_connectivity' },
    ],
  },
  {
    id: 'light-1',
    type: 'light',
    owner: { rid: 'dev-lamp', rtype: 'device' },
    on: { on: true },
    dimming: { brightness: 62.5 },
    color_temperature: { mirek: 370, mirek_valid: true },
    color: { xy: { x: 0.4573, y: 0.41 } },
  },
  { id: 'zig-1', type: 'zigbee_connectivity', status: 'connected' },
  {
    id: 'dev-sensor',
    type: 'device',
    metadata: { name: 'Bewegungsmelder Flur' },
    product_data: { model_id: 'SML001', manufacturer_name: 'Signify Netherlands B.V.' },
    services: [
      { rid: 'temp-1', rtype: 'temperature' },
      { rid: 'motion-1', rtype: 'motion' },
      { rid: 'lux-1', rtype: 'light_level' },
      { rid: 'power-1', rtype: 'device_power' },
    ],
  },
  {
    id: 'temp-1',
    type: 'temperature',
    owner: { rid: 'dev-sensor', rtype: 'device' },
    temperature: { temperature: 21.42, temperature_valid: true },
  },
  {
    id: 'motion-1',
    type: 'motion',
    owner: { rid: 'dev-sensor', rtype: 'device' },
    motion: { motion: true, motion_valid: true },
  },
  {
    id: 'lux-1',
    type: 'light_level',
    owner: { rid: 'dev-sensor', rtype: 'device' },
    light: { light_level: 20001, light_level_valid: true },
  },
  {
    id: 'power-1',
    type: 'device_power',
    owner: { rid: 'dev-sensor', rtype: 'device' },
    power_state: { battery_level: 78, battery_state: 'normal' },
  },
  {
    id: 'dev-bridge',
    type: 'device',
    metadata: { name: 'Hue Bridge' },
    services: [{ rid: 'bridge-1', rtype: 'bridge' }],
  },
  {
    id: 'room-1',
    type: 'room',
    metadata: { name: 'Wohnzimmer' },
    children: [{ rid: 'dev-lamp', rtype: 'device' }],
  },
];

const index = indexResources(resources);

describe('Hue-Ressourcen auf Hub-Geräte abbilden', () => {
  it('ordnet Services ihrem Gerät zu', () => {
    assert.equal(index.services.get('dev-lamp')?.light, 'light-1');
    assert.equal(index.services.get('dev-sensor')?.temperature, 'temp-1');
    assert.equal(index.ownerByService.get('motion-1'), 'dev-sensor');
  });

  it('leitet die Fähigkeiten einer Farblampe ab', () => {
    assert.deepEqual(capabilitiesFor('dev-lamp', index), [
      'switch',
      'dimmer',
      'color_temperature',
      'color',
    ]);
  });

  it('leitet die Fähigkeiten eines Bewegungsmelders ab', () => {
    assert.deepEqual(capabilitiesFor('dev-sensor', index), [
      'sensor.temperature',
      'sensor.motion',
      'sensor.illuminance',
      'sensor.battery',
    ]);
  });

  it('blendet die Bridge selbst aus', () => {
    assert.equal(isControllableDevice('dev-bridge', index), false);
    assert.equal(isControllableDevice('dev-lamp', index), true);
  });

  it('liest den Lampenzustand inklusive Farbtemperatur in Kelvin', () => {
    const state = stateFor('dev-lamp', index);
    assert.equal(state.on, true);
    assert.equal(state.brightness, 62.5);
    assert.equal(state.colorTemperatureK, 2703);
    assert.ok(typeof state.hue === 'number' && typeof state.saturation === 'number');
  });

  it('liest Sensorwerte inklusive logarithmischer Helligkeit', () => {
    const state = stateFor('dev-sensor', index);
    assert.equal(state.temperatureC, 21.42);
    assert.equal(state.motion, true);
    assert.equal(state.batteryPercent, 78);
    assert.equal(state.illuminanceLux, 100, '20001 entspricht 100 lx');
  });

  it('rechnet Hue-Lichtniveaus in Lux um', () => {
    assert.equal(hueLightLevelToLux(0), 0);
    assert.equal(hueLightLevelToLux(1), 1);
    assert.equal(hueLightLevelToLux(10001), 10);
  });

  it('übernimmt Hue-Räume als Vorschlag', () => {
    assert.equal(index.roomByDevice.get('dev-lamp'), 'Wohnzimmer');
  });

  it('wertet die Zigbee-Verbindung als Erreichbarkeit aus', () => {
    assert.equal(isReachable('dev-lamp', index), true);
    const offline = indexResources([
      ...resources.filter((resource) => resource.id !== 'zig-1'),
      { id: 'zig-1', type: 'zigbee_connectivity', status: 'connectivity_issue' },
    ]);
    assert.equal(isReachable('dev-lamp', offline), false);
  });

  it('ignoriert als ungültig markierte Messwerte', () => {
    const invalid = indexResources([
      ...resources.filter((resource) => resource.id !== 'temp-1'),
      {
        id: 'temp-1',
        type: 'temperature',
        owner: { rid: 'dev-sensor', rtype: 'device' },
        temperature: { temperature: 0, temperature_valid: false },
      },
    ]);
    assert.equal(stateFor('dev-sensor', invalid).temperatureC, undefined);
  });
});

describe('Kommandos für die Hue Bridge', () => {
  it('schaltet ein und aus', () => {
    assert.deepEqual(buildLightUpdate({ type: 'setPower', on: true }, {}).update, {
      on: { on: true },
    });
  });

  it('kehrt den aktuellen Zustand beim Umschalten um', () => {
    assert.deepEqual(buildLightUpdate({ type: 'toggle' }, { on: true }).update, {
      on: { on: false },
    });
    assert.deepEqual(buildLightUpdate({ type: 'toggle' }, {}).update, { on: { on: true } });
  });

  it('schaltet bei Helligkeit 0 aus statt auf 0 % zu dimmen', () => {
    const result = buildLightUpdate({ type: 'setBrightness', brightness: 0 }, { on: true });
    assert.deepEqual(result.update, { on: { on: false } });
    assert.equal(result.optimistic.on, false);
  });

  it('schaltet beim Dimmen automatisch ein', () => {
    const result = buildLightUpdate({ type: 'setBrightness', brightness: 40 }, { on: false });
    assert.deepEqual(result.update, { on: { on: true }, dimming: { brightness: 40 } });
  });

  it('wandelt Kelvin in Mirek und begrenzt den Bereich', () => {
    const warm = buildLightUpdate({ type: 'setColorTemperature', kelvin: 2700 }, {});
    assert.equal(warm.update.color_temperature?.mirek, 370);
    const tooCold = buildLightUpdate({ type: 'setColorTemperature', kelvin: 9000 }, {});
    assert.ok((tooCold.update.color_temperature?.mirek ?? 0) >= 153);
  });

  it('wandelt HSV in xy', () => {
    const result = buildLightUpdate({ type: 'setColor', hue: 120, saturation: 100 }, {});
    assert.ok(result.update.color?.xy);
    assert.equal(result.optimistic.hue, 120);
  });

  it('lehnt Rollladen-Kommandos für Leuchten mit einem Hinweis ab', () => {
    for (const command of [
      { type: 'setPosition', position: 50 },
      { type: 'openCover' },
      { type: 'closeCover' },
      { type: 'stopCover' },
      { type: 'setTilt', tilt: 40 },
    ] as const) {
      assert.throws(
        () => buildLightUpdate(command, {}),
        (err: Error) => {
          assert.match(err.message, /Rollladen/);
          assert.match((err as { hint?: string }).hint ?? '', /cover/);
          return true;
        },
        `Kommando ${command.type}`,
      );
    }
  });
});

describe('Hue Eventstream', () => {
  it('zerlegt vollständige SSE-Blöcke und puffert den Rest', () => {
    const chunk =
      'id: 1\ndata: [{"id":"e1","type":"update","data":[{"id":"light-1","type":"light","on":{"on":false}}]}]\n\n' +
      'id: 2\ndata: [{"id":"e2","type":"upda';
    const { events, rest } = parseEventStreamChunk(chunk);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.data[0]?.id, 'light-1');
    assert.ok(rest.startsWith('id: 2'));
  });

  it('überspringt kaputte Blöcke, ohne zu werfen', () => {
    const { events } = parseEventStreamChunk('data: {kein json}\n\n');
    assert.equal(events.length, 0);
  });
});
