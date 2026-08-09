import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Database } from '../src/storage/database.ts';
import { createRepositories } from '../src/storage/repositories.ts';
import { TelemetryStore, daysBetween, downsample } from '../src/storage/telemetryStore.ts';
import { enumerateHosts, isIPv4, isPrivateIPv4 } from '../src/util/net.ts';
import { nowIso } from '../src/util/id.ts';
import type { Household } from '../src/core/types.ts';
import { DEFAULT_APPEARANCE, DEFAULT_PRESENCE } from '../src/core/types.ts';

let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'smarthome-test-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const household = (id: string): Household => ({
  id,
  name: 'Testhaushalt',
  timezone: 'Europe/Berlin',
  locale: 'de-DE',
  setupStep: 'integrations',
  setupCompletedAt: null,
  pollIntervalSeconds: 15,
  pricePerKwh: 0.35,
  currency: 'EUR',
  basePricePerMonth: 0,
  autoUpdate: false,
  autoUpdateFrom: '03:00',
  autoUpdateTo: '05:00',
  appearance: { ...DEFAULT_APPEARANCE },
  presence: { ...DEFAULT_PRESENCE },
  createdAt: nowIso(),
  updatedAt: nowIso(),
});

describe('JSON-Datenbank', () => {
  it('legt eine leere Datenbank an und lädt sie erneut', async () => {
    const file = path.join(dir, 'db1.json');
    const db = new Database(file);
    await db.load();
    assert.deepEqual(db.read().households, []);

    await db.update((data) => {
      data.households.push(household('hh_1'));
    });

    const reloaded = new Database(file);
    await reloaded.load();
    assert.equal(reloaded.read().households.length, 1);
    assert.equal(reloaded.read().households[0]?.name, 'Testhaushalt');
  });

  it('serialisiert parallele Schreibzugriffe', async () => {
    const db = new Database(path.join(dir, 'db2.json'));
    await db.load();

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        db.update((data) => {
          data.rooms.push({
            id: `room_${index}`,
            householdId: 'hh_1',
            name: `Raum ${index}`,
            icon: 'room',
            targetTemperatureC: null,
            sortOrder: index,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          });
        }),
      ),
    );

    assert.equal(db.read().rooms.length, 25);
    const reloaded = new Database(path.join(dir, 'db2.json'));
    await reloaded.load();
    assert.equal(reloaded.read().rooms.length, 25, 'kein Schreibvorgang darf verloren gehen');
  });

  it('weist eine Datenbank aus einer neueren Version ab', async () => {
    const file = path.join(dir, 'db3.json');
    await writeFile(file, JSON.stringify({ version: 99, households: [] }), 'utf8');
    const db = new Database(file);
    await assert.rejects(() => db.load(), /neueren Version/);
  });

  it('meldet defekte Dateien verständlich', async () => {
    const file = path.join(dir, 'db4.json');
    await writeFile(file, '{kein json', 'utf8');
    const db = new Database(file);
    await assert.rejects(() => db.load(), /konnte nicht gelesen werden/);
  });
});

describe('Repositories', () => {
  it('findet, ändert und löscht Einträge', async () => {
    const db = new Database(path.join(dir, 'db5.json'));
    await db.load();
    const repos = createRepositories(db);

    await repos.households.insert(household('hh_2'));
    assert.equal(repos.households.current()?.id, 'hh_2');

    await repos.rooms.insert({
      id: 'room_a',
      householdId: 'hh_2',
      name: 'Bad',
      icon: 'room',
      targetTemperatureC: 22,
      sortOrder: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });

    assert.equal(repos.rooms.findByName('hh_2', 'bad')?.id, 'room_a');
    assert.equal(repos.rooms.findByName('hh_2', 'Küche'), undefined);

    const updated = await repos.rooms.patch('room_a', { name: 'Badezimmer' }, 'Raum');
    assert.equal(updated.name, 'Badezimmer');
    assert.notEqual(updated.updatedAt, undefined);

    assert.equal(await repos.rooms.remove('room_a'), true);
    assert.equal(await repos.rooms.remove('room_a'), false);
  });

  it('wirft einen sprechenden Fehler für unbekannte IDs', async () => {
    const db = new Database(path.join(dir, 'db6.json'));
    await db.load();
    const repos = createRepositories(db);
    assert.throws(() => repos.devices.get('dev_missing', 'Gerät'), /Gerät dev_missing/);
    assert.throws(() => repos.households.require(), /Haushalt/);
  });
});

