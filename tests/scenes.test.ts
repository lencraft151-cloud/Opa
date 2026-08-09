/**
 * Szenen und Urlaubsmodus.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setLogLevel } from '../src/core/logger.ts';
import type { Capability, Device, DeviceState } from '../src/core/types.ts';
import { Database } from '../src/storage/database.ts';
import { createRepositories, type Repositories } from '../src/storage/repositories.ts';
import { HouseholdService, normalizePresence } from '../src/services/householdService.ts';
import { commandsForState, SceneService } from '../src/services/sceneService.ts';
import { DEFAULT_PRESENCE } from '../src/core/types.ts';
import { nowIso } from '../src/util/id.ts';

setLogLevel('silent');

function makeDevice(
  id: string,
  name: string,
  capabilities: Capability[],
  state: DeviceState,
): Device {
  return {
    id,
    householdId: 'hh_1',
    integrationId: 'int_1',
    roomId: null,
    externalId: id,
    vendor: 'shelly',
    name,
    manufacturer: null,
    model: null,
    firmware: null,
    capabilities,
    capabilityOverride: null,
    state,
    reachable: true,
    hidden: false,
    lastSeenAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

describe('Aus einem Zustand Kommandos ableiten', () => {
  it('sichert Farbe und Helligkeit einer eingeschalteten Lampe', () => {
    const commands = commandsForState(
      makeDevice('dev_1', 'Stehlampe', ['switch', 'dimmer', 'color'], {
        on: true,
        brightness: 42.5,
        hue: 300,
        saturation: 90,
      }),
    );
    assert.deepEqual(commands, [
      { type: 'setColor', hue: 300, saturation: 90 },
      { type: 'setBrightness', brightness: 42.5 },
      { type: 'setPower', on: true },
    ]);
  });

  it('setzt erst die Farbe und schaltet dann ein', () => {
    // Umgekehrt sähe man beim Herstellen der Szene kurz die alte Farbe.
    const commands = commandsForState(
      makeDevice('dev_1', 'Lampe', ['switch', 'dimmer', 'color'], {
        on: true,
        brightness: 50,
        hue: 10,
        saturation: 20,
      }),
    );
    assert.equal(commands.at(-1)?.type, 'setPower');
  });

  it('merkt sich von einer ausgeschalteten Lampe nur, dass sie aus ist', () => {
    // Helligkeit und Farbe mitzuschreiben würde sie beim Abrufen der Szene
    // kurz aufblitzen lassen.
    const commands = commandsForState(
      makeDevice('dev_1', 'Lampe', ['switch', 'dimmer', 'color'], {
        on: false,
        brightness: 80,
        hue: 200,
        saturation: 50,
      }),
    );
    assert.deepEqual(commands, [{ type: 'setPower', on: false }]);
  });

  it('nimmt bei Weißton-Lampen die Farbtemperatur', () => {
    const commands = commandsForState(
      makeDevice('dev_1', 'Decke', ['switch', 'dimmer', 'color_temperature'], {
        on: true,
        brightness: 100,
        colorTemperatureK: 2700,
      }),
    );
    assert.deepEqual(commands, [
      { type: 'setColorTemperature', kelvin: 2700 },
      { type: 'setBrightness', brightness: 100 },
      { type: 'setPower', on: true },
    ]);
  });

  it('sichert bei Rollläden Position und Lamellen, aber keinen Schaltbefehl', () => {
    const commands = commandsForState(
      makeDevice('dev_1', 'Rollladen', ['cover', 'cover.tilt'], {
        position: 65,
        tilt: 20,
        coverState: 'stopped',
      }),
    );
    assert.deepEqual(commands, [
      { type: 'setPosition', position: 65 },
      { type: 'setTilt', tilt: 20 },
    ]);
  });

  it('sichert bei Heizungen die Solltemperatur', () => {
    const commands = commandsForState(
      makeDevice('dev_1', 'Heizung', ['thermostat', 'sensor.temperature'], {
        targetTemperatureC: 21.5,
        temperatureC: 19.8,
      }),
    );
    assert.deepEqual(commands, [{ type: 'setTargetTemperature', targetTemperatureC: 21.5 }]);
  });

  it('lässt reine Sensoren weg', () => {
    const commands = commandsForState(
      makeDevice('dev_1', 'Fühler', ['sensor.temperature'], { temperatureC: 21 }),
    );
    assert.deepEqual(commands, []);
  });
});

// ---------------------------------------------------------------------------

describe('Szenen sichern und herstellen', () => {
  let dir: string;
  let repos: Repositories;
  let scenes: SceneService;
  let householdId = '';
  /** Merkt sich, was an die Geräte geschickt wurde. */
  const executed: Array<{ deviceId: string; command: { type: string } }> = [];

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-scenes-'));
    const db = new Database(path.join(dir, 'db.json'));
    await db.load();
    repos = createRepositories(db);
    const households = new HouseholdService(repos);
    const household = await households.create({ name: 'Szenen' });
    householdId = household.id;

    // Statt eines echten Geräte-Dienstes genügt hier ein Mitschnitt.
    const devices = {
      async execute(deviceId: string, command: { type: string }) {
        if (deviceId === 'dev_kaputt') throw new Error('Gerät antwortet nicht');
        executed.push({ deviceId, command });
        return repos.devices.get(deviceId);
      },
    };
    scenes = new SceneService(repos, devices as never);

    for (const device of [
      makeDevice('dev_lampe', 'Stehlampe', ['switch', 'dimmer'], { on: true, brightness: 30 }),
      makeDevice('dev_decke', 'Decke', ['switch'], { on: false }),
      makeDevice('dev_rollladen', 'Rollladen', ['cover'], { position: 40 }),
      makeDevice('dev_kaputt', 'Defekte Lampe', ['switch'], { on: true }),
    ]) {
      await repos.devices.insert({ ...device, householdId });
    }
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('sichert den jetzigen Zustand der gewählten Geräte', async () => {
    const scene = await scenes.create(householdId, {
      name: 'Fernsehabend',
      emoji: '📺',
      deviceIds: ['dev_lampe', 'dev_decke', 'dev_rollladen'],
    });

    assert.equal(scene.name, 'Fernsehabend');
    assert.equal(scene.entries.length, 3);

    const lampe = scene.entries.find((entry) => entry.deviceId === 'dev_lampe');
    assert.deepEqual(lampe?.commands, [
      { type: 'setBrightness', brightness: 30 },
      { type: 'setPower', on: true },
    ]);
  });

  it('lehnt eine Szene ohne Geräte ab', async () => {
    await assert.rejects(
      () => scenes.create(householdId, { name: 'Leer', deviceIds: [] }),
      /kein einziges Gerät/,
    );
  });

  it('lehnt einen doppelten Namen ab', async () => {
    await assert.rejects(
      () => scenes.create(householdId, { name: 'fernsehabend', deviceIds: ['dev_lampe'] }),
      /gibt es schon/,
    );
  });

  it('lehnt fremde Geräte ab', async () => {
    await assert.rejects(
      () => scenes.create(householdId, { name: 'Fremd', deviceIds: ['dev_woanders'] }),
      /gehört nicht zu diesem Haushalt/,
    );
  });

  it('stellt die Szene her und meldet, was ankam', async () => {
    executed.length = 0;
    const [scene] = scenes.list(householdId);
    assert.ok(scene);

    const result = await scenes.apply(scene.id);
    assert.equal(result.failed, 0);
    assert.equal(result.applied, 3);
    assert.equal(executed.length, 4, 'Lampe zwei Kommandos, Decke und Rollladen je eines');
    assert.equal(scenes.get(scene.id).lastAppliedAt !== null, true);
  });

  it('lässt ein stummes Gerät die anderen nicht aufhalten', async () => {
    const scene = await scenes.create(householdId, {
      name: 'Mit Defekt',
      deviceIds: ['dev_lampe', 'dev_kaputt'],
    });

    executed.length = 0;
    const result = await scenes.apply(scene.id);

    assert.equal(result.applied, 1);
    assert.equal(result.failed, 1);
    assert.match(
      result.results.find((entry) => entry.deviceId === 'dev_kaputt')?.error ?? '',
      /antwortet nicht/,
    );
    assert.ok(executed.some((entry) => entry.deviceId === 'dev_lampe'));
  });

  it('nimmt eine Szene mit dem neuen Zustand erneut auf', async () => {
    const [scene] = scenes.list(householdId);
    assert.ok(scene);

    await repos.devices.patchState('dev_lampe', { on: true, brightness: 95 }, true);
    const updated = await scenes.restamp(scene.id);

    const lampe = updated.entries.find((entry) => entry.deviceId === 'dev_lampe');
    assert.deepEqual(lampe?.commands[0], { type: 'setBrightness', brightness: 95 });
  });

  it('löscht eine Szene', async () => {
    const scene = await scenes.create(householdId, {
      name: 'Zum Wegwerfen',
      deviceIds: ['dev_lampe'],
    });
    await scenes.remove(scene.id);
    assert.throws(() => scenes.get(scene.id), /Szene/);
  });
});

