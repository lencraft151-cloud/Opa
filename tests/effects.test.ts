/**
 * Lichteffekte: Disco, Farbwechsel, Gruselmodus, Kerze, Gewitter.
 *
 * Die Schrittberechnung ist rein und lässt sich deshalb ohne eine einzige
 * Lampe prüfen. Der Dienst selbst bekommt einen Gerätedienst vorgesetzt, der
 * die Befehle nur mitschreibt – so ist auch nachweisbar, was am Ende eines
 * Effekts tatsächlich zurückgestellt wird.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setLogLevel } from '../src/core/logger.ts';
import { events } from '../src/core/events.ts';
import { ActivityService } from '../src/services/activityService.ts';
import { AutomationService } from '../src/services/automationService.ts';
import { commandsFor, EffectService, EFFECTS, pseudoRandom } from '../src/services/effectService.ts';
import { DeviceService } from '../src/services/deviceService.ts';
import { HouseholdService } from '../src/services/householdService.ts';
import { IntegrationService } from '../src/services/integrationService.ts';
import { RoomService } from '../src/services/roomService.ts';
import { TelemetryService } from '../src/services/telemetryService.ts';
import { createAdapterRegistry } from '../src/adapters/registry.ts';
import { Database } from '../src/storage/database.ts';
import { createRepositories } from '../src/storage/repositories.ts';
import type { Repositories } from '../src/storage/repositories.ts';
import { TelemetryStore } from '../src/storage/telemetryStore.ts';
import type { AppConfig } from '../src/config.ts';
import type { Capability, Device, DeviceCommand, DeviceState } from '../src/core/types.ts';
import { nowIso } from '../src/util/id.ts';

setLogLevel('silent');

function makeDevice(
  id: string,
  name: string,
  capabilities: Capability[],
  state: DeviceState = {},
  roomId: string | null = null,
): Device {
  return {
    id,
    householdId: 'hh_1',
    integrationId: 'int_1',
    roomId,
    externalId: id,
    vendor: 'hue',
    name,
    manufacturer: null,
    model: null,
    firmware: null,
    capabilities,
    capabilityOverride: null,
    state,
    reachable: true,
    hidden: false,
    favorite: false,
    lastSeenAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

/** Ein Gerätedienst, der nichts tut außer mitschreiben. */
function recordingDevices(): {
  service: DeviceService;
  log: Array<{ deviceId: string; command: DeviceCommand }>;
} {
  const log: Array<{ deviceId: string; command: DeviceCommand }> = [];
  const service = {
    execute: async (deviceId: string, command: DeviceCommand) => {
      log.push({ deviceId, command });
      return undefined;
    },
  } as unknown as DeviceService;
  return { service, log };
}

function fakeRepos(devices: Device[]): Repositories {
  return {
    devices: { listByHousehold: () => devices },
  } as unknown as Repositories;
}

