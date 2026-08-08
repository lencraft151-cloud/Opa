/**
 * Alte Geräte.
 *
 * Der Hub soll Rollläden, Heizungen und Temperatursensoren erkennen, egal wie
 * alt der Dienst dahinter ist: die runde Hue Bridge von 2012 (API v1), Shelly
 * der ersten Generation und Homematic BidCos neben HmIP. Die Abbildungen
 * werden hier gegen echte Antwortformate geprüft.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildV1LightUpdate } from '../src/adapters/hue/adapter.ts';
import {
  buildV1Devices,
  lightCapabilities,
  lightState,
  parseV1ExternalId,
  percentToBri,
  v1LightLevelToLux,
  V1_LIGHT_PREFIX,
} from '../src/adapters/hue/v1mapping.ts';
import {
  capabilitiesFor,
  classifyChannel,
  pickPrimaryChannels,
  stateFromValues,
  targetTemperatureKey,
  tiltKey,
} from '../src/adapters/homematic/mapping.ts';
import type { HomematicChannel } from '../src/adapters/homematic/client.ts';
import { parseGen1Status, parseGen2Status } from '../src/adapters/shelly/mapping.ts';
import { setLogLevel } from '../src/core/logger.ts';

setLogLevel('silent');

const emptyNaming = { deviceName: 'Shelly', channelNames: new Map<string, string>() };

// ---------------------------------------------------------------------------
// Hue – alte Bridge (API v1)
// ---------------------------------------------------------------------------

describe('Alte Hue Bridge (API v1)', () => {
  // Gekürzte, aber originalgetreue Antwort von `GET /api/<user>` einer BSB001.
  const lights = {
    '1': {
      state: { on: true, bri: 254, ct: 370, colormode: 'ct', reachable: true },
      type: 'Color temperature light',
      name: 'Küche Decke',
      modelid: 'LTW010',
      manufacturername: 'Philips',
      swversion: '1.29.0_r21169',
      uniqueid: '00:17:88:01:02:03:04:05-0b',
    },
    '2': {
      state: {
        on: false,
        bri: 127,
        hue: 8402,
        sat: 140,
        xy: [0.5, 0.4] as [number, number],
        colormode: 'hs',
        reachable: false,
      },
      type: 'Extended color light',
      name: 'Stehlampe',
      modelid: 'LCT001',
      uniqueid: '00:17:88:01:02:03:04:06-0b',
    },
  };

  const sensors = {
    '5': {
      state: { presence: true, lastupdated: '2024-01-01T10:00:00' },
      config: { on: true, battery: 87, reachable: true },
      type: 'ZLLPresence',
      name: 'Flur Bewegung',
      modelid: 'SML001',
      uniqueid: '00:17:88:01:02:03:04:07-02-0406',
    },
    '6': {
      state: { temperature: 2150, lastupdated: '2024-01-01T10:00:00' },
      config: { on: true, battery: 87, reachable: true },
      type: 'ZLLTemperature',
      name: 'Flur Temperatur',
      modelid: 'SML001',
      uniqueid: '00:17:88:01:02:03:04:07-02-0402',
    },
    '7': {
      state: { lightlevel: 15000, dark: false, daylight: true },
      config: { on: true, battery: 87, reachable: true },
      type: 'ZLLLightLevel',
      name: 'Flur Helligkeit',
      modelid: 'SML001',
      uniqueid: '00:17:88:01:02:03:04:07-02-0400',
    },
    // Der Tages-/Nacht-Sensor der Bridge ist kein echtes Gerät.
    '1': { state: { daylight: true }, type: 'Daylight', name: 'Daylight' },
  };

  const groups = {
    '1': { name: 'Küche', lights: ['1'], type: 'Room', class: 'Kitchen' },
  };

  const devices = buildV1Devices({ lights, sensors, groups });
  const byId = new Map(devices.map((device) => [device.externalId, device]));

  it('rechnet Helligkeit von 0..254 in Prozent um', () => {
    assert.equal(lightState(lights['1']).brightness, 100);
    assert.equal(lightState(lights['2']).brightness, 50);
  });

  it('erkennt Weißton und Farbe getrennt', () => {
    const white = lightState(lights['1']);
    assert.equal(white.colorTemperatureK, 2703, '370 Mired sind rund 2700 K');
    assert.equal(white.hue, undefined, 'eine Weißton-Lampe hat keinen Farbwert');

    const color = lightState(lights['2']);
    assert.ok(color.hue !== undefined && color.hue > 40 && color.hue < 50, 'hue 8402 ≈ 46°');
    assert.equal(color.saturation, 55.1);
  });

  it('leitet die Fähigkeiten aus dem gemeldeten Zustand ab', () => {
    assert.deepEqual(lightCapabilities(lights['1']), ['switch', 'dimmer', 'color_temperature']);
    assert.deepEqual(lightCapabilities(lights['2']), ['switch', 'dimmer', 'color']);
  });

  it('übernimmt den Raum aus den Gruppen der Bridge', () => {
    assert.equal(byId.get(`${V1_LIGHT_PREFIX}1`)?.suggestedRoom, 'Küche');
  });

  it('meldet nicht erreichbare Leuchten als solche', () => {
    assert.equal(byId.get(`${V1_LIGHT_PREFIX}2`)?.reachable, false);
  });

  it('fasst die drei Sensoren eines Bewegungsmelders zu einem Gerät zusammen', () => {
    const motion = devices.filter((device) => device.capabilities.includes('sensor.motion'));
    assert.equal(motion.length, 1, 'ein Melder, nicht drei');

    const device = motion[0];
    assert.ok(device);
    assert.deepEqual(
      [...device.capabilities].sort(),
      ['sensor.battery', 'sensor.illuminance', 'sensor.motion', 'sensor.temperature'],
    );
    assert.equal(device.state.temperatureC, 21.5, '2150 Hundertstel sind 21,50 °C');
    assert.equal(device.state.motion, true);
    assert.equal(device.state.batteryPercent, 87);
  });

  it('rechnet das logarithmische Lichtniveau in Lux um', () => {
    assert.equal(v1LightLevelToLux(0), 0);
    assert.equal(v1LightLevelToLux(1), 1);
    // 10^((15000-1)/10000) ≈ 31,6 lx
    assert.ok(Math.abs(v1LightLevelToLux(15000) - 31.6) < 0.2);
  });

  it('lässt den Tageslicht-Sensor der Bridge weg', () => {
    assert.equal(
      devices.some((device) => device.name === 'Daylight'),
      false,
    );
  });

  it('unterscheidet V1-Kennungen von denen der neuen API', () => {
    assert.deepEqual(parseV1ExternalId('v1-light:3'), { kind: 'light', id: '3' });
    assert.deepEqual(parseV1ExternalId('v1-sensor:9'), { kind: 'sensor', id: '9' });
    assert.equal(parseV1ExternalId('abcd-1234-uuid'), null);
  });

  it('schreibt Kommandos im alten Format', () => {
    assert.deepEqual(buildV1LightUpdate({ type: 'setPower', on: true }).body, { on: true });

    const dim = buildV1LightUpdate({ type: 'setBrightness', brightness: 50 });
    assert.equal(dim.body['bri'], percentToBri(50));
    assert.equal(dim.body['on'], true, 'Dimmen schaltet die Lampe ein');

    const color = buildV1LightUpdate({ type: 'setColor', hue: 180, saturation: 100 });
    assert.equal(color.body['hue'], 32768);
    assert.equal(color.body['sat'], 254);
  });

  it('erklärt, was die alte Bridge nicht kann', () => {
    assert.throws(() => buildV1LightUpdate({ type: 'toggle' }), /nicht direkt unterstützt/);
  });
});

// ---------------------------------------------------------------------------
// Shelly – erste Generation
// ---------------------------------------------------------------------------

describe('Shelly der ersten Generation', () => {
  it('erkennt das Heizkörperventil Shelly TRV', () => {
    // Auszug aus `GET /status` eines SHTRV-01.
    const components = parseGen1Status(
      {
        thermostats: [
          {
            target_t: { enabled: true, value: 21.5, units: 'C' },
            tmp: { value: 20.2, units: 'C', is_valid: true },
            pos: 42,
            schedule: false,
          },
        ],
        bat: { value: 74, voltage: 3.9 },
      },
      emptyNaming,
    );

    const thermostat = components.find((entry) => entry.externalId === 'thermostat:0');
    assert.ok(thermostat, 'das Ventil muss als Gerät auftauchen');
    assert.deepEqual([...thermostat.capabilities].sort(), ['sensor.temperature', 'thermostat']);
    assert.equal(thermostat.state.targetTemperatureC, 21.5);
    assert.equal(thermostat.state.temperatureC, 20.2);
    assert.equal(thermostat.state.valvePosition, 42);

    const battery = components.find((entry) => entry.capabilities.includes('sensor.battery'));
    assert.equal(battery?.state.batteryPercent, 74);
  });

  it('erkennt den Rollladen eines Shelly 2.5 im Roller-Modus', () => {
    const components = parseGen1Status(
      {
        rollers: [
          { state: 'close', current_pos: 30, power: 12.4, is_valid: true, positioning: true },
        ],
        meters: [{ power: 12.4, total: 1500 }],
      },
      emptyNaming,
    );

    const cover = components.find((entry) => entry.capabilities.includes('cover'));
    assert.ok(cover, 'der Rollladen fehlt');
    assert.equal(cover.state.position, 30);
    assert.equal(cover.state.coverState, 'closing');
  });

  it('bietet im Rollladenmodus nicht auch noch die Motorrelais an', () => {
    /*
     * Ein Shelly 2.5 im Rollladenmodus meldet zusätzlich seine zwei Relais –
     * das sind die Motorrichtungen. Als Schalter angeboten wären sie nicht
     * nur verwirrend, sondern gefährlich: beide zugleich ein legt Spannung
     * auf beide Wicklungen.
     */
    const components = parseGen1Status(
      {
        relays: [
          { ison: false, has_timer: false },
          { ison: false, has_timer: false },
        ],
        rollers: [{ state: 'stop', current_pos: 70, power: 0, is_valid: true, positioning: true }],
        meters: [{ power: 0, total: 24500 }],
      },
      emptyNaming,
    );

    assert.equal(
      components.filter((entry) => entry.capabilities.includes('switch')).length,
      0,
      'im Rollladenmodus gibt es keine Schalter',
    );
    assert.equal(components.filter((entry) => entry.capabilities.includes('cover')).length, 1);
  });

  it('zeigt ohne Rollladenmodus weiterhin die Relais', () => {
    const components = parseGen1Status(
      { relays: [{ ison: true, has_timer: false }], meters: [{ power: 12, total: 100 }] },
      emptyNaming,
    );
    assert.equal(components.filter((entry) => entry.capabilities.includes('switch')).length, 1);
  });

  it('erkennt den Temperatursensor eines Shelly H&T', () => {
    const components = parseGen1Status(
      { tmp: { value: 19.75, units: 'C', is_valid: true }, hum: { value: 55, is_valid: true } },
      emptyNaming,
    );

    const temperature = components.find((entry) =>
      entry.capabilities.includes('sensor.temperature'),
    );
    assert.equal(temperature?.state.temperatureC, 19.75);

    const humidity = components.find((entry) => entry.capabilities.includes('sensor.humidity'));
    assert.equal(humidity?.state.humidity, 55);
  });

  it('erkennt Rollladen und Heizung eines neuen Geräts (Gen2)', () => {
    const components = parseGen2Status(
      {
        'cover:0': {
          id: 0,
          state: 'opening',
          current_pos: 65,
          slat_pos: 20,
          apower: 8.2,
          pos_control: true,
        },
        'thermostat:0': { id: 0, target_C: 22, current_C: 21.4 },
      },
      emptyNaming,
    );

    const cover = components.find((entry) => entry.externalId === 'cover:0');
    assert.equal(cover?.state.position, 65);
    assert.equal(cover?.state.coverState, 'opening');
    assert.ok(cover?.capabilities.includes('cover.tilt'), 'Lamellen werden erkannt');

    const thermostat = components.find((entry) => entry.externalId === 'thermostat:0');
    assert.equal(thermostat?.state.targetTemperatureC, 22);
    assert.equal(thermostat?.state.temperatureC, 21.4);
  });
});

