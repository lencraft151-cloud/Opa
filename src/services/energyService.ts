import { badRequest } from '../core/errors.js';
import type { Device, Household, TelemetrySample } from '../core/types.js';
import type { Repositories } from '../storage/repositories.js';
import type { HouseholdService } from './householdService.js';
import type { TelemetryService } from './telemetryService.js';

export const ENERGY_PERIODS = ['today', 'yesterday', 'week', 'month', 'year', 'custom'] as const;
export type EnergyPeriod = (typeof ENERGY_PERIODS)[number];

/**
 * Größere Lücken zwischen zwei Messwerten bedeuten, dass der Hub aus war.
 * Solche Zeiträume werden nicht hochgerechnet, sondern als „nicht erfasst“
 * ausgewiesen – lieber eine ehrliche Lücke als eine erfundene Kilowattstunde.
 */
const MAX_GAP_MS = 30 * 60 * 1000;

/** Unterhalb dieser Dauerleistung gilt ein Gerät als Standby-Verbraucher. */
const STANDBY_MAX_W = 15;
const STANDBY_MIN_W = 0.2;

/**
 * Ab welcher Abdeckung eine Hochrechnung überhaupt ausgewiesen wird.
 *
 * Aus fünf Minuten Messdaten eine Jahresprognose zu bilden hieße, den Wert um
 * das Hunderttausendfache zu strecken. Solche Zahlen sehen belastbar aus, sind
 * es aber nicht – deshalb lieber gar keine Prognose.
 */
const MIN_PROJECTION_COVERAGE = 0.2;

export interface DeviceEnergy {
  deviceId: string;
  name: string;
  roomId: string | null;
  roomName: string | null;
  vendor: Device['vendor'];
  energyKwh: number;
  cost: number;
  /** Anteil am Gesamtverbrauch in Prozent. */
  share: number;
  /** Mittlere Leistung über die erfassten Stunden (nicht über den Kalenderzeitraum). */
  averagePowerW: number;
  currentPowerW: number | null;
  /** Woraus der Verbrauch berechnet wurde. */
  method: 'counter' | 'power' | 'none';
  /** Anteil des Zeitraums, für den Messwerte vorliegen (0..1). */
  coverage: number;
}

export interface RoomEnergy {
  roomId: string | null;
  roomName: string;
  energyKwh: number;
  cost: number;
  share: number;
  deviceCount: number;
}

export interface EnergySummary {
  period: { key: EnergyPeriod; from: string; to: string; label: string; hours: number };
  currency: string;
  pricePerKwh: number;
  totalKwh: number;
  energyCost: number;
  /** Anteilige Grundgebühr für den Zeitraum. */
  baseCost: number;
  totalCost: number;
  currentPowerW: number;
  devices: DeviceEnergy[];
  rooms: RoomEnergy[];
  /** Anteil des Zeitraums mit Messwerten (0..1) – Grundlage der Prognose. */
  coverage: number;
  /**
   * Hochrechnung auf Tag/Monat/Jahr. `null`, solange zu wenige Messwerte
   * vorliegen – dann wäre jede Zahl geraten.
   */
  projection: {
    perDayKwh: number;
    perMonthKwh: number;
    perMonthCost: number;
    perYearKwh: number;
    perYearCost: number;
  } | null;
  standby: {
    devices: Array<{ deviceId: string; name: string; powerW: number; costPerYear: number }>;
    totalPowerW: number;
    costPerYear: number;
  };
  /** Geräte ohne Messfähigkeit – ihr Verbrauch fehlt in der Summe. */
  unmeteredDeviceCount: number;
}

export class EnergyService {
  constructor(
    private readonly repos: Repositories,
    private readonly telemetry: TelemetryService,
    private readonly households: HouseholdService,
  ) {}