// ---------------------------------------------------------------------------

describe('Urlaubsmodus prüfen und begrenzen', () => {
  const presence = (changes: Partial<typeof DEFAULT_PRESENCE>) =>
    normalizePresence({ ...DEFAULT_PRESENCE, ...changes } as typeof DEFAULT_PRESENCE);

  it('hält den Abstand in einem Bereich, in dem es nicht auffällt', () => {
    // Alle zwei Minuten wäre Geflacker, alle acht Stunden wäre nichts.
    assert.equal(presence({ averageIntervalMinutes: 2 }).averageIntervalMinutes, 10);
    assert.equal(presence({ averageIntervalMinutes: 500 }).averageIntervalMinutes, 120);
    assert.equal(presence({ averageIntervalMinutes: 25 }).averageIntervalMinutes, 25);
  });

  it('nimmt nur gültige Uhrzeiten', () => {
    assert.equal(presence({ from: '25:00' }).from, DEFAULT_PRESENCE.from);
    assert.equal(presence({ from: '06:30' }).from, '06:30');
  });

  it('entfernt doppelte Räume', () => {
    assert.deepEqual(presence({ roomIds: ['a', 'a', 'b'] }).roomIds, ['a', 'b']);
  });

  it('ist im Auslieferungszustand aus', () => {
    assert.equal(DEFAULT_PRESENCE.enabled, false);
  });
});

