import { createLogger } from '../core/logger.js';
import { events } from '../core/events.js';
import type { ActivityEntry, ActivityKind, Device } from '../core/types.js';
import type { Repositories } from '../storage/repositories.js';
import { createId, nowIso } from '../util/id.js';

const log = createLogger('activity');

/**
 * Der Verlauf: was ist wann passiert.
 *
 * Zu unterscheiden von den Messwerten (`telemetryService.ts`). Eine
 * Temperaturkurve beantwortet „wie warm war es?"; der Verlauf beantwortet
 * „was ist geschehen?" – wer hat geschaltet, welche Automation lief, wann war
 * ein Gerät weg, wann hat eine Bridge gestreikt.
 *
 * Zwei Entscheidungen prägen alles Weitere:
 *
 * 1. **Nicht jede Änderung ist ein Ereignis.** Ein Sensor, der alle fünfzehn
 *    Sekunden 21,4 °C meldet, gehört in die Kurve, nicht in die Erzählung.
 *    Aufgezeichnet wird nur, was jemand als Ereignis erkennen würde: an, aus,
 *    aufgefahren, weg, wieder da.
 * 2. **Geschrieben wird gebündelt.** Der Verlauf lebt im Speicher und wandert
 *    in Abständen als Ganzes auf die Platte. Ein Schreibvorgang je
 *    Lichtschalter wäre bei dreißig Geräten die halbe Festplatte.
 */

/** Wie viele Einträge aufbewahrt werden. */
const MAX_ENTRIES = 800;

/**
 * Wie lange gesammelt wird, bevor geschrieben wird.
 *
 * Fünf Sekunden sind kurz genug, dass nach einem Absturz höchstens die letzten
 * Sekunden fehlen – und lang genug, dass ein Szenenaufruf mit zwanzig Geräten
 * einen Schreibvorgang auslöst und nicht zwanzig.
 */
const FLUSH_DELAY_MS = 5000;

/** Zustandswechsel, die als Ereignis zählen. Alles andere ist Messwert. */
const MEANINGFUL = ['on', 'reachable', 'position', 'tilt', 'targetTemperatureC'] as const;

export interface ActivityFilter {
  kind?: ActivityKind;
  deviceId?: string;
  /** Volltext über Meldung und Zusatz. */
  search?: string;
  limit?: number;
}

export class ActivityService {
  private entries: ActivityEntry[] = [];
  private householdId: string | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private unsubscribe: Array<() => void> = [];
  /**
   * Der zuletzt gesehene Zustand einer Integration.
   *
   * Ohne dieses Gedächtnis stünde bei jedem Abgleich ein Eintrag im Verlauf –
   * „Bridge in Ordnung", alle fünfzehn Sekunden. Gemeldet wird nur der
   * *Wechsel*.
   */
  private integrationStatus = new Map<string, string>();

  /**
   * Die Lichteffekte – nachgereicht, weil sie ihrerseits Geräte brauchen.
   *
   * Sie sind hier nur für eine Frage da: Blinkt diese Lampe gerade, weil ein
   * Effekt läuft? Dann gehört das nicht in den Verlauf.
   */
  private effects: { controls(deviceId: string): boolean } | null = null;

  constructor(private readonly repos: Repositories) {}

  /** Wird beim Zusammenbau nachgereicht – siehe `effects`. */
  useEffects(effects: { controls(deviceId: string): boolean }): void {
    this.effects = effects;
  }

  start(householdId: string): void {
    this.stop();
    this.householdId = householdId;
    this.entries = this.repos.activity.listByHousehold(householdId);

    this.unsubscribe = [
      events.on('device.updated', ({ device, changed }) => this.onDeviceChanged(device, changed)),
      events.on('device.added', ({ device }) =>
        this.record('device', `„${device.name}" ist neu dazugekommen.`, { device }),
      ),
      events.on('device.removed', ({ deviceId }) =>
        this.record('device', 'Ein Gerät wurde aus dem Hub entfernt.', { deviceId }),
      ),
      events.on('automation.triggered', ({ ruleName }) =>
        this.record('automation', `Automation „${ruleName}" ausgeführt.`),
      ),
      events.on('scene.applied', ({ name, applied, failed }) =>
        this.record(
          'scene',
          failed > 0
            ? `Szene „${name}" abgerufen – ${applied} von ${applied + failed} Geräten erreicht.`
            : `Szene „${name}" abgerufen (${applied} ${applied === 1 ? 'Gerät' : 'Geräte'}).`,
          { level: failed > 0 ? 'warn' : 'info' },
        ),
      ),
      events.on('integration.updated', ({ integration }) => {
        const before = this.integrationStatus.get(integration.id);
        this.integrationStatus.set(integration.id, integration.status);
        // Nur der Wechsel ist eine Nachricht wert – siehe `integrationStatus`.
        if (before === undefined || before === integration.status) return;

        if (integration.status === 'error') {
          this.record('integration', `„${integration.name}" meldet ein Problem.`, {
            level: 'error',
            detail: integration.lastError ?? integration.name,
          });
        } else if (before === 'error') {
          this.record('integration', `„${integration.name}" antwortet wieder.`, {
            detail: integration.name,
          });
        }
      }),
      events.on('notification', ({ message, level, source }) =>
        this.record('system', message, { level, detail: source ?? 'hub' }),
      ),
    ];

    log.info('Verlauf wird mitgeschrieben', { vorhanden: this.entries.length });
  }

