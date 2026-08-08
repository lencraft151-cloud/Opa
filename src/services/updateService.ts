import { badRequest, errorSummary } from '../core/errors.js';
import { events } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import type { Device, Integration, UpdateInfo } from '../core/types.js';
import { nowIso } from '../util/id.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { Repositories } from '../storage/repositories.js';
import { isWithinTimeRange } from './automationService.js';
import type { HouseholdService } from './householdService.js';
import type { IntegrationService } from './integrationService.js';

const log = createLogger('updates');

/** Wie oft nach neuer Firmware gesucht wird. */
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** Wie oft geprüft wird, ob das Auto-Update-Zeitfenster erreicht ist. */
const WINDOW_TICK_MS = 5 * 60 * 1000;
/**
 * Nach einer angestoßenen Installation wird dieselbe Integration eine Weile
 * nicht erneut angefasst – das Gerät startet neu und meldet währenddessen
 * weiterhin die alte Version.
 */
const INSTALL_COOLDOWN_MS = 60 * 60 * 1000;

export interface UpdateOverview {
  integrations: Array<{
    integrationId: string;
    name: string;
    type: Integration['type'];
    status: Integration['status'];
    updateInfo: UpdateInfo | null;
    /** Unterstützt der Adapter überhaupt Firmware-Updates? */
    supported: boolean;
  }>;
  /**
   * Alle Geräte mit ihrer Firmware. Bei Hue und Homematic pflegt die Zentrale
   * die Geräte-Firmware; dann steht hier, über welche Integration das läuft.
   */
  devices: Array<{
    deviceId: string;
    name: string;
    vendor: Device['vendor'];
    model: string | null;
    firmware: string | null;
    reachable: boolean;
    integrationId: string;
    integrationName: string;
    /** Wer die Aktualisierung ausführt. */
    updatedBy: 'device' | 'bridge';
    updateAvailable: boolean;
    /** Kann der Hub für dieses Gerät überhaupt nach Firmware sehen? */
    supported: boolean;
  }>;
  updatesAvailable: number;
  autoUpdate: { enabled: boolean; from: string; to: string; timezone: string };
  lastCheckedAt: string | null;
}

/**
 * Firmware-Updates für Bridges und Geräte.
 *
 * Der Hub prüft zweimal täglich. Ist die automatische Installation aktiv,
 * werden bereitstehende Updates im gewählten Zeitfenster installiert – nachts,
 * damit ein Neustart der Bridge niemanden im Dunkeln stehen lässt.
 */
export class UpdateService {
  private checkTimer: NodeJS.Timeout | null = null;
  private windowTimer: NodeJS.Timeout | null = null;
  private householdId: string | null = null;
  private lastCheckedAt: string | null = null;
  private readonly installedAt = new Map<string, number>();
  private busy = false;

  constructor(
    private readonly repos: Repositories,
    private readonly registry: AdapterRegistry,
    private readonly integrations: IntegrationService,
    private readonly households: HouseholdService,
  ) {}

  start(householdId: string): void {
    if (this.checkTimer) return;
    this.householdId = householdId;

    this.checkTimer = setInterval(() => {
      void this.checkAll(householdId).catch((err) =>
        log.warn('Update-Prüfung fehlgeschlagen', { error: errorSummary(err) }),
      );
    }, CHECK_INTERVAL_MS);
    this.checkTimer.unref?.();

    this.windowTimer = setInterval(() => {
      void this.runAutoInstall().catch((err) =>
        log.warn('Automatische Installation fehlgeschlagen', { error: errorSummary(err) }),
      );
    }, WINDOW_TICK_MS);
    this.windowTimer.unref?.();

    // Erste Prüfung verzögert, damit sie den Start nicht ausbremst.
    const initial = setTimeout(() => {
      void this.checkAll(householdId).catch(() => undefined);
    }, 30_000);
    initial.unref?.();

    log.info('Update-Prüfung aktiv', { intervalHours: CHECK_INTERVAL_MS / 3_600_000 });
  }

  stop(): void {
    if (this.checkTimer) clearInterval(this.checkTimer);
    if (this.windowTimer) clearInterval(this.windowTimer);
    this.checkTimer = null;
    this.windowTimer = null;
  }

  // -------------------------------------------------------------------------