  async summary(
    householdId: string,
    periodKey: EnergyPeriod = 'today',
    custom?: { from?: Date; to?: Date },
  ): Promise<EnergySummary> {
    const household = this.households.require();
    const period = resolvePeriod(periodKey, household, custom);
    const hours = (period.to.getTime() - period.from.getTime()) / 3_600_000;

    const devices = this.repos.devices
      .listByHousehold(householdId)
      .filter((device) => !device.hidden);

    const metered = devices.filter(
      (device) =>
        device.capabilities.includes('sensor.energy') ||
        device.capabilities.includes('sensor.power'),
    );

    const rooms = new Map(this.repos.rooms.listByHousehold(householdId).map((r) => [r.id, r.name]));

    const perDevice: DeviceEnergy[] = [];
    for (const device of metered) {
      const result = await this.consumptionOf(device, period.from, period.to);
      perDevice.push({
        deviceId: device.id,
        name: device.name,
        roomId: device.roomId,
        roomName: device.roomId ? (rooms.get(device.roomId) ?? null) : null,
        vendor: device.vendor,
        energyKwh: round(result.kwh, 3),
        cost: 0, // wird unten gefüllt, sobald die Summe bekannt ist
        share: 0,
        averagePowerW: round(result.averageW, 1),
        currentPowerW: typeof device.state.powerW === 'number' ? device.state.powerW : null,
        method: result.method,
        coverage: round(result.coverage, 3),
      });
    }

    const totalKwh = perDevice.reduce((sum, entry) => sum + entry.energyKwh, 0);
    for (const entry of perDevice) {
      entry.cost = round(entry.energyKwh * household.pricePerKwh, 2);
      entry.share = totalKwh > 0 ? round((entry.energyKwh / totalKwh) * 100, 1) : 0;
    }
    perDevice.sort((a, b) => b.energyKwh - a.energyKwh);

    // Räume aufsummieren, Geräte ohne Raum unter "Ohne Raum".
    const roomTotals = new Map<string | null, RoomEnergy>();
    for (const entry of perDevice) {
      const key = entry.roomId;
      const existing = roomTotals.get(key) ?? {
        roomId: key,
        roomName: entry.roomName ?? 'Ohne Raum',
        energyKwh: 0,
        cost: 0,
        share: 0,
        deviceCount: 0,
      };
      existing.energyKwh = round(existing.energyKwh + entry.energyKwh, 3);
      existing.cost = round(existing.cost + entry.cost, 2);
      existing.deviceCount++;
      roomTotals.set(key, existing);
    }
    const roomList = [...roomTotals.values()].map((room) => ({
      ...room,
      share: totalKwh > 0 ? round((room.energyKwh / totalKwh) * 100, 1) : 0,
    }));
    roomList.sort((a, b) => b.energyKwh - a.energyKwh);

    // Hochrechnung auf dem tatsächlich erfassten Zeitraum, nicht auf der
    // Kalenderlänge – sonst wirkt der laufende Tag künstlich sparsam.
    const coverage = perDevice.reduce((max, entry) => Math.max(max, entry.coverage), 0);
    const coveredHours = Math.max(0.25, coverage * hours);
    const perDayKwh = round((totalKwh / coveredHours) * 24, 3);
    const perMonthKwh = round(perDayKwh * 30, 2);
    const perYearKwh = round(perDayKwh * 365, 2);
    const projectionReliable = coverage >= MIN_PROJECTION_COVERAGE && totalKwh > 0;

    const energyCost = round(totalKwh * household.pricePerKwh, 2);
    const baseCost = round((household.basePricePerMonth / 730) * hours, 2);

    const standbyDevices = perDevice
      .filter(
        (entry) => entry.averagePowerW >= STANDBY_MIN_W && entry.averagePowerW <= STANDBY_MAX_W,
      )
      .map((entry) => ({
        deviceId: entry.deviceId,
        name: entry.name,
        powerW: entry.averagePowerW,
        costPerYear: round(((entry.averagePowerW * 8760) / 1000) * household.pricePerKwh, 2),
      }));

    return {
      period: {
        key: periodKey,
        from: period.from.toISOString(),
        to: period.to.toISOString(),
        label: period.label,
        hours: round(hours, 2),
      },
      currency: household.currency,
      pricePerKwh: household.pricePerKwh,
      totalKwh: round(totalKwh, 3),
      energyCost,
      baseCost,
      totalCost: round(energyCost + baseCost, 2),
      currentPowerW: round(
        devices.reduce(
          (sum, device) => sum + (typeof device.state.powerW === 'number' ? device.state.powerW : 0),
          0,
        ),
        1,
      ),
      devices: perDevice,
      rooms: roomList,
      coverage: round(coverage, 3),
      projection: projectionReliable
        ? {
            perDayKwh,
            perMonthKwh,
            perMonthCost: round(
              perMonthKwh * household.pricePerKwh + household.basePricePerMonth,
              2,
            ),
            perYearKwh,
            perYearCost: round(
              perYearKwh * household.pricePerKwh + household.basePricePerMonth * 12,
              2,
            ),
          }
        : null,
      standby: {
        devices: standbyDevices,
        totalPowerW: round(
          standbyDevices.reduce((sum, entry) => sum + entry.powerW, 0),
          1,
        ),
        costPerYear: round(
          standbyDevices.reduce((sum, entry) => sum + entry.costPerYear, 0),
          2,
        ),
      },
      unmeteredDeviceCount: devices.length - metered.length,
    };
  }

