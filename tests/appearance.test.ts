/**
 * Darstellung, Datenbank-Nachrüstung, Kennung der Oberfläche und die
 * Firmware-Übersicht über alle Geräte.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { assetVersion, resetAssetVersionCache } from '../src/server/assetVersion.ts';
import { appearanceOf, normalizeAppearance } from '../src/services/householdService.ts';
import { HouseholdService } from '../src/services/householdService.ts';
import { IntegrationService } from '../src/services/integrationService.ts';
import { RoomService } from '../src/services/roomService.ts';
import { TelemetryService } from '../src/services/telemetryService.ts';
import { UpdateService } from '../src/services/updateService.ts';
import { createAdapterRegistry } from '../src/adapters/registry.ts';
import { Database } from '../src/storage/database.ts';
import { createRepositories } from '../src/storage/repositories.ts';
import { TelemetryStore } from '../src/storage/telemetryStore.ts';
import { DEFAULT_APPEARANCE } from '../src/core/types.ts';
import type { Appearance, Device, Household } from '../src/core/types.ts';
import { setLogLevel } from '../src/core/logger.ts';
import { nowIso } from '../src/util/id.ts';
import type { AppConfig } from '../src/config.ts';

setLogLevel('silent');

const appearance = (changes: Partial<Appearance>): Appearance =>
  normalizeAppearance({ ...DEFAULT_APPEARANCE, ...changes } as Appearance);

describe('Darstellung prüfen und begrenzen', () => {
  it('lässt sinnvolle Werte durch', () => {
    const result = appearance({ fontScale: 1.3, accentColor: '#1F8A4C', theme: 'dark' });
    assert.equal(result.fontScale, 1.3);
    assert.equal(result.accentColor, '#1f8a4c', 'Farben werden klein geschrieben');
    assert.equal(result.theme, 'dark');
  });

  it('hält die Schriftgröße in einem Bereich, in dem das Layout hält', () => {
    assert.equal(appearance({ fontScale: 5 }).fontScale, 1.6);
    assert.equal(appearance({ fontScale: 0.1 }).fontScale, 0.85);
    assert.equal(appearance({ fontScale: Number.NaN }).fontScale, 1);
  });

  it('macht aus einer unmöglichen Farbe die mitgelieferte', () => {
    // Sonst stünde im Stylesheet etwas, das der Browser stillschweigend
    // verwirft – die Einstellung sähe aus, als täte sie nichts.
    assert.equal(appearance({ accentColor: 'knallrot' as string }).accentColor, null);
    assert.equal(appearance({ accentColor: '#12345' as string }).accentColor, null);
    assert.equal(appearance({ accentColor: null }).accentColor, null);
  });

  it('kennt nur die drei Helligkeiten', () => {
    assert.equal(appearance({ theme: 'hell' as never }).theme, 'auto');
    assert.equal(appearance({ theme: 'light' }).theme, 'light');
  });

  it('ergänzt fehlende Angaben eines alten Haushalts', () => {
    const old = { name: 'Alt' } as unknown as Household;
    assert.deepEqual(appearanceOf(old), DEFAULT_APPEARANCE);
    assert.deepEqual(appearanceOf(undefined), DEFAULT_APPEARANCE);
  });

  it('lässt Schalter an, solange niemand sie ausschaltet', () => {
    // Wer nichts einstellt, bekommt Vorschau und Meldungen – abschalten muss
    // man ausdrücklich, und dann muss es auch halten.
    assert.equal(appearanceOf(undefined).automationNotifications, true);
    assert.equal(appearance({ automationNotifications: false }).automationNotifications, false);
    assert.equal(appearance({ livePreview: false }).livePreview, false);
    assert.equal(
      appearance({ automationNotifications: undefined as never }).automationNotifications,
      true,
      'eine fehlende Angabe ist keine Abschaltung',
    );
  });
});

describe('Datenbank rüstet fehlende Felder nach', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-migrate-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('ergänzt die Darstellung bei einem Haushalt aus einer früheren Fassung', async () => {
    const file = path.join(dir, 'db.json');
    // So sah die Datei aus, bevor es die Darstellung gab.
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        households: [{ id: 'hh_1', name: 'Altbestand', timezone: 'Europe/Berlin' }],
        rooms: [],
        integrations: [],
        devices: [],
        rules: [],
        tokens: [],
      }),
      'utf8',
    );

    const db = new Database(file);
    await db.load();
    const household = db.read().households[0];
    assert.deepEqual(household?.appearance, DEFAULT_APPEARANCE);
  });
});

describe('Kennung der ausgelieferten Oberfläche', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-assets-'));
    await writeFile(path.join(dir, 'app.js'), 'console.log(1)', 'utf8');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('bleibt gleich, solange sich nichts ändert', async () => {
    resetAssetVersionCache();
    const first = await assetVersion(dir);
    resetAssetVersionCache();
    assert.equal(await assetVersion(dir), first);
    assert.match(first, /^[0-9a-f]{12}$/);
  });

  it('ändert sich, sobald eine Datei anders ist', async () => {
    resetAssetVersionCache();
    const before = await assetVersion(dir);

    await writeFile(path.join(dir, 'app.js'), 'console.log(2) // länger', 'utf8');
    resetAssetVersionCache();

    assert.notEqual(await assetVersion(dir), before);
  });

  it('gibt bei fehlendem Verzeichnis eine unauffällige Antwort', async () => {
    resetAssetVersionCache();
    assert.equal(await assetVersion(path.join(dir, 'gibtesnicht')), 'unbekannt');
  });
});

describe('Firmware-Übersicht über alle Geräte', () => {
  let dir: string;
  let updates: UpdateService;
  let householdId = '';

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-updates-'));
    const db = new Database(path.join(dir, 'db.json'));
    await db.load();
    const repos = createRepositories(db);
    const households = new HouseholdService(repos);
    const rooms = new RoomService(repos);
    const store = new TelemetryStore(path.join(dir, 'telemetry'), 7);
    await store.init();
    const telemetry = new TelemetryService(store, { minIntervalSeconds: 0, retentionDays: 7 });
    const registry = createAdapterRegistry();
    const config = { secretKey: 'test' } as AppConfig;
    const integrations = new IntegrationService(repos, registry, rooms, telemetry, config);
    updates = new UpdateService(repos, registry, integrations, households);

    const household = await households.create({ name: 'Updates' });
    householdId = household.id;

    // Eine Hue Bridge mit einem Update und ein Shelly ohne.
    await repos.integrations.insert({
      id: 'int_hue',
      householdId,
      type: 'hue',
      name: 'Hue Bridge',
      externalId: 'bridge-1',
      status: 'linked',
      config: { host: '192.168.1.2' },
      secrets: {},
      lastError: null,
      lastSyncAt: null,
      updateInfo: {
        currentVersion: '1.60',
        availableVersion: '1.61',
        updateAvailable: true,
        installable: true,
        checkedAt: nowIso(),
        note: null,
        lastInstallStartedAt: null,
      },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    } as never);

    await repos.integrations.insert({
      id: 'int_shelly',
      householdId,
      type: 'shelly',
      name: 'Shelly Bad',
      externalId: 'shelly-1',
      status: 'linked',
      config: { host: '192.168.1.3', generation: 2 },
      secrets: {},
      lastError: null,
      lastSyncAt: null,
      updateInfo: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    } as never);

    const device = (id: string, name: string, integrationId: string, vendor: Device['vendor']) =>
      ({
        id,
        householdId,
        integrationId,
        roomId: null,
        externalId: id,
        vendor,
        name,
        manufacturer: null,
        model: 'Modell X',
        firmware: '1.2.3',
        capabilities: ['switch'],
        state: {},
        reachable: true,
        hidden: false,
        lastSeenAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }) as Device;

    await repos.devices.insert(device('dev_lampe', 'Stehlampe', 'int_hue', 'hue'));
    await repos.devices.insert(device('dev_steckdose', 'Steckdose', 'int_shelly', 'shelly'));
    await repos.devices.insert({
      ...device('dev_versteckt', 'Ausgeblendet', 'int_shelly', 'shelly'),
      hidden: true,
    });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('listet jedes sichtbare Gerät mit seiner Firmware', () => {
    const overview = updates.overview(householdId);
    assert.deepEqual(
      overview.devices.map((entry) => entry.name),
      ['Steckdose', 'Stehlampe'],
      'alphabetisch, ohne ausgeblendete Geräte',
    );
    assert.equal(overview.devices[0]?.firmware, '1.2.3');
    assert.equal(overview.devices[0]?.model, 'Modell X');
  });

  it('sagt, wer die Aktualisierung ausführt', () => {
    const overview = updates.overview(householdId);
    const byName = new Map(overview.devices.map((entry) => [entry.name, entry]));
    // Ein Shelly ist sein eigenes Gerät; Hue-Lampen hängen an der Bridge.
    assert.equal(byName.get('Steckdose')?.updatedBy, 'device');
    assert.equal(byName.get('Stehlampe')?.updatedBy, 'bridge');
    assert.equal(byName.get('Stehlampe')?.integrationName, 'Hue Bridge');
    // Beide Adapter können nach Firmware sehen – die Oberfläche darf einen
    // Knopf anbieten.
    assert.equal(byName.get('Steckdose')?.supported, true);
    assert.equal(byName.get('Stehlampe')?.supported, true);
  });

  it('zeigt am Gerät, dass über seine Zentrale ein Update bereitliegt', () => {
    const overview = updates.overview(householdId);
    const byName = new Map(overview.devices.map((entry) => [entry.name, entry]));
    assert.equal(byName.get('Stehlampe')?.updateAvailable, true);
    assert.equal(byName.get('Steckdose')?.updateAvailable, false);
    assert.equal(overview.updatesAvailable, 1);
  });
});