  overview(householdId: string): UpdateOverview {
    const household = this.households.require();
    const integrations = this.integrations.list(householdId);
    const byIntegration = new Map(integrations.map((item) => [item.id, item]));

    /*
     * Bei Shelly ist ein Gerät gleich eine Integration – es aktualisiert sich
     * selbst. Hue und Homematic verwalten ihre Geräte dagegen über die
     * Zentrale; dort führt der Weg über die Bridge.
     */
    const devices = this.repos.devices
      .listByHousehold(householdId)
      .filter((device) => !device.hidden)
      .map((device) => {
        const integration = byIntegration.get(device.integrationId);
        const updatedBy: 'device' | 'bridge' = device.vendor === 'shelly' ? 'device' : 'bridge';
        return {
          deviceId: device.id,
          name: device.name,
          vendor: device.vendor,
          model: device.model,
          firmware: device.firmware,
          reachable: device.reachable,
          integrationId: device.integrationId,
          integrationName: integration?.name ?? 'unbekannt',
          updatedBy,
          updateAvailable: integration?.updateInfo?.updateAvailable ?? false,
          supported: integration ? this.supportsUpdates(integration) : false,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'de'));

    return {
      integrations: integrations.map((integration) => ({
        integrationId: integration.id,
        name: integration.name,
        type: integration.type,
        status: integration.status,
        updateInfo: integration.updateInfo,
        supported: this.supportsUpdates(integration),
      })),
      devices,
      updatesAvailable: integrations.filter((item) => item.updateInfo?.updateAvailable).length,
      autoUpdate: {
        enabled: household.autoUpdate,
        from: household.autoUpdateFrom,
        to: household.autoUpdateTo,
        timezone: household.timezone,
      },
      lastCheckedAt: this.lastCheckedAt,
    };
  }

  supportsUpdates(integration: Integration): boolean {
    const adapter = this.registry.get(integration.type);
    return typeof adapter.checkForUpdate === 'function';
  }

  /** Prüft eine einzelne Integration und schreibt das Ergebnis weg. */
  async check(integrationId: string): Promise<UpdateInfo> {
    const integration = this.integrations.get(integrationId);
    const adapter = this.registry.get(integration.type);

    if (!adapter.checkForUpdate) {
      throw badRequest(
        `Für "${integration.name}" kann der Hub keine Firmware prüfen.`,
        undefined,
        'Diese Integration bietet keine Update-Schnittstelle an.',
      );
    }

    const info = await adapter.checkForUpdate(this.integrations.contextFor(integration));
    const previous = integration.updateInfo;
    if (previous?.lastInstallStartedAt) {
      info.lastInstallStartedAt = previous.lastInstallStartedAt;
    }

    await this.repos.integrations.patch(integrationId, { updateInfo: info }, 'Integration');

    // Nur bei neu aufgetauchten Updates melden, sonst nervt es täglich.
    if (info.updateAvailable && !previous?.updateAvailable) {
      events.emit('notification', {
        householdId: integration.householdId,
        message: `Für "${integration.name}" steht eine neue Firmware bereit${
          info.availableVersion ? ` (${info.availableVersion})` : ''
        }.`,
        level: 'info',
      });
    }

    return info;
  }

  async checkAll(householdId: string): Promise<UpdateInfo[]> {
    if (this.busy) return [];
    this.busy = true;
    const results: UpdateInfo[] = [];
    try {
      for (const integration of this.integrations.list(householdId)) {
        if (integration.status === 'disabled') continue;
        if (!this.supportsUpdates(integration)) continue;
        try {
          results.push(await this.check(integration.id));
        } catch (err) {
          log.debug('Update-Prüfung für eine Integration fehlgeschlagen', {
            integration: integration.name,
            error: errorSummary(err),
          });
        }
      }
      this.lastCheckedAt = nowIso();
    } finally {
      this.busy = false;
    }
    return results;
  }

  /** Stößt die Installation an. Das Gerät startet dabei neu. */
  async install(integrationId: string): Promise<void> {
    const integration = this.integrations.get(integrationId);
    const adapter = this.registry.get(integration.type);

    if (!adapter.installUpdate) {
      throw badRequest(
        `"${integration.name}" kann der Hub nicht selbst aktualisieren.`,
        undefined,
        'Aktualisiere das Gerät über die Hersteller-App.',
      );
    }
    if (!integration.updateInfo?.updateAvailable) {
      throw badRequest(
        `Für "${integration.name}" liegt kein Update bereit.`,
        undefined,
        'Führe zuerst eine Prüfung durch – das Ergebnis kann veraltet sein.',
      );
    }

    await adapter.installUpdate(this.integrations.contextFor(integration));
    this.installedAt.set(integrationId, Date.now());

    await this.repos.integrations.patch(
      integrationId,
      { updateInfo: { ...integration.updateInfo, lastInstallStartedAt: nowIso() } },
      'Integration',
    );

    events.emit('notification', {
      householdId: integration.householdId,
      message: `"${integration.name}" installiert die neue Firmware und startet gleich neu.`,
      level: 'info',
    });
    log.info('Update installiert', { integration: integration.name });
  }

  // -------------------------------------------------------------------------

  /** Installiert bereitstehende Updates, sobald das Zeitfenster erreicht ist. */
  private async runAutoInstall(): Promise<void> {
    if (!this.householdId) return;
    const household = this.households.current();
    if (!household?.autoUpdate) return;

    if (
      !isWithinTimeRange(
        new Date(),
        household.timezone,
        household.autoUpdateFrom,
        household.autoUpdateTo,
      )
    ) {
      return;
    }

    // Im Zeitfenster zuerst frisch prüfen – sonst würde ein tagsüber
    // gefundenes, inzwischen installiertes Update erneut angestoßen.
    await this.checkAll(this.householdId);

    for (const integration of this.integrations.list(this.householdId)) {
      if (!integration.updateInfo?.updateAvailable) continue;
      if (!integration.updateInfo.installable) continue;

      const last = this.installedAt.get(integration.id) ?? 0;
      if (Date.now() - last < INSTALL_COOLDOWN_MS) continue;

      try {
        log.info('Automatisches Update wird installiert', { integration: integration.name });
        await this.install(integration.id);
      } catch (err) {
        log.warn('Automatisches Update fehlgeschlagen', {
          integration: integration.name,
          error: errorSummary(err),
        });
      }
    }
  }
}
