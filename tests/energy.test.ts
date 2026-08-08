import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  consumptionFromCounter,
  consumptionFromPower,
  coverageOf,
  EnergyService,
  resolvePeriod,
  startOfLocalDay,
} from '../src/services/energyService.ts';
import { HouseholdService } from '../src/services/householdService.ts';
import { TelemetryService } from '../src/services/telemetryService.ts';
import { Database } from '../src/storage/database.ts';
import { createRepositories } from '../src/storage/repositories.ts';
import { TelemetryStore } from '../src/storage/telemetryStore.ts';
import { setLogLevel } from '../src/core/logger.ts';
import type { Device, Household, TelemetrySample } from '../src/core/types.ts';
import { nowIso } from '../src/util/id.ts';

setLogLevel('silent');

const sample = (t: string, value: number, metric: TelemetrySample['metric'] = 'energyWh'): TelemetrySample => ({
  t,
  deviceId: 'dev_1',
  metric,
  value,
});

describe('Verbrauch aus dem Energiezähler', () => {
  it('summiert die Zuwächse', () => {
    const samples = [
      sample('2026-08-07T10:00:00Z', 1000),
      sample('2026-08-07T11:00:00Z', 1150),
      sample('2026-08-07T12:00:00Z', 1400),
    ];
    assert.equal(consumptionFromCounter(samples), 400);
  });

  it('behandelt einen Zählerreset als neuen Nullpunkt', () => {
    // Gerät war stromlos: der Zähler springt von 5000 auf 20 zurück.
    const samples = [
      sample('2026-08-07T10:00:00Z', 4900),
      sample('2026-08-07T11:00:00Z', 5000),
      sample('2026-08-07T12:00:00Z', 20),
      sample('2026-08-07T13:00:00Z', 75),
    ];
    // 100 vor dem Reset + 20 unmittelbar danach + 55 danach = 175
    assert.equal(consumptionFromCounter(samples), 175);
  });

  it('liefert bei einer einzelnen Messung null statt einer Schätzung', () => {
    assert.equal(consumptionFromCounter([sample('2026-08-07T10:00:00Z', 1000)]), 0);
    assert.equal(consumptionFromCounter([]), 0);
  });

  it('wird nie negativ', () => {
    const samples = [sample('2026-08-07T10:00:00Z', 500), sample('2026-08-07T11:00:00Z', 0)];
    assert.ok(consumptionFromCounter(samples) >= 0);
  });
});

describe('Verbrauch aus der Leistungskurve', () => {
  /** Messreihe im realen Takt: der Hub schreibt spätestens alle 15 Minuten. */
  const everyQuarterHour = (start: string, values: number[]): TelemetrySample[] =>
    values.map((value, index) =>
      sample(new Date(new Date(start).getTime() + index * 15 * 60_000).toISOString(), value, 'powerW'),
    );

  it('integriert nach der Trapezregel', () => {
    // Konstant 100 W über zwei Stunden = 200 Wh
    const samples = everyQuarterHour('2026-08-07T10:00:00Z', Array(9).fill(100));
    assert.equal(Math.round(consumptionFromPower(samples)), 200);
  });

  it('mittelt zwischen zwei Messpunkten', () => {
    // 0 W → 200 W über eine Viertelstunde entspricht 25 Wh
    const samples = everyQuarterHour('2026-08-07T10:00:00Z', [0, 200]);
    assert.equal(Math.round(consumptionFromPower(samples)), 25);
  });

  it('überspringt Lücken, statt sie hochzurechnen', () => {
    // Zwischen 10:15 und 15:00 lief der Hub nicht.
    const samples = [
      sample('2026-08-07T10:00:00Z', 100, 'powerW'),
      sample('2026-08-07T10:15:00Z', 100, 'powerW'),
      sample('2026-08-07T15:00:00Z', 100, 'powerW'),
      sample('2026-08-07T15:15:00Z', 100, 'powerW'),
    ];
    assert.equal(
      Math.round(consumptionFromPower(samples)),
      50,
      'nur die beiden erfassten Viertelstunden zählen',
    );
  });

  it('lässt sich die Lückengrenze vorgeben', () => {
    const samples = [
      sample('2026-08-07T10:00:00Z', 100, 'powerW'),
      sample('2026-08-07T11:00:00Z', 100, 'powerW'),
    ];
    assert.equal(consumptionFromPower(samples), 0, 'eine Stunde überschreitet die Standardgrenze');
    assert.equal(Math.round(consumptionFromPower(samples, 2 * 3_600_000)), 100);
  });

  it('ignoriert Messwerte mit gleichem oder rückwärts laufendem Zeitstempel', () => {
    const samples = [
      sample('2026-08-07T11:00:00Z', 100, 'powerW'),
      sample('2026-08-07T11:00:00Z', 100, 'powerW'),
      sample('2026-08-07T10:00:00Z', 100, 'powerW'),
    ];
    assert.equal(consumptionFromPower(samples), 0);
  });
});

