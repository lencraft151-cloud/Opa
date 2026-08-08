import { errorSummary } from '../core/errors.js';
import { events } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import type { Device, PresenceSimulation } from '../core/types.js';
import type { Repositories } from '../storage/repositories.js';
import { isWithinTimeRange } from './automationService.js';
import type { DeviceService } from './deviceService.js';
import type { HouseholdService } from './householdService.js';
import { presenceOf } from './householdService.js';

const log = createLogger('presence');

/** Wie oft geprüft wird, ob wieder etwas passieren soll. */
const TICK_MS = 60_000;

/**
 * Urlaubsmodus.
 *
 * Eine Wohnung, in der zwei Wochen lang kein Licht angeht, ist von der Straße
 * aus als leer zu erkennen. Der Hub schaltet deshalb im gewählten Zeitfenster
 * einzelne Lichter an und aus.
 *
 * Zwei Dinge sind dabei wichtiger, als es zunächst aussieht:
 *
 * 1. **Unregelmäßigkeit.** Ein festes Muster („alle 30 Minuten") ist von
 *    außen schneller zu erkennen als gar kein Licht. Die Abstände streuen
 *    deshalb zufällig um den eingestellten Mittelwert.
 * 2. **Aufräumen.** Beim Ausschalten des Modus bleibt kein Licht an, das die
 *    Simulation eingeschaltet hat – sonst brennt es bis zur Rückkehr.
 */
export class PresenceService {
  private timer: NodeJS.Timeout | null = null;
  private householdId: string | null = null;
  /** Zeitpunkt der nächsten Schaltung. */
  private nextActionAt = 0;
  /** Geräte, die diese Simulation eingeschaltet hat. */
  private readonly switchedOn = new Set<string>();
  private busy = false;

  constructor(
    private readonly repos: Repositories,
    private readonly devices: DeviceService,
    private readonly households: HouseholdService,
  ) {}

  start(householdId: string): void {
    if (this.timer) return;
    this.householdId = householdId;
    this.timer = setInterval(() => {
      void this.tick().catch((err) =>
        log.warn('Urlaubsmodus gestolpert', { error: errorSummary(err) }),
      );
    }, TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Zustand für die Oberfläche. */
  status(): {
    settings: PresenceSimulation;
    active: boolean;
    devicesOn: number;
    candidates: number;
  } {
    const household = this.households.current();
    const settings = presenceOf(household);
    return {
      settings,
      active: Boolean(household) && settings.enabled && this.isWithinWindow(settings),
      devicesOn: this.switchedOn.size,
      candidates: household ? this.candidates(household.id, settings).length : 0,
    };
  }

  /**
   * Schaltet alles wieder aus, was die Simulation eingeschaltet hat.
   * Wird beim Abschalten des Urlaubsmodus aufgerufen.
   */
  async reset(): Promise<void> {
    for (const deviceId of [...this.switchedOn]) {
      try {
        await this.devices.execute(deviceId, { type: 'setPower', on: false });
      } catch (err) {
        log.debug('Licht ließ sich nicht ausschalten', { deviceId, error: errorSummary(err) });
      }
    }
    this.switchedOn.clear();
    this.nextActionAt = 0;
  }

  // -------------------------------------------------------------------------

  private async tick(): Promise<void> {
    if (!this.householdId || this.busy) return;
    const household = this.households.current();
    if (!household) return;

    const settings = presenceOf(household);

    if (!settings.enabled || !this.isWithinWindow(settings)) {
      // Außerhalb des Fensters (oder abgeschaltet) bleibt kein Licht an, das
      // die Simulation angemacht hat.
      if (this.switchedOn.size > 0) {
        this.busy = true;
        try {
          await this.reset();
        } finally {
          this.busy = false;
        }
      }
      return;
    }

    if (Date.now() < this.nextActionAt) return;

    this.busy = true;
    try {
      await this.act(this.householdId, settings);
    } finally {
      this.busy = false;
      this.scheduleNext(settings);
    }
  }

  /** Ein einzelner Schaltvorgang: entweder etwas an oder etwas aus. */
  private async act(householdId: string, settings: PresenceSimulation): Promise<void> {
    const candidates = this.candidates(householdId, settings);
    if (candidates.length === 0) {
      log.debug('Urlaubsmodus ohne passende Lampen');
      return;
    }

    // Solange wenig an ist, eher einschalten; sind schon einige an, eher aus.
    const share = this.switchedOn.size / candidates.length;
    const turnOn = Math.random() > Math.min(0.8, share + 0.15);

    const pool = turnOn
      ? candidates.filter((device) => !this.switchedOn.has(device.id))
      : candidates.filter((device) => this.switchedOn.has(device.id));
    if (pool.length === 0) return;

    const device = pool[Math.floor(Math.random() * pool.length)];
    if (!device) return;

    try {
      await this.devices.execute(device.id, { type: 'setPower', on: turnOn });
      if (turnOn) this.switchedOn.add(device.id);
      else this.switchedOn.delete(device.id);
      log.debug('Urlaubsmodus', { device: device.name, on: turnOn });
    } catch (err) {
      // Ein Gerät, das nicht antwortet, darf die Simulation nicht anhalten.
      log.debug('Urlaubsmodus konnte nicht schalten', {
        device: device.name,
        error: errorSummary(err),
      });
      this.switchedOn.delete(device.id);
    }
  }

  /**
   * Nächster Zeitpunkt, gestreut um den eingestellten Mittelwert.
   * Der Abstand liegt zwischen der Hälfte und dem Anderthalbfachen.
   */
  private scheduleNext(settings: PresenceSimulation): void {
    const average = settings.averageIntervalMinutes * 60_000;
    this.nextActionAt = Date.now() + average * (0.5 + Math.random());
  }

  private isWithinWindow(settings: PresenceSimulation): boolean {
    const household = this.households.current();
    if (!household) return false;
    return isWithinTimeRange(new Date(), household.timezone, settings.from, settings.to);
  }

  /**
   * Alle Lampen, die infrage kommen: schaltbar, erreichbar, sichtbar – und
   * im gewählten Raum, falls Räume angegeben sind.
   */
  private candidates(householdId: string, settings: PresenceSimulation): Device[] {
    return this.repos.devices.listByHousehold(householdId).filter((device) => {
      if (device.hidden || !device.reachable) return false;
      if (!device.capabilities.includes('switch')) return false;
      // Rollläden und Heizungen gehören nicht dazu.
      if (device.capabilities.includes('cover') || device.capabilities.includes('thermostat')) {
        return false;
      }
      if (settings.roomIds.length > 0) {
        return device.roomId !== null && settings.roomIds.includes(device.roomId);
      }
      return true;
    });
  }
}

/** Meldung beim Ein- und Ausschalten – erscheint als Hinweis in der App. */
export function announcePresence(householdId: string, enabled: boolean, candidates: number): void {
  events.emit('notification', {
    householdId,
    message: enabled
      ? `Urlaubsmodus an – ${candidates} ${candidates === 1 ? 'Lampe wird' : 'Lampen werden'} unregelmäßig geschaltet.`
      : 'Urlaubsmodus aus – alles wieder wie gewohnt.',
    level: 'info',
  });
}
