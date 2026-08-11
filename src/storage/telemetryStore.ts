import { appendFile, mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../core/logger.js';
import type { Metric, TelemetryAggregate, TelemetryQuery, TelemetrySample } from '../core/types.js';

const log = createLogger('telemetry');

/**
 * Messwerte werden als JSON-Lines pro Tag abgelegt
 * (`data/telemetry/2026-08-07.jsonl`). Das hält das Schreiben billig
 * (nur Anhängen), macht Backups trivial und erlaubt Retention durch
 * simples Löschen alter Dateien.
 */
export class TelemetryStore {
  private buffer: TelemetrySample[] = [];
  private flushing: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly retentionDays: number,
  ) {}

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
  }

  /** Puffert einen Messwert; geschrieben wird beim nächsten `flush()`. */
  add(sample: TelemetrySample): void {
    this.buffer.push(sample);
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const pending = this.buffer;
    this.buffer = [];

    const byDay = new Map<string, string[]>();
    for (const sample of pending) {
      const day = sample.t.slice(0, 10);
      const lines = byDay.get(day) ?? [];
      lines.push(JSON.stringify(sample));
      byDay.set(day, lines);
    }

    this.flushing = this.flushing.then(async () => {
      for (const [day, lines] of byDay) {
        try {
          await appendFile(this.fileForDay(day), lines.join('\n') + '\n', 'utf8');
        } catch (err) {
          log.error('Messwerte konnten nicht geschrieben werden', {
            day,
            error: (err as Error).message,
          });
        }
      }
    });
    await this.flushing;
  }

  async query(query: TelemetryQuery): Promise<TelemetrySample[]> {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - 24 * 60 * 60 * 1000);
    const limit = query.limit ?? 5000;

    await this.flush();

    const results: TelemetrySample[] = [];
    for (const day of daysBetween(from, to)) {
      let content: string;
      try {
        content = await readFile(this.fileForDay(day), 'utf8');
      } catch {
        continue; // Tag ohne Messwerte
      }
      for (const line of content.split('\n')) {
        if (!line) continue;
        let sample: TelemetrySample;
        try {
          sample = JSON.parse(line) as TelemetrySample;
        } catch {
          continue; // abgeschnittene Zeile ignorieren
        }
        if (query.deviceId && sample.deviceId !== query.deviceId) continue;
        if (query.metric && sample.metric !== query.metric) continue;
        const t = new Date(sample.t).getTime();
        if (t < from.getTime() || t > to.getTime()) continue;
        results.push(sample);
      }
    }

    results.sort((a, b) => a.t.localeCompare(b.t));
    // Bei Überlänge gleichmäßig ausdünnen statt hart abzuschneiden, damit
    // Diagramme weiterhin den gesamten Zeitraum abdecken.
    return results.length > limit ? downsample(results, limit) : results;
  }

  async aggregate(query: TelemetryQuery): Promise<TelemetryAggregate[]> {
    const samples = await this.query({ ...query, limit: 1_000_000 });
    const groups = new Map<string, TelemetrySample[]>();
    for (const sample of samples) {
      const key = `${sample.deviceId}|${sample.metric}`;
      const list = groups.get(key) ?? [];
      list.push(sample);
      groups.set(key, list);
    }

    const result: TelemetryAggregate[] = [];
    for (const list of groups.values()) {
      const first = list[0] as TelemetrySample;
      const last = list[list.length - 1] as TelemetrySample;
      const values = list.map((s) => s.value);
      result.push({
        deviceId: first.deviceId,
        metric: first.metric,
        count: list.length,
        min: Math.min(...values),
        max: Math.max(...values),
        avg: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
        first,
        last,
      });
    }
    return result;
  }

  /**
   * Löscht das gesamte Messwertarchiv.
   *
   * Nur für das Zurücksetzen des Haushalts. Der Puffer wird mit verworfen –
   * sonst schriebe der nächste `flush()` Werte zurück, die zu einem Haushalt
   * gehören, den es nicht mehr gibt.
   */
  async clear(): Promise<number> {
    this.buffer = [];
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const entry of entries) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry)) continue;
      try {
        await unlink(path.join(this.directory, entry));
        removed++;
      } catch (err) {
        log.warn('Messwertdatei konnte nicht gelöscht werden', {
          file: entry,
          error: (err as Error).message,
        });
      }
    }
    return removed;
  }

  /** Löscht Dateien, die älter als die Aufbewahrungsdauer sind. */
  async pruneOldFiles(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000);
    const cutoffDay = cutoff.toISOString().slice(0, 10);
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return 0;
    }
    for (const entry of entries) {
      const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(entry);
      if (!match) continue;
      if ((match[1] as string) >= cutoffDay) continue;
      try {
        await unlink(path.join(this.directory, entry));
        removed++;
      } catch (err) {
        log.warn('Alte Messwertdatei konnte nicht gelöscht werden', {
          entry,
          error: (err as Error).message,
        });
      }
    }
    if (removed > 0) log.info('Alte Messwertdateien entfernt', { removed });
    return removed;
  }

  private fileForDay(day: string): string {
    return path.join(this.directory, `${day}.jsonl`);
  }
}

export function daysBetween(from: Date, to: Date): string[] {
  const days: string[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  let guard = 0;
  while (cursor.getTime() <= end && guard++ < 3660) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

/** Reduziert eine Messreihe gleichmäßig auf `limit` Punkte. */
export function downsample<T>(items: T[], limit: number): T[] {
  if (items.length <= limit || limit <= 0) return items;
  const step = items.length / limit;
  const result: T[] = [];
  for (let i = 0; i < limit; i++) {
    result.push(items[Math.floor(i * step)] as T);
  }
  const last = items[items.length - 1] as T;
  if (result[result.length - 1] !== last) result[result.length - 1] = last;
  return result;
}

/** Liefert die Metriken, die für eine Gerätefähigkeit archiviert werden. */
export const METRIC_BY_CAPABILITY: Record<string, Metric | undefined> = {
  'sensor.temperature': 'temperatureC',
  'sensor.humidity': 'humidity',
  'sensor.illuminance': 'illuminanceLux',
  'sensor.power': 'powerW',
  'sensor.energy': 'energyWh',
  'sensor.battery': 'batteryPercent',
};
