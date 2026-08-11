/**
 * Der Verlauf.
 *
 * Die schwierige Frage ist nicht, wie man Ereignisse aufschreibt, sondern
 * welche. Ein Hub mit dreißig Geräten meldet alle fünfzehn Sekunden neue
 * Messwerte; stünde jeder davon im Verlauf, wäre er nach einer Stunde
 * unlesbar und die Datenbank vollgeschrieben.
 *
 * Geprüft wird deshalb vor allem, was *nicht* hineinkommt.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { events } from '../src/core/events.ts';
import { setLogLevel } from '../src/core/logger.ts';
import type { Device, Integration } from '../src/core/types.ts';
import { ActivityService } from '../src/services/activityService.ts';
import { Database } from '../src/storage/database.ts';
import { createRepositories, type Repositories } from '../src/storage/repositories.ts';
import { nowIso } from '../src/util/id.ts';

setLogLevel('silent');

const device = (over: Partial<Device> = {}): Device => ({
  id: 'dev_1',
  householdId: 'hh_1',
  integrationId: 'int_1',
  roomId: null,
  externalId: 'x1',
  vendor: 'shelly',
  name: 'Stehlampe',
  manufacturer: null,
  model: null,
  firmware: null,
  capabilities: ['switch'],
  capabilityOverride: null,
  state: { on: true, updatedAt: nowIso() },
  reachable: true,
  hidden: false,
  favorite: false,
  lastSeenAt: nowIso(),
  createdAt: nowIso(),
  updatedAt: nowIso(),
  ...over,
});

const integration = (over: Partial<Integration> = {}): Integration => ({
  id: 'int_1',
  householdId: 'hh_1',
  type: 'shelly',
  name: 'Shelly Küche',
  status: 'linked',
  config: { host: '10.0.0.5', generation: 2, deviceId: 'x', authRequired: false },
  secretsEnc: null,
  lastSeenAt: nowIso(),
  lastError: null,
  updateInfo: null,
  createdAt: nowIso(),
  updatedAt: nowIso(),
  ...over,
});

describe('Verlauf', () => {
  let dir: string;
  let repos: Repositories;
  let service: ActivityService;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-verlauf-'));
    const db = new Database(path.join(dir, 'db.json'));
    await db.load();
    repos = createRepositories(db);
  });

  after(async () => {
    service.stop();
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    service?.stop();
    service = new ActivityService(repos);
    service.start('hh_1');
    await service.clear('hh_1');
  });

  it('hält fest, wenn ein Gerät geschaltet wird', () => {
    events.emit('device.updated', { device: device(), changed: ['on'] });

    const [entry] = service.list('hh_1');
    assert.equal(entry?.kind, 'device');
    assert.match(entry?.message ?? '', /Stehlampe.*eingeschaltet/);
    assert.equal(entry?.deviceId, 'dev_1');
  });

  it('unterscheidet ein- und ausgeschaltet', () => {
    events.emit('device.updated', {
      device: device({ state: { on: false, updatedAt: nowIso() } }),
      changed: ['on'],
    });
    assert.match(service.list('hh_1')[0]?.message ?? '', /ausgeschaltet/);
  });

  it('schreibt Messwerte NICHT mit', () => {
    /*
     * Der Kern der Sache. Ein Temperatursensor meldet alle fünfzehn Sekunden;
     * daraus einen Eintrag zu machen hieße, den Verlauf mit Zahlen zu füllen,
     * für die es die Kurven gibt.
     */
    for (let i = 0; i < 50; i++) {
      events.emit('device.updated', {
        device: device({ state: { temperatureC: 21 + i / 10, updatedAt: nowIso() } }),
        changed: ['temperatureC'],
      });
    }
    events.emit('device.updated', {
      device: device({ state: { powerW: 12, updatedAt: nowIso() } }),
      changed: ['powerW', 'energyWh'],
    });

    assert.equal(service.list('hh_1').length, 0);
  });

  it('meldet, wenn ein Gerät nicht mehr antwortet – und wenn es wiederkommt', () => {
    events.emit('device.updated', { device: device({ reachable: false }), changed: ['reachable'] });
    events.emit('device.updated', { device: device({ reachable: true }), changed: ['reachable'] });

    const entries = service.list('hh_1');
    assert.equal(entries.length, 2);
    // Neueste zuerst.
    assert.match(entries[0]?.message ?? '', /wieder erreichbar/);
    assert.match(entries[1]?.message ?? '', /antwortet nicht mehr/);
    assert.equal(entries[1]?.level, 'warn', 'ein stummes Gerät ist eine Warnung');
  });

  it('hält Rollladen- und Heizungsstellungen fest', () => {
    events.emit('device.updated', {
      device: device({ name: 'Rollladen Bad', state: { position: 40, updatedAt: nowIso() } }),
      changed: ['position'],
    });
    events.emit('device.updated', {
      device: device({ name: 'Heizung', state: { targetTemperatureC: 21, updatedAt: nowIso() } }),
      changed: ['targetTemperatureC'],
    });

    const entries = service.list('hh_1');
    assert.match(entries[1]?.message ?? '', /Rollladen Bad.*40 %/);
    assert.match(entries[0]?.message ?? '', /Heizung.*21 °C/);
  });

  it('hält Automationen und Szenen fest', () => {
    events.emit('automation.triggered', {
      ruleId: 'r1',
      ruleName: 'Licht bei Bewegung',
      householdId: 'hh_1',
    });
    events.emit('scene.applied', {
      householdId: 'hh_1',
      sceneId: 's1',
      name: 'Abends',
      applied: 5,
      failed: 0,
    });

    const entries = service.list('hh_1');
    assert.equal(entries[1]?.kind, 'automation');
    assert.match(entries[1]?.message ?? '', /Licht bei Bewegung/);
    assert.equal(entries[0]?.kind, 'scene');
    assert.match(entries[0]?.message ?? '', /Abends.*5 Geräte/);
  });

  it('nennt eine Szene, die nur halb durchkam, beim Namen', () => {
    events.emit('scene.applied', {
      householdId: 'hh_1',
      sceneId: 's1',
      name: 'Abends',
      applied: 3,
      failed: 2,
    });

    const [entry] = service.list('hh_1');
    assert.equal(entry?.level, 'warn');
    assert.match(entry?.message ?? '', /3 von 5/);
  });

  it('meldet bei Integrationen nur den Wechsel, nicht jeden Abgleich', () => {
    /*
     * `integration.updated` feuert bei jedem Abgleich – im Abfragetakt. Ohne
     * diese Regel stünde alle fünfzehn Sekunden „Bridge in Ordnung" im
     * Verlauf.
     */
    events.emit('integration.updated', { integration: integration() });
    events.emit('integration.updated', { integration: integration() });
    events.emit('integration.updated', { integration: integration() });
    assert.equal(service.list('hh_1').length, 0, 'unveränderter Zustand ist keine Nachricht');

    events.emit('integration.updated', {
      integration: integration({ status: 'error', lastError: 'Zeitüberschreitung' }),
    });
    events.emit('integration.updated', { integration: integration({ status: 'linked' }) });

    const entries = service.list('hh_1');
    assert.equal(entries.length, 2);
    assert.match(entries[1]?.message ?? '', /meldet ein Problem/);
    assert.equal(entries[1]?.level, 'error');
    assert.match(entries[0]?.message ?? '', /antwortet wieder/);
  });

  it('nimmt Meldungen des Hubs auf', () => {
    events.emit('notification', {
      householdId: 'hh_1',
      message: 'Fassung 2.0.0 ist da.',
      level: 'info',
      source: 'hub-update',
    });

    const [entry] = service.list('hh_1');
    assert.equal(entry?.kind, 'system');
    assert.equal(entry?.detail, 'hub-update');
  });

  it('filtert nach Art', () => {
    events.emit('device.updated', { device: device(), changed: ['on'] });
    events.emit('automation.triggered', { ruleId: 'r1', ruleName: 'Nachtabsenkung', householdId: 'hh_1' });

    assert.equal(service.list('hh_1', { kind: 'device' }).length, 1);
    assert.equal(service.list('hh_1', { kind: 'automation' }).length, 1);
    assert.equal(service.list('hh_1', { kind: 'scene' }).length, 0);
  });

  it('sucht im Text', () => {
    events.emit('device.updated', { device: device({ name: 'Wintergarten' }), changed: ['on'] });
    events.emit('device.updated', { device: device({ id: 'dev_2', name: 'Küche' }), changed: ['on'] });

    assert.equal(service.list('hh_1', { search: 'winter' }).length, 1);
    assert.equal(service.list('hh_1', { search: 'gibtesnicht' }).length, 0);
  });

  it('zählt je Art für die Filterknöpfe', () => {
    events.emit('device.updated', { device: device(), changed: ['on'] });
    events.emit('device.updated', { device: device(), changed: ['reachable'] });
    events.emit('automation.triggered', { ruleId: 'r1', ruleName: 'X', householdId: 'hh_1' });

    const counts = service.counts('hh_1');
    assert.equal(counts.all, 3);
    assert.equal(counts.device, 2);
    assert.equal(counts.automation, 1);
    assert.equal(counts.scene, 0);
  });

  it('hält den Verlauf in Grenzen', () => {
    // 900 Ereignisse, aufbewahrt werden 800 – sonst wächst die Datei endlos.
    for (let i = 0; i < 900; i++) {
      events.emit('device.updated', { device: device({ name: `Lampe ${i}` }), changed: ['on'] });
    }

    const entries = service.list('hh_1', { limit: 500 });
    assert.ok(entries.length <= 500);
    assert.equal(service.counts('hh_1').all, 800);
    // Das Neueste muss überleben, das Älteste darf gehen.
    assert.match(service.list('hh_1')[0]?.message ?? '', /Lampe 899/);
  });

  it('übersteht einen Neustart des Hubs', async () => {
    events.emit('device.updated', { device: device({ name: 'Nachttisch' }), changed: ['on'] });
    await service.flush();
    service.stop();

    const wieder = new ActivityService(repos);
    wieder.start('hh_1');
    assert.match(wieder.list('hh_1')[0]?.message ?? '', /Nachttisch/);
    wieder.stop();
  });

  it('hört auf mitzuschreiben, sobald er angehalten ist', () => {
    service.stop();
    events.emit('device.updated', { device: device(), changed: ['on'] });
    assert.equal(service.list('hh_1').length, 0);
  });
});