/** Lässt die angestoßenen, aber nicht abgewarteten Schritte durchlaufen. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

// ---------------------------------------------------------------------------
// Die Schrittberechnung
// ---------------------------------------------------------------------------

describe('Was ein Effekt je Schritt schickt', () => {
  it('dreht die Disco um den goldenen Winkel weiter', () => {
    const hueAt = (step: number, index = 0): number => {
      const command = commandsFor('disco', step, index).find((entry) => entry.type === 'setColor');
      assert.ok(command && command.type === 'setColor');
      return command.hue;
    };

    assert.equal(hueAt(0), 0);
    assert.equal(hueAt(1), 138, '137,5° gerundet');
    assert.equal(hueAt(2), 275);
    // Nach dem Umlauf beginnt es wieder vorn, aber nicht bei derselben Farbe.
    assert.notEqual(hueAt(3), hueAt(0));
  });

  it('gibt zwei Lampen zur selben Zeit verschiedene Farben', () => {
    const hues = [0, 1, 2, 3].map((index) => {
      const command = commandsFor('disco', 7, index).find((entry) => entry.type === 'setColor');
      assert.ok(command && command.type === 'setColor');
      return command.hue;
    });
    assert.equal(new Set(hues).size, 4, 'sonst blinkt die ganze Wohnung im Gleichschritt');
  });

  it('lässt die Disco zwischen hell und halbhell springen', () => {
    const brightness = (step: number): number => {
      const command = commandsFor('disco', step, 0).find(
        (entry) => entry.type === 'setBrightness',
      );
      assert.ok(command && command.type === 'setBrightness');
      return command.brightness;
    };
    assert.equal(brightness(0), 100);
    assert.equal(brightness(1), 55);
  });

  it('wandert beim Farbwechsel in kleinen Schritten', () => {
    const hue = (step: number): number => {
      const command = commandsFor('farbwechsel', step, 0).find(
        (entry) => entry.type === 'setColor',
      );
      assert.ok(command && command.type === 'setColor');
      return command.hue;
    };
    assert.equal(hue(1) - hue(0), 12, 'ruhig, nicht hektisch');
  });

  it('hält den Gruselmodus meistens düster', () => {
    const werte = Array.from({ length: 200 }, (_, step) => {
      const command = commandsFor('gruselig', step, 0).find(
        (entry) => entry.type === 'setBrightness',
      );
      assert.ok(command && command.type === 'setBrightness');
      return command.brightness;
    });
    const hell = werte.filter((value) => value > 50).length;
    assert.ok(hell > 0, 'ganz ohne Zucken wäre es nur dunkel');
    assert.ok(hell < werte.length / 3, `zu oft hell: ${hell} von ${werte.length}`);
    assert.ok(Math.max(...werte) <= 70);
  });

  it('bleibt bei der Kerze im warmen Bereich', () => {
    for (let step = 0; step < 50; step++) {
      const command = commandsFor('kerze', step, 0).find(
        (entry) => entry.type === 'setColorTemperature',
      );
      assert.ok(command && command.type === 'setColorTemperature');
      assert.ok(command.kelvin >= 2000 && command.kelvin <= 2200, String(command.kelvin));
    }
  });

  it('lässt das Gewitter selten und dafür heftig blitzen', () => {
    const helligkeiten = Array.from({ length: 300 }, (_, step) => {
      const command = commandsFor('gewitter', step, 0).find(
        (entry) => entry.type === 'setBrightness',
      );
      assert.ok(command && command.type === 'setBrightness');
      return command.brightness;
    });
    const blitze = helligkeiten.filter((value) => value === 100).length;
    assert.ok(blitze > 0, 'ein Gewitter ohne Blitz ist keins');
    assert.ok(blitze < helligkeiten.length / 5, `zu viele Blitze: ${blitze}`);
    assert.equal(helligkeiten.filter((value) => value === 3).length > 200, true, 'dazwischen dunkel');
  });

  it('schaltet die Lampe ein, bevor sie etwas anzeigen soll', () => {
    for (const effect of ['disco', 'farbwechsel', 'gruselig', 'kerze'] as const) {
      const first = commandsFor(effect, 0, 0)[0];
      assert.deepEqual(first, { type: 'setPower', on: true }, effect);
    }
  });

  it('liefert für einen unbekannten Effekt nichts', () => {
    assert.deepEqual(commandsFor('gibtesnicht' as never, 0, 0), []);
  });
});

describe('Berechenbarer Zufall', () => {
  it('bleibt zwischen 0 und 1', () => {
    for (let step = 0; step < 500; step++) {
      const value = pseudoRandom(step, step % 7);
      assert.ok(value >= 0 && value < 1, String(value));
    }
  });

  it('liefert bei gleicher Eingabe immer dasselbe', () => {
    assert.equal(pseudoRandom(42, 3), pseudoRandom(42, 3));
    assert.notEqual(pseudoRandom(42, 3), pseudoRandom(43, 3));
    assert.notEqual(pseudoRandom(42, 3), pseudoRandom(42, 4));
  });
});

// ---------------------------------------------------------------------------
// Der Dienst
// ---------------------------------------------------------------------------

describe('Effekte starten und beenden', () => {
  const lampen = (): Device[] => [
    makeDevice('dev_farbe', 'Stehlampe', ['switch', 'dimmer', 'color'], {
      on: true,
      brightness: 42,
      hue: 30,
      saturation: 60,
    }),
    makeDevice(
      'dev_weiss',
      'Deckenlampe',
      ['switch', 'dimmer', 'color_temperature'],
      { on: false, brightness: 80, colorTemperatureK: 2700 },
      'room_1',
    ),
    makeDevice('dev_steckdose', 'Steckdose', ['switch'], { on: true }),
  ];

  it('nimmt nur Lampen, die den Effekt zeigen können', async () => {
    const { service, log } = recordingDevices();
    const effects = new EffectService(fakeRepos(lampen()), service);

    const running = await effects.start('hh_1', 'disco');
    await settle();

    assert.deepEqual(running.deviceIds, ['dev_farbe'], 'nur die Farblampe kann Disco');
    assert.ok(log.every((entry) => entry.deviceId === 'dev_farbe'));
    await effects.shutdown();
  });

  it('erklärt verständlich, wenn keine Lampe infrage kommt', async () => {
    const { service } = recordingDevices();
    const effects = new EffectService(
      fakeRepos([makeDevice('dev_steckdose', 'Steckdose', ['switch'])]),
      service,
    );

    await assert.rejects(() => effects.start('hh_1', 'disco'), /mindestens eine Lampe/);
    await effects.shutdown();
  });

  it('beschränkt sich auf die genannten Geräte und Räume', async () => {
    const { service } = recordingDevices();
    const effects = new EffectService(fakeRepos(lampen()), service);

    const nachRaum = await effects.start('hh_1', 'kerze', { roomIds: ['room_1'] });
    assert.deepEqual(nachRaum.deviceIds, ['dev_weiss']);

    const nachGerät = await effects.start('hh_1', 'kerze', { deviceIds: ['dev_farbe'] });
    assert.deepEqual(nachGerät.deviceIds, ['dev_farbe']);
    await effects.shutdown();
  });

  it('streckt den Takt, wenn viele Lampen mitmachen', async () => {
    const viele = Array.from({ length: 30 }, (_, index) =>
      makeDevice(`dev_${index}`, `Lampe ${index}`, ['switch', 'dimmer', 'color'], { on: true }),
    );
    const { service } = recordingDevices();
    const effects = new EffectService(fakeRepos(viele), service);

    const running = await effects.start('hh_1', 'disco');
    // 30 Lampen mal drei Befehle je Schritt, bei höchstens 10 Befehlen je
    // Sekunde: neun Sekunden. Langsam – aber angekommen ist besser als schnell
    // und verworfen.
    assert.equal(running.stepMs, 9000);
    assert.ok(running.stepMs > EFFECTS.disco.stepMs, 'der Wunschtakt wäre zu schnell');
    await effects.shutdown();
  });

  it('rechnet den Takt aus den Befehlen, nicht aus den Lampen', async () => {
    const zwei = [0, 1].map((index) =>
      makeDevice(`dev_${index}`, `Lampe ${index}`, ['switch', 'dimmer', 'color'], { on: true }),
    );
    const { service } = recordingDevices();
    const effects = new EffectService(fakeRepos(zwei), service);

    // Zwei Lampen wären nach Lampenzahl 200 ms – die Disco schickt aber drei
    // Befehle je Lampe und Schritt, macht sechs: 600 ms.
    const running = await effects.start('hh_1', 'disco');
    assert.equal(running.stepMs, 600);

    // Der Farbwechsel kommt mit zwei Befehlen aus und bleibt beim Wunschtakt.
    const ruhig = await effects.start('hh_1', 'farbwechsel');
    assert.equal(ruhig.stepMs, EFFECTS.farbwechsel.stepMs);
    await effects.shutdown();
  });

  it('begrenzt die Laufzeit auf zwei Stunden', async () => {
    const { service } = recordingDevices();
    const effects = new EffectService(fakeRepos(lampen()), service);

    const running = await effects.start('hh_1', 'farbwechsel', { minutes: 9999 });
    const dauer = new Date(running.endsAt).getTime() - new Date(running.startedAt).getTime();
    assert.equal(dauer, 120 * 60_000);
    await effects.shutdown();
  });

  it('stellt beim Beenden her, wie das Licht vorher war', async () => {
    const { service, log } = recordingDevices();
    const effects = new EffectService(fakeRepos(lampen()), service);

    await effects.start('hh_1', 'disco');
    await settle();
    log.length = 0;

    assert.equal(await effects.stop('disco'), 1);
    assert.deepEqual(
      log.map((entry) => entry.command),
      [
        { type: 'setColor', hue: 30, saturation: 60 },
        { type: 'setBrightness', brightness: 42 },
        { type: 'setPower', on: true },
      ],
      'erst die Farbe, dann die Helligkeit, zuletzt der Schalter',
    );
  });

  it('lässt eine Lampe aus, die vorher aus war', async () => {
    const { service, log } = recordingDevices();
    const effects = new EffectService(fakeRepos(lampen()), service);

    await effects.start('hh_1', 'kerze', { deviceIds: ['dev_weiss'] });
    await settle();
    log.length = 0;
    await effects.stop('kerze');

    const schalter = log.filter((entry) => entry.command.type === 'setPower');
    assert.equal(schalter.length, 1);
    assert.deepEqual(schalter[0]?.command, { type: 'setPower', on: false });
  });

  it('startet einen laufenden Effekt sauber neu statt doppelt', async () => {
    const { service } = recordingDevices();
    const effects = new EffectService(fakeRepos(lampen()), service);

    await effects.start('hh_1', 'disco');
    await effects.start('hh_1', 'disco');
    assert.equal(effects.overview('hh_1').running.length, 1);
    await effects.shutdown();
  });

  it('löst einen Effekt ab, der dieselbe Lampe bespielt', async () => {
    const { service } = recordingDevices();
    const effects = new EffectService(fakeRepos(lampen()), service);

    /*
     * Beim Nachmessen an einem echten Gerät liefen einmal Gruselmodus und
     * Sonnenaufgang zugleich auf derselben Lampe – heraus kam ein Zucken
     * zwischen grün und orange, das zu keinem von beiden gehörte.
     */
    await effects.start('hh_1', 'gruselig', { deviceIds: ['dev_farbe'] });
    assert.equal(effects.isRunning('gruselig'), true);

    await effects.start('hh_1', 'sonnenaufgang', { deviceIds: ['dev_farbe'] });
    assert.equal(effects.isRunning('gruselig'), false, 'der ältere gibt die Lampe frei');
    assert.equal(effects.isRunning('sonnenaufgang'), true);
    await effects.shutdown();
  });

  it('lässt Effekte auf verschiedenen Lampen in Ruhe nebeneinander laufen', async () => {
    const { service } = recordingDevices();
    const effects = new EffectService(fakeRepos(lampen()), service);

    await effects.start('hh_1', 'gruselig', { deviceIds: ['dev_farbe'] });
    await effects.start('hh_1', 'kerze', { deviceIds: ['dev_weiss'] });
    assert.equal(effects.overview('hh_1').running.length, 2, 'sie stören sich nicht');
    await effects.shutdown();
  });

  it('lässt mehrere verschiedene Effekte nebeneinander laufen', async () => {
    const { service } = recordingDevices();
    const effects = new EffectService(fakeRepos(lampen()), service);

    await effects.start('hh_1', 'disco', { deviceIds: ['dev_farbe'] });
    await effects.start('hh_1', 'kerze', { deviceIds: ['dev_weiss'] });

    const overview = effects.overview('hh_1');
    assert.equal(overview.running.length, 2);
    assert.equal(overview.candidates, 2, 'zwei dimmbare Lampen im Haushalt');
    assert.equal(overview.effects.length, Object.keys(EFFECTS).length);

    // Der Panikknopf nimmt alles mit.
    assert.equal(await effects.stop(), 2);
    assert.equal(effects.overview('hh_1').running.length, 0);
  });

  it('lässt einen abgebrochenen Verlauf stehen, wo er ist', async () => {
    const { service, log } = recordingDevices();
    const effects = new EffectService(fakeRepos(lampen()), service);

    await effects.start('hh_1', 'sonnenaufgang', { deviceIds: ['dev_weiss'], minutes: 30 });
    await settle();
    log.length = 0;

    // Von Hand beendet: Der Sonnenaufgang darf nicht auf volle Helligkeit
    // springen, nur weil das sein Ziel gewesen wäre.
    await effects.stop('sonnenaufgang');
    assert.deepEqual(log, [], 'kein einziger Befehl nach dem Abbruch');
  });

  it('stellt nach einem Verlauf nichts wieder her', async () => {
    const { service, log } = recordingDevices();
    const effects = new EffectService(fakeRepos(lampen()), service);

    await effects.start('hh_1', 'einschlafen', { deviceIds: ['dev_farbe'], minutes: 1 });
    await settle();
    log.length = 0;
    await effects.stop('einschlafen');

    // Die Lampe war vorher an – ein wiederhergestellter Zustand wäre hier
    // genau das, was niemand will.
    assert.equal(
      log.some((entry) => entry.command.type === 'setPower' && entry.command.on),
      false,
      'nichts darf wieder angehen',
    );
  });

  it('meldet beteiligte Lampen als vom Effekt gesteuert', async () => {
    const { service } = recordingDevices();
    const effects = new EffectService(fakeRepos(lampen()), service);

    assert.equal(effects.controls('dev_farbe'), false);
    await effects.start('hh_1', 'disco');
    assert.equal(effects.controls('dev_farbe'), true);
    assert.equal(effects.controls('dev_steckdose'), false, 'die Steckdose macht nicht mit');

    // Nach dem Beenden noch eine Weile: Das Aufräumen schaltet selbst.
    await effects.stop('disco');
    assert.equal(effects.controls('dev_farbe'), true);
  });
});