describe('Abdeckung eines Zeitraums', () => {
  const from = new Date('2026-08-07T10:00:00Z');
  const to = new Date('2026-08-07T14:00:00Z');

  it('erkennt lückenlose Erfassung', () => {
    const samples = Array.from({ length: 17 }, (_, index) =>
      sample(new Date(from.getTime() + index * 15 * 60_000).toISOString(), 1),
    );
    assert.ok(coverageOf(samples, from, to) > 0.98);
  });

  it('erkennt halbe Erfassung', () => {
    const samples = Array.from({ length: 9 }, (_, index) =>
      sample(new Date(from.getTime() + index * 15 * 60_000).toISOString(), 1),
    );
    const coverage = coverageOf(samples, from, to);
    assert.ok(coverage > 0.45 && coverage < 0.55, `Abdeckung ${coverage}`);
  });

  it('liefert 0 bei zu wenigen Messwerten', () => {
    assert.equal(coverageOf([sample(from.toISOString(), 1)], from, to), 0);
  });
});

describe('Zeiträume in der Zeitzone des Haushalts', () => {
  const household = (timezone: string): Household =>
    ({ timezone, pricePerKwh: 0.35, currency: 'EUR', basePricePerMonth: 0 }) as Household;

  it('findet den lokalen Tagesbeginn während der Sommerzeit', () => {
    // 2026-08-07 12:00 UTC → Tagesbeginn in Berlin ist 2026-08-06 22:00 UTC
    const start = startOfLocalDay(new Date('2026-08-07T12:00:00Z'), 'Europe/Berlin');
    assert.equal(start.toISOString(), '2026-08-06T22:00:00.000Z');
  });

  it('findet den lokalen Tagesbeginn während der Winterzeit', () => {
    const start = startOfLocalDay(new Date('2026-01-15T12:00:00Z'), 'Europe/Berlin');
    assert.equal(start.toISOString(), '2026-01-14T23:00:00.000Z');
  });

  it('rechnet in UTC ohne Verschiebung', () => {
    const start = startOfLocalDay(new Date('2026-08-07T12:00:00Z'), 'UTC');
    assert.equal(start.toISOString(), '2026-08-07T00:00:00.000Z');
  });

  it('grenzt "gestern" korrekt ab', () => {
    const period = resolvePeriod('yesterday', household('Europe/Berlin'));
    const hours = (period.to.getTime() - period.from.getTime()) / 3_600_000;
    assert.equal(Math.round(hours), 24);
    assert.equal(period.label, 'Gestern');
  });

  it('verlangt für eigene Zeiträume ein Startdatum', () => {
    assert.throws(
      () => resolvePeriod('custom', household('Europe/Berlin'), {}),
      /Startdatum/,
    );
    assert.throws(
      () =>
        resolvePeriod('custom', household('Europe/Berlin'), {
          from: new Date('2026-08-08T00:00:00Z'),
          to: new Date('2026-08-07T00:00:00Z'),
        }),
      /nicht vor dem Enddatum/,
    );
  });
});

// ---------------------------------------------------------------------------
// Gesamtrechnung über den Service
// ---------------------------------------------------------------------------