  stop(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe = [];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  /** Schreibt Ausstehendes weg – beim Herunterfahren. */
  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await this.repos.activity.replace(this.entries);
    } catch (err) {
      log.warn('Verlauf konnte nicht gesichert werden', { error: String(err) });
    }
  }

  list(householdId: string, filter: ActivityFilter = {}): ActivityEntry[] {
    const needle = filter.search?.trim().toLowerCase();
    const found = this.entries.filter((entry) => {
      if (entry.householdId !== householdId) return false;
      if (filter.kind && entry.kind !== filter.kind) return false;
      if (filter.deviceId && entry.deviceId !== filter.deviceId) return false;
      if (!needle) return true;
      return `${entry.message} ${entry.detail ?? ''}`.toLowerCase().includes(needle);
    });
    // Neueste zuerst: Wer den Verlauf öffnet, will wissen, was gerade war.
    return found.slice(-(filter.limit ?? 200)).reverse();
  }

  /** Wie viele Einträge es je Art gibt – für die Filterknöpfe. */
  counts(householdId: string): Record<ActivityKind | 'all', number> {
    const result = { all: 0, device: 0, automation: 0, scene: 0, integration: 0, system: 0 };
    for (const entry of this.entries) {
      if (entry.householdId !== householdId) continue;
      result.all++;
      result[entry.kind]++;
    }
    return result;
  }

  async clear(householdId: string): Promise<void> {
    this.entries = this.entries.filter((entry) => entry.householdId !== householdId);
    this.dirty = true;
    await this.flush();
  }

  // -------------------------------------------------------------------------

  /**
   * Was aus einer Gerätemeldung ein Ereignis macht.
   *
   * `changed` nennt die Felder, die sich wirklich geändert haben. Steht dort
   * nur `temperatureC`, ist das ein Messwert und gehört in die Kurve.
   */
  private onDeviceChanged(device: Device, changed: string[]): void {
    const relevant = changed.filter((key) => (MEANINGFUL as readonly string[]).includes(key));
    if (relevant.length === 0) return;

    /*
     * Läuft an dieser Lampe gerade ein Lichteffekt, bleibt der Verlauf still.
     * Eine Disco schaltet zweimal je Sekunde – nach zehn Minuten stünden
     * tausend Zeilen „Stehlampe eingeschaltet" im Verlauf, und alles andere
     * wäre aus den 800 aufbewahrten Einträgen hinausgedrängt. Dass der Effekt
     * läuft, steht ohnehin als eigene Meldung darin.
     */
    if (this.effects?.controls(device.id)) return;

    if (relevant.includes('reachable')) {
      this.record(
        'device',
        device.reachable
          ? `„${device.name}" ist wieder erreichbar.`
          : `„${device.name}" antwortet nicht mehr.`,
        { device, level: device.reachable ? 'info' : 'warn' },
      );
      return;
    }

    if (relevant.includes('on')) {
      this.record('device', `„${device.name}" ${device.state.on ? 'eingeschaltet' : 'ausgeschaltet'}.`, {
        device,
      });
      return;
    }

    if (relevant.includes('position') || relevant.includes('tilt')) {
      const position = device.state.position;
      this.record(
        'device',
        typeof position === 'number'
          ? `„${device.name}" auf ${position} % gefahren.`
          : `„${device.name}" bewegt.`,
        { device },
      );
      return;
    }

    if (relevant.includes('targetTemperatureC')) {
      const target = device.state.targetTemperatureC;
      this.record(
        'device',
        typeof target === 'number'
          ? `„${device.name}" auf ${target} °C gestellt.`
          : `„${device.name}" verstellt.`,
        { device },
      );
    }
  }

  private record(
    kind: ActivityKind,
    message: string,
    options: {
      device?: Device;
      deviceId?: string;
      roomId?: string | null;
      level?: 'info' | 'warn' | 'error';
      detail?: string | null;
    } = {},
  ): void {
    const householdId = options.device?.householdId ?? this.householdId;
    if (!householdId) return;

    this.entries.push({
      id: createId('act'),
      householdId,
      at: nowIso(),
      kind,
      message,
      level: options.level ?? 'info',
      deviceId: options.device?.id ?? options.deviceId ?? null,
      roomId: options.roomId ?? options.device?.roomId ?? null,
      detail: options.detail ?? options.device?.name ?? null,
    });

    // Ältestes zuerst weg – der Verlauf soll nicht unbegrenzt wachsen.
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, FLUSH_DELAY_MS);
    this.flushTimer.unref?.();
  }
}