// ---------------------------------------------------------------------------
// Zusammenspiel mit den Automationen
// ---------------------------------------------------------------------------

describe('Effekte als Aktion einer Regel', () => {
  let dir: string;
  let repos: Repositories;
  let automations: AutomationService;
  let effects: EffectService;
  let householdId = '';
  const log: Array<{ deviceId: string; command: DeviceCommand }> = [];
  /* Statt echter Lampen ein Mitschrieb – geprüft wird die Regel, nicht die Bridge. */
  const recorder = {
    execute: async (deviceId: string, command: DeviceCommand) => {
      log.push({ deviceId, command });
      return undefined;
    },
  } as unknown as DeviceService;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-effects-'));
    const db = new Database(path.join(dir, 'db.json'));
    await db.load();
    repos = createRepositories(db);
    const households = new HouseholdService(repos);
    const rooms = new RoomService(repos);
    const store = new TelemetryStore(path.join(dir, 'telemetry'), 7);
    await store.init();
    const telemetry = new TelemetryService(store, { minIntervalSeconds: 0, retentionDays: 7 });
    const registry = createAdapterRegistry();
    const config = { secretKey: 'test' } as AppConfig;
    const integrations = new IntegrationService(repos, registry, rooms, telemetry, config);
    const devices = new DeviceService(repos, registry, integrations, telemetry);

    automations = new AutomationService(repos, devices, households);
    effects = new EffectService(repos, recorder);
    automations.useEffects(effects);

    const household = await households.create({ name: 'Effekte' });
    householdId = household.id;
    await repos.devices.insert({
      ...makeDevice('dev_lampe', 'Wohnzimmerlampe', ['switch', 'dimmer', 'color'], {
        on: true,
        brightness: 70,
      }),
      householdId,
    });
    // Eine zweite Lampe für die Endlosschleifen-Prüfung ganz unten: Dort darf
    // nur genau eine Regel zusehen, sonst ist nicht zu unterscheiden, welche
    // von beiden gegriffen hat.
    await repos.devices.insert({
      ...makeDevice('dev_flur', 'Flurlampe', ['switch', 'dimmer', 'color'], {
        on: true,
        brightness: 50,
      }),
      householdId,
    });
  });

  after(async () => {
    automations.stop();
    await effects.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it('legt aus der Vorlage eine Regel mit Effekt an', async () => {
    const rule = await automations.createFromTemplate(householdId, 'effect-when-off', {});
    assert.equal(rule.name, 'Gruselig, wenn das Licht ausgeht');
    assert.deepEqual(rule.trigger, {
      type: 'deviceState',
      deviceId: 'dev_lampe',
      property: 'on',
      equals: false,
    });
    assert.deepEqual(rule.actions, [
      {
        type: 'effect',
        effect: 'gruselig',
        target: { deviceIds: ['dev_lampe'] },
        minutes: 20,
      },
    ]);
  });

  it('kennt auch den umgekehrten Weg', async () => {
    const rule = await automations.createFromTemplate(householdId, 'effect-when-on', {
      effect: 'disco',
    });
    assert.equal((rule.trigger as { equals: boolean }).equals, true);
    assert.equal((rule.actions[0] as { effect: string }).effect, 'disco');
  });

  it('legt Wecklicht und Einschlaflicht aus Vorlagen an', async () => {
    const wecken = await automations.createFromTemplate(householdId, 'wake-light', {});
    assert.equal(wecken.name, 'Wecklicht');
    // Die Uhrzeit ist der Beginn: 06:40 plus 20 Minuten sind 7 Uhr.
    assert.deepEqual(wecken.trigger, { type: 'schedule', at: '06:40', days: [1, 2, 3, 4, 5] });
    assert.deepEqual(wecken.actions[0], {
      type: 'effect',
      effect: 'sonnenaufgang',
      target: { deviceIds: ['dev_lampe'] },
      minutes: 20,
    });

    const schlafen = await automations.createFromTemplate(householdId, 'sleep-light', {});
    assert.equal((schlafen.actions[0] as { effect: string }).effect, 'einschlafen');
    assert.equal((schlafen.trigger as { at: string }).at, '22:30');
  });

  it('weist einen erfundenen Effekt ab', async () => {
    await assert.rejects(
      () => automations.createFromTemplate(householdId, 'effect-when-off', { effect: 'techno' }),
      /kein bekannter Lichteffekt/,
    );
  });

  it('startet den Effekt, wenn die Regel läuft', async () => {
    const rule = await automations.createFromTemplate(householdId, 'effect-at-time', {
      effect: 'kerze',
      minutes: 5,
    });
    await automations.run(rule.id);
    await settle();

    assert.equal(effects.isRunning('kerze'), true);
    assert.ok(log.some((entry) => entry.deviceId === 'dev_lampe'));
    await effects.stop('kerze');
  });

  it('beendet Effekte über eine Regel', async () => {
    await effects.start(householdId, 'disco');
    const rule = await automations.createFromTemplate(householdId, 'effect-stop-when-on', {});
    await automations.run(rule.id);

    assert.equal(effects.isRunning('disco'), false);
  });

  /*
   * Der eigentliche Fallstrick: Der Effekt schaltet die Lampe selbst, und am
   * Ende stellt er sie zurück auf „aus". Ohne Sperre löste die Regel dadurch
   * ihr eigenes Ende erneut aus – und die Wohnung flackerte bis zum Morgen.
   */
  it('löst nicht durch den eigenen Effekt erneut aus', async () => {
    /*
     * Ein frischer Effektdienst: Aus den Prüfungen davor läuft für diese
     * Lampe noch die Nachlauffrist, und die Regel bliebe schon deshalb still
     * – hier soll sie aber erst einmal greifen dürfen.
     */
    await effects.shutdown();
    effects = new EffectService(repos, recorder);
    automations.useEffects(effects);

    const rule = await automations.createFromTemplate(householdId, 'effect-when-off', {
      watch: 'dev_flur',
      lights: ['dev_flur'],
      minutes: 5,
    });
    /*
     * Ohne Sperrzeit, weil sie die Schleife nur verlangsamen, nicht verhindern
     * würde: Nach einer Minute stünde derselbe Zustand noch an, und die Regel
     * holte den zweiten Start nach. Geprüft wird die Sperre, nicht die Pause.
     */
    await automations.update(rule.id, { cooldownSeconds: 0 });
    automations.start(householdId);

    const schalten = async (on: boolean): Promise<void> => {
      const device = await repos.devices.patch(
        'dev_flur',
        { state: { on }, updatedAt: nowIso() },
        'Gerät',
      );
      events.emit('device.updated', { device, changed: ['on'] });
      await settle();
    };

    // 1. Jemand schaltet das Licht aus – die Regel greift, der Effekt läuft.
    await schalten(false);
    assert.equal(effects.isRunning('gruselig'), true, 'einmal soll die Regel greifen');
    const nachErstemMal = automations.get(rule.id).lastTriggeredAt;
    assert.ok(nachErstemMal);

    // 2. Der Effekt schaltet die Lampe selbst ein – das meldet der Hub.
    await schalten(true);

    // 3. Der Effekt endet und stellt „aus" wieder her: dieselbe Meldung wie
    //    unter 1. Genau hier fing die Wohnung früher an, endlos zu flackern.
    await effects.stop('gruselig');
    await schalten(false);
    // 4. Und noch einmal, wie es die Abfrage alle 15 Sekunden meldet.
    await schalten(false);

    assert.equal(effects.isRunning('gruselig'), false, 'kein zweiter Start');
    assert.equal(automations.get(rule.id).lastTriggeredAt, nachErstemMal);
  });
});

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

