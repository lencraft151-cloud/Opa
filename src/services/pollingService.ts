import type { AppConfig } from '../config.js';
import { errorMessage } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { Integration } from '../core/types.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { Repositories } from '../storage/repositories.js';
import type { DeviceService } from './deviceService.js';
import type { IntegrationService } from './integrationService.js';
import type { TelemetryService } from './telemetryService.js';

const log = createLogger('polling');

/** Wie oft neue/entfernte Geräte gesucht werden. */
const SYNC_INTERVAL_MS = 10 * 60 * 1000;
/** Wie oft alte Messwertdateien aufgeräumt werden. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/**
 * Integrationen mit funktionierendem Push-Kanal (Hue Eventstream) werden nur
 * jeden n-ten Durchlauf zusätzlich abgefragt – als Sicherheitsnetz gegen
 * verpasste Events.
 */
const POLL_DIVISOR_WITH_PUSH = 8;

export class PollingService {
  private timer: NodeJS.Timeout | null = null;
  private syncTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private readonly unsubscribers = new Map<string, () => void>();
  private tickCount = 0;
  private running = false;
  /** Takt, mit dem gerade gearbeitet wird – für `restart` und die Anzeige. */
  private intervalSeconds = 0;
  private busy = false;

  constructor(
    private readonly repos: Repositories,
    private readonly registry: AdapterRegistry,
    private readonly integrations: IntegrationService,
    private readonly devices: DeviceService,
    private readonly telemetry: TelemetryService,
    private readonly config: AppConfig,
  ) {}

  /**
   * Übernimmt einen geänderten Takt, ohne den Rest anzuhalten.
   *
   * Ein `setInterval` lässt sich nicht umstellen; es muss neu gesetzt werden.
   * Deshalb hier stoppen und starten – die Abonnements auf Push-Ereignisse
   * werden dabei mit neu aufgebaut, was nach einer Änderung ohnehin richtig
   * ist.
   */
  async applyInterval(householdId: string, seconds: number): Promise<void> {
    if (!this.running || seconds === this.intervalSeconds) return;
    await this.stop();
    await this.start(householdId);
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(householdId: string): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.attachSubscriptions(householdId);

    /*
     * Der Takt steht am Haushalt, nicht mehr nur in der Umgebung: Wer den
     * Rollladen von Hand bewegt, will das schneller sehen; wer dreißig Lampen
     * an einer Bridge hat, will sie nicht alle fünf Sekunden fragen. Fehlt
     * die Angabe (alter Datenstand), gilt weiter die Umgebungsvariable.
     */
    const household = this.repos.households.find(householdId);
    const seconds = household?.pollIntervalSeconds ?? this.config.pollIntervalSeconds;
    this.intervalSeconds = seconds;
    const intervalMs = seconds * 1000;
    this.timer = setInterval(() => {
      void this.tick(householdId);
    }, intervalMs);
    this.timer.unref?.();

    this.syncTimer = setInterval(() => {
      void this.integrations.syncAll(householdId).catch((err) => {
        log.warn('Periodische Synchronisierung fehlgeschlagen', { error: errorMessage(err) });
      });
      void this.attachSubscriptions(householdId);
    }, SYNC_INTERVAL_MS);
    this.syncTimer.unref?.();

    this.pruneTimer = setInterval(() => {
      void this.telemetry.prune();
    }, PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();

    log.info('Geräteabfrage gestartet', { intervalSeconds: seconds });

    // Erster Durchlauf sofort, damit das Dashboard nicht leer startet.
    void this.tick(householdId);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.timer = null;
    this.syncTimer = null;
    this.pruneTimer = null;

    for (const [id, unsubscribe] of this.unsubscribers) {
      try {
        unsubscribe();
      } catch (err) {
        log.debug('Abmelden vom Push-Kanal fehlgeschlagen', { id, error: errorMessage(err) });
      }
    }
    this.unsubscribers.clear();
    await this.telemetry.flush();
    log.info('Geräteabfrage gestoppt');
  }

  /** Einzelner Abfragedurchlauf über alle aktiven Integrationen. */
  async tick(householdId: string): Promise<void> {
    if (this.busy) {
      log.debug('Vorheriger Durchlauf läuft noch – überspringe');
      return;
    }
    this.busy = true;
    this.tickCount++;

    try {
      for (const integration of this.integrations.list(householdId)) {
        if (integration.status === 'disabled') continue;
        if (this.shouldSkip(integration)) continue;
        await this.pollIntegration(integration);
      }
      await this.telemetry.flush();
    } finally {
      this.busy = false;
    }
  }

  private shouldSkip(integration: Integration): boolean {
    if (!this.unsubscribers.has(integration.id)) return false;
    return this.tickCount % POLL_DIVISOR_WITH_PUSH !== 0;
  }

  private async pollIntegration(integration: Integration): Promise<void> {
    const adapter = this.registry.get(integration.type);
    try {
      const states = await adapter.readStates(this.integrations.contextFor(integration));
      for (const [externalId, state] of states) {
        const device = this.repos.devices.findByExternalId(integration.id, externalId);
        if (!device) continue; // taucht beim nächsten Sync auf
        await this.devices.applyState(device.id, state, true);
      }
      if (integration.status === 'error') await this.integrations.markHealthy(integration.id);
    } catch (err) {
      const message = errorMessage(err);
      if (integration.lastError !== message) {
        log.warn('Integration nicht erreichbar', { name: integration.name, error: message });
      }
      await this.integrations.markError(integration.id, message);
      await this.devices.markIntegrationUnreachable(integration.id);
    }
  }

  /** Meldet den Hub bei allen Integrationen mit Push-Unterstützung an. */
  private async attachSubscriptions(householdId: string): Promise<void> {
    for (const integration of this.integrations.list(householdId)) {
      if (integration.status === 'disabled') {
        this.detach(integration.id);
        continue;
      }
      if (this.unsubscribers.has(integration.id)) continue;

      const adapter = this.registry.get(integration.type);
      if (!adapter.subscribe) continue;

      try {
        const unsubscribe = await adapter.subscribe(
          this.integrations.contextFor(integration),
          (externalId, state) => {
            const device = this.repos.devices.findByExternalId(integration.id, externalId);
            if (!device) return;
            void this.devices.applyState(device.id, state, true).catch((err) => {
              log.debug('Push-Update konnte nicht übernommen werden', {
                device: device.name,
                error: errorMessage(err),
              });
            });
          },
        );
        this.unsubscribers.set(integration.id, unsubscribe);
        log.info('Push-Kanal aktiv', { integration: integration.name });
      } catch (err) {
        log.debug('Push-Kanal nicht verfügbar', {
          integration: integration.name,
          error: errorMessage(err),
        });
      }
    }

    // Abos entfernter Integrationen aufräumen.
    const known = new Set(this.integrations.list(householdId).map((item) => item.id));
    for (const id of [...this.unsubscribers.keys()]) {
      if (!known.has(id)) this.detach(id);
    }
  }

  private detach(integrationId: string): void {
    const unsubscribe = this.unsubscribers.get(integrationId);
    if (!unsubscribe) return;
    try {
      unsubscribe();
    } catch {
      /* egal */
    }
    this.unsubscribers.delete(integrationId);
  }
}