describe('Verbrauchs- und Kostenrechnung', () => {
  let dir: string;
  let energy: EnergyService;
  let telemetry: TelemetryService;
  let store: TelemetryStore;
  let householdId = '';

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-energy-'));
    const db = new Database(path.join(dir, 'db.json'));
    await db.load();
    const repos = createRepositories(db);
    const households = new HouseholdService(repos);

    const household = await households.create({ name: 'Energie', pricePerKwh: 0.4 });
    householdId = household.id;
    await households.update({ basePricePerMonth: 14.6 }); // ergibt 0,02 €/h

    store = new TelemetryStore(path.join(dir, 'telemetry'), 30);
    await store.init();
    telemetry = new TelemetryService(store, { minIntervalSeconds: 0, retentionDays: 30 });
    energy = new EnergyService(repos, telemetry, households);

    const makeDevice = (id: string, name: string, capabilities: Device['capabilities']): Device =>
      ({
        id,
        householdId,
        integrationId: 'int_1',
        roomId: null,
        externalId: id,
        vendor: 'shelly',
        name,
        manufacturer: null,
        model: null,
        firmware: null,
        capabilities,
        state: { powerW: 10 },
        reachable: true,
        hidden: false,
        lastSeenAt: nowIso(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }) as Device;

    await repos.devices.insert(makeDevice('dev_meter', 'Waschmaschine', ['switch', 'sensor.energy']));
    await repos.devices.insert(makeDevice('dev_power', 'Router', ['switch', 'sensor.power']));
    await repos.devices.insert(makeDevice('dev_plain', 'Deckenlampe', ['switch']));

    // Messwerte über die letzten vier Stunden.
    const now = Date.now();
    for (let i = 0; i <= 8; i++) {
      const t = new Date(now - (8 - i) * 15 * 60_000).toISOString();
      // Zähler: 2000 Wh Zuwachs über zwei Stunden
      store.add({ t, deviceId: 'dev_meter', metric: 'energyWh', value: 10_000 + i * 250 });
      // Dauerlast 8 W
      store.add({ t, deviceId: 'dev_power', metric: 'powerW', value: 8 });
    }
    await store.flush();
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rechnet den Zählerverbrauch in Kilowattstunden um', async () => {
    const summary = await energy.summary(householdId, 'today');
    const meter = summary.devices.find((device) => device.deviceId === 'dev_meter');
    assert.equal(meter?.energyKwh, 2, '8 × 250 Wh = 2 kWh');
    assert.equal(meter?.method, 'counter');
    assert.equal(meter?.cost, 0.8, '2 kWh × 0,40 €');
  });

  it('integriert Geräte ohne Zähler über die Leistung', async () => {
    const summary = await energy.summary(householdId, 'today');
    const router = summary.devices.find((device) => device.deviceId === 'dev_power');
    assert.equal(router?.method, 'power');
    // 8 W über zwei Stunden = 16 Wh
    assert.ok(
      Math.abs((router?.energyKwh ?? 0) - 0.016) < 0.001,
      `erwartet ~0,016 kWh, erhalten ${router?.energyKwh}`,
    );
  });

  it('lässt Geräte ohne Messfähigkeit weg und weist sie aus', async () => {
    const summary = await energy.summary(householdId, 'today');
    assert.equal(summary.devices.some((device) => device.deviceId === 'dev_plain'), false);
    assert.equal(summary.unmeteredDeviceCount, 1);
  });

  it('sortiert nach Verbrauch und berechnet Anteile', async () => {
    const summary = await energy.summary(householdId, 'today');
    assert.equal(summary.devices[0]?.deviceId, 'dev_meter');
    assert.ok((summary.devices[0]?.share ?? 0) > 98);
  });

  it('addiert Energiekosten und anteilige Grundgebühr', async () => {
    const summary = await energy.summary(householdId, 'today');
    assert.equal(summary.energyCost, Math.round(summary.totalKwh * 0.4 * 100) / 100);
    assert.ok(summary.baseCost > 0, 'die Grundgebühr wird anteilig umgelegt');
    assert.equal(summary.totalCost, Math.round((summary.energyCost + summary.baseCost) * 100) / 100);
  });

  it('erkennt Dauerverbraucher', async () => {
    const summary = await energy.summary(householdId, 'today');
    const standby = summary.standby.devices.find((device) => device.deviceId === 'dev_power');
    assert.ok(standby, 'der Router mit 8 W gilt als Dauerverbraucher');
    // 8 W × 8760 h = 70,08 kWh × 0,40 € = 28,03 €
    assert.ok(Math.abs((standby?.costPerYear ?? 0) - 28.03) < 0.5);
  });

  it('rechnet erst hoch, wenn genug vom Zeitraum erfasst ist', async () => {
    // Die Messreihe umfasst zwei Stunden. Über einen Tagesausschnitt gestreckt
    // ist das zu dünn für eine Prognose, über zweieinhalb Stunden reicht es.
    // Feste Zeiträume, damit das Ergebnis nicht von der Uhrzeit abhängt.
    const now = new Date();
    const sparse = await energy.summary(householdId, 'custom', {
      from: new Date(now.getTime() - 24 * 60 * 60_000),
      to: now,
    });
    assert.ok(sparse.coverage < 0.2, `Abdeckung ${sparse.coverage}`);
    assert.equal(sparse.projection, null, 'aus wenigen Messwerten wird nichts hochgerechnet');

    const dense = await energy.summary(householdId, 'custom', {
      from: new Date(now.getTime() - 2.5 * 60 * 60_000),
      to: now,
    });
    assert.ok(dense.coverage >= 0.2, `Abdeckung ${dense.coverage}`);
    assert.ok(dense.projection, 'bei guter Abdeckung gibt es eine Prognose');
    assert.equal(
      dense.projection?.perMonthKwh,
      Math.round((dense.projection?.perDayKwh ?? 0) * 30 * 100) / 100,
    );
    assert.ok(
      (dense.projection?.perYearCost ?? 0) > (dense.projection?.perMonthCost ?? 0),
      'die Jahresprognose liegt über der Monatsprognose',
    );
  });

  it('liefert für einen leeren Zeitraum saubere Nullen statt NaN', async () => {
    const summary = await energy.summary(householdId, 'yesterday');
    assert.equal(summary.totalKwh, 0);
    assert.equal(summary.energyCost, 0);
    assert.equal(summary.coverage, 0);
    assert.equal(summary.projection, null);
  });
});
