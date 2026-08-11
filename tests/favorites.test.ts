/**
 * Angeheftete Geräte.
 *
 * Der Anlass ist eine Rechnung, die jeder Haushalt aufmacht: Von dreißig
 * Geräten bedient man täglich vier. Ohne ein Oben-Halten sind das jedes Mal
 * dieselben vier, die man in derselben langen Liste sucht.
 *
 * Zwei Dinge müssen dafür stimmen, und das zweite ist das, was in der Praxis
 * schiefgeht: Das Merkmal muss sich setzen lassen – und es muss eine erneute
 * Geräteabfrage überstehen. Ginge es dabei verloren, wäre es beim nächsten
 * Neustart der Bridge weg.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import type { AppConfig } from '../src/config.ts';
import { setLogLevel } from '../src/core/logger.ts';
import type { Device } from '../src/core/types.ts';
import { createAdapterRegistry } from '../src/adapters/registry.ts';
import { DeviceService } from '../src/services/deviceService.ts';
import { HouseholdService } from '../src/services/householdService.ts';
import { IntegrationService } from '../src/services/integrationService.ts';
import { RoomService } from '../src/services/roomService.ts';
import { TelemetryService } from '../src/services/telemetryService.ts';
import { Database } from '../src/storage/database.ts';
import { createRepositories, type Repositories } from '../src/storage/repositories.ts';
import { TelemetryStore } from '../src/storage/telemetryStore.ts';
import { nowIso } from '../src/util/id.ts';

setLogLevel('silent');

describe('Angeheftete Geräte', () => {
  let dir: string;
  let repos: Repositories;
  let devices: DeviceService;
  let householdId: string;
  let deviceId: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-favoriten-'));
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
    devices = new DeviceService(repos, registry, integrations, telemetry);

    householdId = (await households.create({ name: 'Favoriten' })).id;

    const device: Device = {
      id: 'dev_lampe',
      householdId,
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
      state: { on: false, updatedAt: nowIso() },
      reachable: true,
      hidden: false,
      favorite: false,
      lastSeenAt: nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await repos.devices.insert(device);
    deviceId = device.id;
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ist zu Anfang nicht angeheftet', () => {
    assert.equal(devices.get(deviceId).favorite, false);
  });

  it('lässt sich anheften und wieder lösen', async () => {
    const pinned = await devices.update(deviceId, { favorite: true });
    assert.equal(pinned.favorite, true);

    const released = await devices.update(deviceId, { favorite: false });
    assert.equal(released.favorite, false);
  });

  it('bleibt angeheftet, wenn nur der Name geändert wird', async () => {
    await devices.update(deviceId, { favorite: true });
    const renamed = await devices.update(deviceId, { name: 'Leselampe' });

    assert.equal(renamed.name, 'Leselampe');
    assert.equal(renamed.favorite, true, 'ein Namenswechsel löst die Anheftung nicht');
  });

  it('überlebt einen Neustart des Hubs', async () => {
    await devices.update(deviceId, { favorite: true });

    // Dieselbe Datei noch einmal einlesen – das ist ein Neustart.
    const again = new Database(path.join(dir, 'db.json'));
    await again.load();
    const stored = createRepositories(again).devices.find(deviceId);

    assert.equal(stored?.favorite, true);
  });

  it('macht aus einem alten Datenstand ohne das Merkmal keinen Fehler', async () => {
    /*
     * Wer den Hub aktualisiert, hat Geräte in der Datenbank, die das Feld
     * nicht kennen. Ohne den Wanderungsschritt stünde dort `undefined`, und
     * jede Prüfung auf `=== false` ginge daneben.
     */
    const db = new Database(path.join(dir, 'alt.json'));
    await db.load();
    await db.update((data) => {
      data.households.push({ ...repos.households.get(householdId, 'Haushalt') });
      const device = { ...devices.get(deviceId) } as Partial<Device>;
      delete device.favorite;
      data.devices.push(device as Device);
    });

    const wieder = new Database(path.join(dir, 'alt.json'));
    await wieder.load();
    assert.equal(createRepositories(wieder).devices.find(deviceId)?.favorite, false);
  });
});