// ---------------------------------------------------------------------------
// Homematic – BidCos und HmIP
// ---------------------------------------------------------------------------

describe('Homematic', () => {
  const channel = (channelType: string): HomematicChannel => ({
    id: '1',
    address: 'ABC1234567:1',
    name: 'Test',
    channelType,
    interfaceName: 'BidCos-RF',
    deviceName: 'Test',
    deviceType: 'HM-Test',
    deviceAddress: 'ABC1234567',
  });

  it('ordnet Kanaltypen quer über die Gerätegenerationen zu', () => {
    // BidCos (seit 2010) und HmIP (seit 2015) nebeneinander.
    assert.equal(classifyChannel(channel('BLIND_VIRTUAL_RECEIVER')), 'cover');
    assert.equal(classifyChannel(channel('BLIND')), 'cover');
    assert.equal(classifyChannel(channel('JALOUSIE')), 'cover');
    // HmIP-Rollladenaktoren (HmIP-BROLL, HmIP-FROLL) heißen SHUTTER.
    assert.equal(classifyChannel(channel('SHUTTER_VIRTUAL_RECEIVER')), 'cover');
    assert.equal(classifyChannel(channel('SHUTTER_TRANSMITTER')), 'cover');
    // Aber der Fensterkontakt heißt genauso und ist keiner.
    assert.equal(classifyChannel(channel('SHUTTER_CONTACT')), 'contact');
    assert.equal(classifyChannel(channel('HEATING_CLIMATECONTROL_TRANSCEIVER')), 'thermostat');
    assert.equal(classifyChannel(channel('CLIMATECONTROL_RT_TRANSCEIVER')), 'thermostat');
    assert.equal(classifyChannel(channel('WEATHER')), 'climate');
    assert.equal(classifyChannel(channel('CLIMATE_TRANSCEIVER')), 'climate');
    assert.equal(classifyChannel(channel('SWITCH')), 'switch');
    assert.equal(classifyChannel(channel('MAINTENANCE')), 'maintenance');
    assert.equal(classifyChannel(channel('IRGENDWAS_NEUES')), null);
  });

  it('liest einen HmIP-Rollladen samt Lamellen', () => {
    const values = { LEVEL: 0.65, LEVEL_SLATS: 0.2, ACTIVITY_STATE: 'DOWN' };
    assert.deepEqual(capabilitiesFor('cover', values), ['cover', 'cover.tilt']);

    const state = stateFromValues('cover', values);
    assert.equal(state.position, 65, 'Homematic zählt 0..1, der Hub in Prozent');
    assert.equal(state.tilt, 20);
    assert.equal(state.coverState, 'closing');
  });

  it('erkennt die Fahrtrichtung eines alten BidCos-Rollladens', () => {
    // Die alten Aktoren kennen ACTIVITY_STATE nicht, nur DIRECTION.
    assert.equal(stateFromValues('cover', { LEVEL: 0.5, DIRECTION: 1 }).coverState, 'opening');
    assert.equal(stateFromValues('cover', { LEVEL: 0.5, DIRECTION: 2 }).coverState, 'closing');
    assert.equal(stateFromValues('cover', { LEVEL: 0, DIRECTION: 0 }).coverState, 'closed');
    assert.equal(stateFromValues('cover', { LEVEL: 1, DIRECTION: 0 }).coverState, 'open');
  });

  it('liest ein Heizkörperthermostat mit Ist-, Soll- und Ventilwert', () => {
    const hmip = { SET_POINT_TEMPERATURE: 21.5, ACTUAL_TEMPERATURE: 20.3, LEVEL: 0.35 };
    assert.deepEqual(capabilitiesFor('thermostat', hmip), ['thermostat', 'sensor.temperature']);

    const state = stateFromValues('thermostat', hmip);
    assert.equal(state.targetTemperatureC, 21.5);
    assert.equal(state.temperatureC, 20.3);
    assert.equal(state.valvePosition, 35);
  });

  it('kennt den anderen Wertenamen der alten Thermostate', () => {
    const bidcos = { SET_TEMPERATURE: 19, ACTUAL_TEMPERATURE: 18.5 };
    assert.equal(stateFromValues('thermostat', bidcos).targetTemperatureC, 19);
    assert.equal(targetTemperatureKey(bidcos), 'SET_TEMPERATURE');
    assert.equal(targetTemperatureKey({ SET_POINT_TEMPERATURE: 21 }), 'SET_POINT_TEMPERATURE');
  });

  it('nimmt den Wertenamen für Lamellen, den das Gerät wirklich hat', () => {
    assert.equal(tiltKey({ LEVEL_SLATS: 0.5 }), 'LEVEL_SLATS');
    assert.equal(tiltKey({ LEVEL_2: 0.5 }), 'LEVEL_2');
  });

  it('liest Temperatur und Feuchte eines reinen Klimasensors', () => {
    const values = { ACTUAL_TEMPERATURE: 22.15, HUMIDITY: 48 };
    assert.deepEqual(capabilitiesFor('climate', values), [
      'sensor.temperature',
      'sensor.humidity',
    ]);
    const state = stateFromValues('climate', values);
    assert.equal(state.temperatureC, 22.15);
    assert.equal(state.humidity, 48);
  });

  it('versteht Zahlen, die als Zeichenkette kommen', () => {
    // Die CCU liefert je nach Firmware Zahlen als Text.
    const state = stateFromValues('climate', { ACTUAL_TEMPERATURE: '21.75', HUMIDITY: '50' });
    assert.equal(state.temperatureC, 21.75);
    assert.equal(state.humidity, 50);
  });

  it('macht aus fünf gleichwertigen Kanälen einen Rollladen', () => {
    /*
     * Ein HmIP-BROLL führt für jede Gruppenzuordnung einen eigenen
     * „virtual receiver“ – alle fahren denselben Motor. Ohne diesen Schritt
     * stünde derselbe Rollladen fünfmal in der Geräteliste.
     */
    const entries = [3, 4, 5, 6, 7].map((index) => ({
      channel: { ...channel('SHUTTER_VIRTUAL_RECEIVER'), address: `ABC1234567:${index}` },
      kind: 'cover' as const,
    }));
    entries.push({
      channel: { ...channel('SHUTTER_TRANSMITTER'), address: 'ABC1234567:1' },
      kind: 'cover' as const,
    });

    const picked = pickPrimaryChannels(entries);
    assert.equal(picked.length, 1);
    assert.equal(
      picked[0]?.channel.address,
      'ABC1234567:3',
      'der Empfängerkanal mit der kleinsten Nummer gewinnt',
    );
  });

  it('lässt Kanäle verschiedener Geräte und Gattungen nebeneinander', () => {
    const on = (deviceAddress: string, index: number, type: string) => ({
      ...channel(type),
      deviceAddress,
      address: `${deviceAddress}:${index}`,
    });

    const picked = pickPrimaryChannels([
      { channel: on('AAA1', 3, 'SHUTTER_VIRTUAL_RECEIVER'), kind: 'cover' as const },
      { channel: on('BBB2', 3, 'SHUTTER_VIRTUAL_RECEIVER'), kind: 'cover' as const },
      { channel: on('AAA1', 1, 'WEATHER'), kind: 'climate' as const },
    ]);
    assert.equal(picked.length, 3, 'zwei Rollläden plus ein Sensorkanal');
  });

  it('macht aus „Batterie schwach" einen Prozentwert', () => {
    // Alte BidCos-Geräte melden nur ja/nein.
    assert.equal(stateFromValues('maintenance', { LOWBAT: true }).batteryPercent, 10);
    assert.equal(stateFromValues('maintenance', { LOWBAT: false }).batteryPercent, 100);
    // HmIP meldet einen echten Pegel – der hat Vorrang.
    assert.equal(
      stateFromValues('maintenance', { OPERATING_VOLTAGE_LEVEL: 0.8, LOW_BAT: true })
        .batteryPercent,
      80,
    );
  });
});