// ---------------------------------------------------------------------------
// Lichtvorschau (Front-End-Logik)
// ---------------------------------------------------------------------------

describe('Lichtvorschau', () => {
  it('leuchtet nur, wenn das Gerät an ist', async () => {
    const { lightFromDevice } = await import('../public/js/lightpreview.js');

    const on = lightFromDevice({ state: { on: true, hue: 200, saturation: 80, brightness: 100 } });
    assert.ok(on.color);
    assert.ok(on.strength > 0.9);

    // Eine ausgeschaltete Lampe leuchtet nicht – auch nicht schwach.
    const off = lightFromDevice({ state: { on: false, hue: 200, saturation: 80 } });
    assert.equal(off.color, null);
    assert.equal(off.strength, 0);
  });

  it('macht auch eine schwach gedimmte Lampe sichtbar', async () => {
    const { lightFromDevice } = await import('../public/js/lightpreview.js');
    // Bei 5 % wäre ein linearer Schein praktisch unsichtbar.
    const dim = lightFromDevice({ state: { on: true, hue: 40, saturation: 60, brightness: 5 } });
    assert.ok(dim.strength > 0.25, 'sichtbar, aber deutlich schwächer');
    assert.ok(dim.strength < 0.4);
  });

  it('nimmt bei Weißton-Lampen die Farbtemperatur', async () => {
    const { lightColor, kelvinToCss } = await import('../public/js/lightpreview.js');
    assert.equal(lightColor({ colorTemperatureK: 2700 }), kelvinToCss(2700));
    assert.equal(lightColor({ temperatureC: 21 }), null, 'ein Fühler ist keine Lampe');
  });

  it('bleibt bei warmem Licht warm und bei kaltem kühl', async () => {
    const { kelvinToCss } = await import('../public/js/lightpreview.js');
    const warm = /hsl\((\d+)/.exec(kelvinToCss(2200))?.[1];
    const cold = /hsl\((\d+)/.exec(kelvinToCss(6500))?.[1];
    assert.ok(Number(warm) < 60, 'Kerzenlicht liegt im gelb-orangen Bereich');
    assert.ok(Number(cold) > 150, 'Tageslicht liegt im bläulichen Bereich');
  });

  it('hält sich an die Grenzen der Farbtemperatur', async () => {
    const { kelvinToCss } = await import('../public/js/lightpreview.js');
    assert.equal(kelvinToCss(500), kelvinToCss(1800), 'darunter wird abgeschnitten');
    assert.equal(kelvinToCss(99999), kelvinToCss(6500));
  });
});
