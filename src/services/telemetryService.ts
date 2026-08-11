import { events } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import type {
  Device,
  DeviceState,
  Metric,
  TelemetryAggregate,
  TelemetryQuery,
  TelemetrySample,
} from '../core/types.js';
import { METRICS } from '../core/types.js';
import type { TelemetryStore } from '../storage/telemetryStore.js';

const log = createLogger('telemetry-service');

/**
 * Ab welcher Änderung ein Messwert sofort gespeichert wird – unabhängig vom
 * Mindestabstand. So geht ein plötzlicher Temperatursprung nicht verloren,
 * während ein ruhiger Sensor nur alle paar Minuten schreibt.
 */
const SIGNIFICANT_CHANGE: Record<Metric, number> = {
  temperatureC: 0.3,
  humidity: 1.5,
  illuminanceLux: 25,
  powerW: 5,
  energyWh: 10,
  batteryPercent: 2,
  brightness: 10,
  // Solltemperatur ändert sich in Stufen von 0,5 °C.
  targetTemperatureC: 0.4,
  valvePosition: 5,
};

/** Auch ohne Änderung wird spätestens nach dieser Zeit ein Wert geschrieben. */
const HEARTBEAT_SECONDS = 15 * 60;

interface LastWrite {
  value: number;
  at: number;
}

export interface TelemetryServiceOptions {
  minIntervalSeconds: number;
  retentionDays: number;
}

export class TelemetryService {
  private readonly lastWrites = new Map<string, LastWrite>();

  constructor(
    private readonly store: TelemetryStore,
    private readonly options: TelemetryServiceOptions,
  ) {}

  /**
   * Übernimmt alle archivierbaren Messgrößen eines Zustands.
   * Rückgabe: Anzahl tatsächlich gespeicherter Werte.
   */
  record(device: Device, state: DeviceState, at = new Date()): number {
    let written = 0;
    for (const metric of METRICS) {
      const value = state[metric];
      if (typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (this.shouldWrite(device.id, metric, value, at)) {
        const sample: TelemetrySample = {
          t: at.toISOString(),
          deviceId: device.id,
          metric,
          value,
        };
        this.store.add(sample);
        this.lastWrites.set(key(device.id, metric), { value, at: at.getTime() });
        events.emit('telemetry.sample', { sample });
        written++;
      }
    }
    return written;
  }

  private shouldWrite(deviceId: string, metric: Metric, value: number, at: Date): boolean {
    const previous = this.lastWrites.get(key(deviceId, metric));
    if (!previous) return true;

    const elapsedSeconds = (at.getTime() - previous.at) / 1000;
    if (elapsedSeconds >= HEARTBEAT_SECONDS) return true;

    const delta = Math.abs(value - previous.value);
    if (delta >= (SIGNIFICANT_CHANGE[metric] ?? 0)) return true;

    return elapsedSeconds >= this.options.minIntervalSeconds && delta > 0;
  }

  async query(query: TelemetryQuery): Promise<TelemetrySample[]> {
    return this.store.query(query);
  }

  async aggregate(query: TelemetryQuery): Promise<TelemetryAggregate[]> {
    return this.store.aggregate(query);
  }

  /**
   * Fasst eine Messreihe zu Zeitfenstern zusammen (für Diagramme).
   * `bucketMinutes` bestimmt die Auflösung.
   */
  async series(
    query: TelemetryQuery,
    bucketMinutes: number,
  ): Promise<Array<{ t: string; min: number; max: number; avg: number; count: number }>> {
    const samples = await this.store.query({ ...query, limit: 1_000_000 });
    if (samples.length === 0) return [];

    const bucketMs = Math.max(1, bucketMinutes) * 60_000;
    const buckets = new Map<number, number[]>();
    for (const sample of samples) {
      const bucket = Math.floor(new Date(sample.t).getTime() / bucketMs) * bucketMs;
      const list = buckets.get(bucket) ?? [];
      list.push(sample.value);
      buckets.set(bucket, list);
    }

    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([bucket, values]) => ({
        t: new Date(bucket).toISOString(),
        min: Math.round(Math.min(...values) * 100) / 100,
        max: Math.round(Math.max(...values) * 100) / 100,
        avg: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
        count: values.length,
      }));
  }

  async flush(): Promise<void> {
    await this.store.flush();
  }

  async prune(): Promise<void> {
    const removed = await this.store.pruneOldFiles();
    if (removed > 0) {
      log.info('Messwerte gemäß Aufbewahrungsdauer gelöscht', {
        removed,
        retentionDays: this.options.retentionDays,
      });
    }
  }

  /** Entfernt die Deadband-Zustände eines gelöschten Geräts. */
  forgetDevice(deviceId: string): void {
    for (const mapKey of [...this.lastWrites.keys()]) {
      if (mapKey.startsWith(`${deviceId}|`)) this.lastWrites.delete(mapKey);
    }
  }
}

function key(deviceId: string, metric: Metric): string {
  return `${deviceId}|${metric}`;
}