  /**
   * Verbrauch eines Geräts im Zeitraum.
   *
   * Bevorzugt wird der Energiezähler des Geräts (exakt, überlebt auch Zeiten
   * ohne Hub). Fehlt er, wird die Leistungskurve integriert.
   */
  private async consumptionOf(
    device: Device,
    from: Date,
    to: Date,
  ): Promise<{ kwh: number; averageW: number; coverage: number; method: DeviceEnergy['method'] }> {
    const hours = (to.getTime() - from.getTime()) / 3_600_000;

    /**
     * Die mittlere Leistung bezieht sich auf die tatsächlich erfassten
     * Stunden, nicht auf die Kalenderlänge des Zeitraums. Sonst erschiene ein
     * Gerät, das seit einer Stunde durchgehend 8 W zieht, bei der Auswertung
     * „heute“ am Vormittag als 1-W-Verbraucher – und die Jahreshochrechnung
     * läge um ein Vielfaches daneben.
     */
    const evaluate = (
      wh: number,
      samples: TelemetrySample[],
      method: DeviceEnergy['method'],
    ): { kwh: number; averageW: number; coverage: number; method: DeviceEnergy['method'] } => {
      const coverage = coverageOf(samples, from, to);
      const coveredHours = Math.max(coverage * hours, 1 / 60);
      return { kwh: wh / 1000, averageW: wh / coveredHours, coverage, method };
    };

    if (device.capabilities.includes('sensor.energy')) {
      const samples = await this.telemetry.query({
        deviceId: device.id,
        metric: 'energyWh',
        from,
        to,
        limit: 1_000_000,
      });
      if (samples.length >= 2) return evaluate(consumptionFromCounter(samples), samples, 'counter');
    }

    if (device.capabilities.includes('sensor.power')) {
      const samples = await this.telemetry.query({
        deviceId: device.id,
        metric: 'powerW',
        from,
        to,
        limit: 1_000_000,
      });
      if (samples.length >= 2) return evaluate(consumptionFromPower(samples), samples, 'power');
    }

    return { kwh: 0, averageW: 0, coverage: 0, method: 'none' };
  }
}

// ---------------------------------------------------------------------------
// Reine Rechenfunktionen (separat testbar)
// ---------------------------------------------------------------------------

/**
 * Verbrauch aus einem fortlaufenden Energiezähler in Wattstunden.
 *
 * Zähler laufen monoton – außer das Gerät wird stromlos oder zurückgesetzt.
 * Ein Rückwärtssprung wird deshalb als Reset gewertet: der neue Wert ist die
 * neue Basis, statt einen riesigen negativen Verbrauch zu erzeugen.
 */
export function consumptionFromCounter(samples: TelemetrySample[]): number {
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const previous = (samples[i - 1] as TelemetrySample).value;
    const current = (samples[i] as TelemetrySample).value;
    const delta = current - previous;
    if (delta >= 0) {
      total += delta;
    } else {
      // Zählerreset: alles ab hier zählt ab dem neuen Nullpunkt.
      total += current;
    }
  }
  return Math.max(0, total);
}

