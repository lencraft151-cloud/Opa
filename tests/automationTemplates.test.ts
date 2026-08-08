import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AutomationService } from '../src/services/automationService.ts';
import {
  AUTOMATION_TEMPLATES,
  resolveTemplates,
  templateById,
} from '../src/services/automationTemplates.ts';
import { DeviceService } from '../src/services/deviceService.ts';
import { HouseholdService } from '../src/services/householdService.ts';
import { IntegrationService } from '../src/services/integrationService.ts';
import { RoomService } from '../src/services/roomService.ts';
import { TelemetryService } from '../src/services/telemetryService.ts';
import { createAdapterRegistry } from '../src/adapters/registry.ts';
import { Database } from '../src/storage/database.ts';
import { createRepositories } from '../src/storage/repositories.ts';
import { TelemetryStore } from '../src/storage/telemetryStore.ts';
import { setLogLevel } from '../src/core/logger.ts';
import type { AppConfig } from '../src/config.ts';
import type { Capability, Device, Room } from '../src/core/types.ts';
import { nowIso } from '../src/util/id.ts';

setLogLevel('silent');

function makeDevice(
  id: string,
  name: string,
  capabilities: Capability[],
  roomId: string | null = null,
): Device {
  return {
    id,
    householdId: 'hh_1',
    integrationId: 'int_1',
    roomId,
    externalId: id,
    vendor: 'shelly',
    name,
    manufacturer: null,
    model: null,
    firmware: null,
    capabilities,
    state: {},
    reachable: true,
    hidden: false,
    lastSeenAt: nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function makeRoom(id: string, name: string): Room {
  return {
    id,
    householdId: 'hh_1',
    name,
    icon: 'room',
    targetTemperatureC: null,
    sortOrder: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

describe('Vorlagen beschreiben sich selbst', () => {
  it('hat für jede Vorlage Text, Emoji und Felder', () => {
    assert.ok(AUTOMATION_TEMPLATES.length >= 5);
    for (const template of AUTOMATION_TEMPLATES) {
      assert.ok(template.name.length > 5, template.id);
      assert.ok(template.summary.length > 10, `${template.id}: Kurzfassung fehlt`);
      assert.ok(template.explanation.length > 30, `${template.id}: Erklärung zu knapp`);
      assert.ok(template.emoji.length > 0, template.id);
      for (const field of template.fields) {
        assert.ok(field.help.length > 10, `${template.id}.${field.key}: Hilfetext fehlt`);
        assert.ok(field.label.length > 2, `${template.id}.${field.key}: Beschriftung fehlt`);
      }
    }
  });

  it('verwendet eindeutige Bezeichner', () => {
    const ids = AUTOMATION_TEMPLATES.map((template) => template.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('meldet unbekannte Vorlagen mit einem Hinweis', () => {
    assert.throws(() => templateById('gibtesnicht'), /gibt es nicht/);
  });
});

describe('Vorbelegung aus dem Gerätebestand', () => {
  const flur = makeRoom('room_flur', 'Flur');
  const bad = makeRoom('room_bad', 'Bad');

  const devices = [
    makeDevice('dev_motion', 'Bewegungsmelder Flur', ['sensor.motion'], 'room_flur'),
    makeDevice('dev_flurlicht', 'Flurlicht', ['switch'], 'room_flur'),
    makeDevice('dev_badlicht', 'Badlicht', ['switch'], 'room_bad'),
    makeDevice('dev_temp', 'Bad Temperatur', ['sensor.temperature'], 'room_bad'),
    makeDevice('dev_cover', 'Rollladen Wohnzimmer', ['cover']),
  ];

  const resolved = resolveTemplates(devices, [flur, bad]);
  const byId = new Map(resolved.map((template) => [template.id, template]));

  it('paart Bewegungsmelder und Licht aus demselben Raum', () => {
    const template = byId.get('motion-light');
    assert.equal(template?.applicable, true);
    assert.equal(template?.defaults['sensor'], 'dev_motion');
    assert.deepEqual(
      template?.defaults['lights'],
      ['dev_flurlicht'],
      'das Badlicht gehört nicht zum Flur-Melder',
    );
  });

  it('bietet alle passenden Geräte zur Auswahl an', () => {
    const template = byId.get('motion-light');
    assert.deepEqual(
      (template?.options['lights'] ?? []).map((option) => option.id).sort(),
      ['dev_badlicht', 'dev_flurlicht'],
    );
    assert.match(template?.options['lights']?.[0]?.label ?? '', /\(/, 'Raum steht im Namen');
  });

  it('belegt Zahlen- und Zeitfelder sinnvoll vor', () => {
    assert.equal(byId.get('cold-room-heat')?.defaults['below'], 19);
    assert.equal(byId.get('humidity-fan')?.defaults['above'], 65);
    assert.equal(byId.get('covers-morning')?.defaults['at'], '07:30');
    assert.equal(byId.get('covers-evening')?.defaults['at'], '21:00');
    assert.equal(byId.get('all-off-night')?.defaults['at'], '23:30');
  });

  it('verwendet je Vorlage eigene Vorgabewerte für gleichnamige Felder', () => {
    // "below" heißt bei der Heizung 19 °C, bei der Batterie 20 % – ein
    // gemeinsamer Wert wäre in einem der Fälle unsinnig.
    assert.equal(byId.get('cold-room-heat')?.defaults['below'], 19);
    assert.equal(byId.get('low-battery')?.defaults['below'], 20);
  });

  it('erklärt in Alltagssprache, was für eine Vorlage fehlt', () => {
    const template = byId.get('humidity-fan');
    assert.equal(template?.applicable, false);
    assert.deepEqual(template?.missing, ['Es ist kein Feuchtesensor eingebunden.']);

    const battery = byId.get('low-battery');
    assert.equal(battery?.applicable, false);
    assert.match(battery?.missing[0] ?? '', /Batteriestand/);
  });

  it('braucht für den Nachtschalter kein bestimmtes Gerät', () => {
    // Die Regel zielt auf alle schaltbaren Geräte – sie ist immer anwendbar.
    assert.equal(byId.get('all-off-night')?.applicable, true);
  });

  it('kommt mit einem leeren Haushalt zurecht', () => {
    const empty = resolveTemplates([], []);
    assert.equal(empty.length, AUTOMATION_TEMPLATES.length);
    assert.equal(empty.filter((template) => template.applicable).length, 1, 'nur "alles aus"');
  });

  it('ignoriert ausgeblendete Geräte', () => {
    const hidden = devices.map((device) =>
      device.id === 'dev_motion' ? { ...device, hidden: true } : device,
    );
    const result = resolveTemplates(hidden, [flur, bad]);
    assert.equal(result.find((template) => template.id === 'motion-light')?.applicable, false);
  });
});

// ---------------------------------------------------------------------------
// Anlegen über den Service
// ---------------------------------------------------------------------------

describe('Regel aus einer Vorlage anlegen', () => {
  let dir: string;
  let automations: AutomationService;
  let householdId = '';

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-templates-'));
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
    const devices = new DeviceService(repos, registry, integrations, telemetry);
    automations = new AutomationService(repos, devices, households);

    const created = await households.create({ name: 'Vorlagen' });
    householdId = created.household.id;

    const flur = await rooms.create(householdId, { name: 'Flur' });
    for (const device of [
      makeDevice('dev_motion', 'Bewegungsmelder', ['sensor.motion'], flur.id),
      makeDevice('dev_light', 'Flurlicht', ['switch'], flur.id),
      makeDevice('dev_cover', 'Rollladen', ['cover'], flur.id),
    ]) {
      await repos.devices.insert({ ...device, householdId });
    }
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('legt eine Regel ohne jede Eingabe an', async () => {
    const rule = await automations.createFromTemplate(householdId, 'motion-light', {});
    assert.equal(rule.name, 'Licht bei Bewegung');
    assert.equal(rule.enabled, true);
    assert.deepEqual(rule.trigger, {
      type: 'deviceState',
      deviceId: 'dev_motion',
      property: 'motion',
      equals: true,
    });
    assert.equal(rule.actions[0]?.type, 'command');
    assert.equal(rule.cooldownSeconds, 300);
  });

  it('übernimmt eigene Werte und einen eigenen Namen', async () => {
    const rule = await automations.createFromTemplate(
      householdId,
      'covers-evening',
      { at: '20:15', covers: ['dev_cover'] },
      'Rollladen Wohnzimmer abends',
    );
    assert.equal(rule.name, 'Rollladen Wohnzimmer abends');
    assert.deepEqual(rule.trigger, { type: 'schedule', at: '20:15', days: [] });
    assert.deepEqual(rule.actions[0], {
      type: 'command',
      target: { deviceIds: ['dev_cover'] },
      command: { type: 'closeCover' },
    });
  });

  it('setzt die Werktagsauswahl in Wochentage um', async () => {
    const werktags = await automations.createFromTemplate(householdId, 'covers-morning', {
      weekdaysOnly: 1,
    });
    assert.deepEqual((werktags.trigger as { days: number[] }).days, [1, 2, 3, 4, 5]);

    const taeglich = await automations.createFromTemplate(householdId, 'covers-morning', {
      weekdaysOnly: 0,
    });
    assert.deepEqual((taeglich.trigger as { days: number[] }).days, []);
  });

  it('weist eine ungültige Uhrzeit verständlich ab', async () => {
    await assert.rejects(
      () => automations.createFromTemplate(householdId, 'covers-evening', { at: '25:00' }),
      (err: Error & { hint?: string }) => {
        assert.match(err.message, /keine gültige Uhrzeit/);
        assert.match(err.hint ?? '', /HH:MM/);
        return true;
      },
    );
  });

  it('weist eine Vorlage ohne passendes Gerät ab', async () => {
    await assert.rejects(
      () => automations.createFromTemplate(householdId, 'humidity-fan', {}),
      /nichts ausgewählt|gehört nicht/,
    );
  });

  it('prüft die angegebenen Geräte gegen den Haushalt', async () => {
    await assert.rejects(
      () =>
        automations.createFromTemplate(householdId, 'motion-light', {
          lights: ['dev_fremd'],
        }),
      /gehört nicht zu diesem Haushalt/,
    );
  });
});