describe('Messwert-Ablage', () => {
  it('schreibt und liest Messwerte tagesweise', async () => {
    const store = new TelemetryStore(path.join(dir, 'telemetry'), 30);
    await store.init();

    const base = new Date('2026-08-07T10:00:00Z');
    for (let i = 0; i < 10; i++) {
      store.add({
        t: new Date(base.getTime() + i * 60_000).toISOString(),
        deviceId: 'dev_1',
        metric: 'temperatureC',
        value: 20 + i * 0.1,
      });
    }
    await store.flush();

    const samples = await store.query({
      deviceId: 'dev_1',
      metric: 'temperatureC',
      from: new Date('2026-08-07T00:00:00Z'),
      to: new Date('2026-08-08T00:00:00Z'),
    });
    assert.equal(samples.length, 10);
    assert.equal(samples[0]?.value, 20);
  });

  it('filtert nach Gerät und Messgröße', async () => {
    const store = new TelemetryStore(path.join(dir, 'telemetry2'), 30);
    await store.init();
    const t = '2026-08-07T10:00:00.000Z';
    store.add({ t, deviceId: 'a', metric: 'temperatureC', value: 21 });
    store.add({ t, deviceId: 'b', metric: 'temperatureC', value: 22 });
    store.add({ t, deviceId: 'a', metric: 'humidity', value: 50 });
    await store.flush();

    const range = { from: new Date('2026-08-07T00:00:00Z'), to: new Date('2026-08-08T00:00:00Z') };
    assert.equal((await store.query({ ...range, deviceId: 'a' })).length, 2);
    assert.equal((await store.query({ ...range, metric: 'humidity' })).length, 1);
  });

  it('berechnet Min/Max/Mittelwert', async () => {
    const store = new TelemetryStore(path.join(dir, 'telemetry3'), 30);
    await store.init();
    for (const value of [18, 20, 22]) {
      store.add({ t: '2026-08-07T10:00:00.000Z', deviceId: 'a', metric: 'temperatureC', value });
    }
    await store.flush();

    const [aggregate] = await store.aggregate({
      deviceId: 'a',
      from: new Date('2026-08-07T00:00:00Z'),
      to: new Date('2026-08-08T00:00:00Z'),
    });
    assert.equal(aggregate?.min, 18);
    assert.equal(aggregate?.max, 22);
    assert.equal(aggregate?.avg, 20);
    assert.equal(aggregate?.count, 3);
  });

  it('überspringt abgeschnittene Zeilen statt zu scheitern', async () => {
    const directory = path.join(dir, 'telemetry4');
    const store = new TelemetryStore(directory, 30);
    await store.init();
    store.add({ t: '2026-08-07T10:00:00.000Z', deviceId: 'a', metric: 'temperatureC', value: 21 });
    await store.flush();
    await writeFile(path.join(directory, '2026-08-07.jsonl'), '{"t":"kaputt"\n', { flag: 'a' });

    const samples = await store.query({
      from: new Date('2026-08-07T00:00:00Z'),
      to: new Date('2026-08-08T00:00:00Z'),
    });
    assert.equal(samples.length, 1);
  });
});

describe('Hilfsfunktionen der Ablage', () => {
  it('zählt Tage inklusive Grenzen auf', () => {
    const days = daysBetween(new Date('2026-08-05T22:00:00Z'), new Date('2026-08-07T02:00:00Z'));
    assert.deepEqual(days, ['2026-08-05', '2026-08-06', '2026-08-07']);
  });

  it('dünnt lange Reihen gleichmäßig aus und behält den letzten Punkt', () => {
    const items = Array.from({ length: 1000 }, (_, index) => index);
    const reduced = downsample(items, 100);
    assert.equal(reduced.length, 100);
    assert.equal(reduced[0], 0);
    assert.equal(reduced[reduced.length - 1], 999);
    assert.deepEqual(downsample([1, 2, 3], 10), [1, 2, 3]);
  });
});

describe('Netzwerk-Hilfsfunktionen', () => {
  it('zählt die Hosts eines /24 auf', () => {
    const hosts = enumerateHosts({
      interfaceName: 'eth0',
      address: '192.168.1.10',
      netmask: '255.255.255.0',
      cidr: 24,
      hostCount: 254,
    });
    assert.equal(hosts.length, 253, 'ohne die eigene Adresse');
    assert.ok(hosts.includes('192.168.1.1'));
    assert.ok(hosts.includes('192.168.1.254'));
    assert.ok(!hosts.includes('192.168.1.10'));
    assert.ok(!hosts.includes('192.168.1.0'));
    assert.ok(!hosts.includes('192.168.1.255'));
  });

  it('begrenzt zu große Netze auf das umgebende /24', () => {
    const hosts = enumerateHosts({
      interfaceName: 'eth0',
      address: '10.0.5.7',
      netmask: '255.255.0.0',
      cidr: 16,
      hostCount: 65534,
    });
    assert.equal(hosts.length, 253);
    assert.ok(hosts.every((host) => host.startsWith('10.0.5.')));
  });

  it('erkennt private Adressen', () => {
    assert.equal(isPrivateIPv4('192.168.1.5'), true);
    assert.equal(isPrivateIPv4('10.1.2.3'), true);
    assert.equal(isPrivateIPv4('172.16.0.1'), true);
    assert.equal(isPrivateIPv4('8.8.8.8'), false);
    assert.equal(isIPv4('nicht.eine.ip'), false);
    assert.equal(isIPv4('192.168.1.1'), true);
  });
});