/**
 * Verbrauch aus der Leistungskurve in Wattstunden (Trapezregel).
 *
 * Lücken über {@link MAX_GAP_MS} werden übersprungen – dort lief der Hub
 * nicht, und geraten wird nicht.
 */
export function consumptionFromPower(samples: TelemetrySample[], maxGapMs = MAX_GAP_MS): number {
  let total = 0;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1] as TelemetrySample;
    const current = samples[i] as TelemetrySample;
    const deltaMs = new Date(current.t).getTime() - new Date(previous.t).getTime();
    if (deltaMs <= 0 || deltaMs > maxGapMs) continue;
    const averageW = (previous.value + current.value) / 2;
    total += (averageW * deltaMs) / 3_600_000;
  }
  return Math.max(0, total);
}

/** Anteil des Zeitraums, der von Messwerten abgedeckt ist (0..1). */
export function coverageOf(
  samples: TelemetrySample[],
  from: Date,
  to: Date,
  maxGapMs = MAX_GAP_MS,
): number {
  const span = to.getTime() - from.getTime();
  if (span <= 0 || samples.length < 2) return 0;

  let covered = 0;
  for (let i = 1; i < samples.length; i++) {
    const deltaMs =
      new Date((samples[i] as TelemetrySample).t).getTime() -
      new Date((samples[i - 1] as TelemetrySample).t).getTime();
    if (deltaMs > 0 && deltaMs <= maxGapMs) covered += deltaMs;
  }
  return Math.min(1, covered / span);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Zeiträume in der Zeitzone des Haushalts
// ---------------------------------------------------------------------------

/** Verschiebung der Zeitzone gegenüber UTC zum gegebenen Zeitpunkt. */
function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const lookup: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    lookup['year'] ?? 1970,
    (lookup['month'] ?? 1) - 1,
    lookup['day'] ?? 1,
    (lookup['hour'] ?? 0) % 24,
    lookup['minute'] ?? 0,
    lookup['second'] ?? 0,
  );
  return asUtc - date.getTime();
}

/** Beginn des lokalen Tages, in dem `date` liegt – als UTC-Zeitpunkt. */
export function startOfLocalDay(date: Date, timezone: string, dayOffset = 0): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);

  const naive = new Date(`${ymd}T00:00:00Z`).getTime() + dayOffset * 86_400_000;
  // Zwei Durchläufe, damit auch die Zeitumstellung korrekt landet.
  let result = naive;
  for (let i = 0; i < 2; i++) {
    result = naive - timezoneOffsetMs(new Date(result), timezone);
  }
  return new Date(result);
}

export function resolvePeriod(
  key: EnergyPeriod,
  household: Household,
  custom?: { from?: Date; to?: Date },
): { from: Date; to: Date; label: string } {
  const now = new Date();
  const timezone = household.timezone;
  const startToday = startOfLocalDay(now, timezone);

  switch (key) {
    case 'today':
      return { from: startToday, to: now, label: 'Heute' };
    case 'yesterday':
      return {
        from: startOfLocalDay(now, timezone, -1),
        to: startToday,
        label: 'Gestern',
      };
    case 'week':
      return { from: startOfLocalDay(now, timezone, -6), to: now, label: 'Letzte 7 Tage' };
    case 'month':
      return { from: startOfLocalDay(now, timezone, -29), to: now, label: 'Letzte 30 Tage' };
    case 'year':
      return { from: startOfLocalDay(now, timezone, -364), to: now, label: 'Letzte 12 Monate' };
    case 'custom': {
      const from = custom?.from;
      const to = custom?.to ?? now;
      if (!from) {
        throw badRequest(
          'Für einen eigenen Zeitraum fehlt das Startdatum.',
          undefined,
          'Gib "from" als ISO-Zeitstempel an, z. B. 2026-08-01T00:00:00Z.',
        );
      }
      if (from >= to) {
        throw badRequest(
          'Das Startdatum liegt nicht vor dem Enddatum.',
          undefined,
          'Prüfe die Reihenfolge von "from" und "to".',
        );
      }
      return { from, to, label: 'Eigener Zeitraum' };
    }
    default:
      return { from: startToday, to: now, label: 'Heute' };
  }
}