describe('Der Verlauf schreibt das Blinken nicht mit', () => {
  let dir: string;
  let activity: ActivityService;
  let effects: EffectService;
  let householdId = '';

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-effect-log-'));
    const db = new Database(path.join(dir, 'db.json'));
    await db.load();
    const repos = createRepositories(db);
    const households = new HouseholdService(repos);
    const household = await households.create({ name: 'Verlauf' });
    householdId = household.id;

    await repos.devices.insert({
      ...makeDevice('dev_disco', 'Discolampe', ['switch', 'dimmer', 'color'], { on: true }),
      householdId,
    });

    const { service } = recordingDevices();
    effects = new EffectService(repos, service);
    activity = new ActivityService(repos);
    activity.useEffects(effects);
    activity.start(householdId);
  });

  after(async () => {
    activity.stop();
    await effects.shutdown();
    await rm(dir, { recursive: true, force: true });
  });

  it('vermerkt gewöhnliches Schalten', () => {
    const device = { ...makeDevice('dev_disco', 'Discolampe', ['switch'], { on: false }), householdId };
    events.emit('device.updated', { device, changed: ['on'] });
    assert.equal(activity.list(householdId, { deviceId: 'dev_disco' }).length, 1);
  });

  it('schweigt, solange ein Effekt an derselben Lampe läuft', async () => {
    await effects.start(householdId, 'disco');
    const vorher = activity.list(householdId, { deviceId: 'dev_disco' }).length;

    // Zwanzig Schaltvorgänge, wie sie eine Disco in zehn Sekunden erzeugt.
    for (let i = 0; i < 20; i++) {
      const device = {
        ...makeDevice('dev_disco', 'Discolampe', ['switch'], { on: i % 2 === 0 }),
        householdId,
      };
      events.emit('device.updated', { device, changed: ['on'] });
    }

    assert.equal(
      activity.list(householdId, { deviceId: 'dev_disco' }).length,
      vorher,
      'sonst verdrängt eine Disco den ganzen übrigen Verlauf',
    );
    await effects.stop('disco');
  });
});
