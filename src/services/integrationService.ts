import type { AppConfig } from '../config.js';
import { badRequest, conflict, errorMessage, notFound } from '../core/errors.js';
import { events } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import type {
  Device,
  Integration,
  IntegrationConfig,
  IntegrationSecrets,
  IntegrationType,
} from '../core/types.js';
import { decryptJson, encryptJson } from '../util/crypto.js';
import { createId, nowIso } from '../util/id.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import type {
  AdapterDevice,
  DiscoveredIntegration,
  IntegrationContext,
  LinkRequest,
} from '../adapters/types.js';
import type { Repositories } from '../storage/repositories.js';
import type { RoomService } from './roomService.js';
import type { TelemetryService } from './telemetryService.js';

const log = createLogger('integrations');

export interface SyncResult {
  integrationId: string;
  added: number;
  updated: number;
  removed: number;
  devices: Device[];
}

export interface AddIntegrationInput extends LinkRequest {
  type: IntegrationType;
  /** Gefundene Geräte direkt in Räume einsortieren (Hue liefert Räume mit). */
  importRooms?: boolean;
}

export class IntegrationService {
  constructor(
    private readonly repos: Repositories,
    private readonly registry: AdapterRegistry,
    private readonly rooms: RoomService,
    private readonly telemetry: TelemetryService,
    private readonly config: AppConfig,
  ) {}

  list(householdId: string): Integration[] {
    return this.repos.integrations.listByHousehold(householdId);
  }

  get(id: string): Integration {
    return this.repos.integrations.get(id, 'Integration');
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Sucht Geräte im Netz. Ohne `type` werden alle Integrationen parallel
   * durchsucht.
   */
  async discover(
    householdId: string,
    type?: IntegrationType,
    allowScan = false,
  ): Promise<DiscoveredIntegration[]> {
    const adapters = type ? [this.registry.get(type)] : this.registry.list();
    const options = {
      timeoutMs: this.config.discoveryTimeoutMs,
      allowCloud: this.config.allowCloudDiscovery,
      allowScan,
    };

    const settled = await Promise.allSettled(
      adapters.map(async (adapter) => adapter.discover(options)),
    );

    const results: DiscoveredIntegration[] = [];
    for (const [index, outcome] of settled.entries()) {
      const adapter = adapters[index];
      if (outcome.status === 'fulfilled') {
        results.push(...outcome.value);
      } else {
        log.warn('Discovery fehlgeschlagen', {
          adapter: adapter?.type,
          error: errorMessage(outcome.reason),
        });
      }
    }

    // Bereits eingebundene Geräte markieren statt ausblenden – so sieht der
    // Nutzer im Assistenten, dass die Bridge gefunden wurde.
    const existing = this.list(householdId);
    for (const entry of results) {
      entry.alreadyLinked = existing.some(
        (integration) =>
          integration.type === entry.type &&
          (externalIdOf(integration) === entry.externalId ||
            (integration.config as { host?: string }).host === entry.host),
      );
    }

    return results.sort((a, b) => Number(a.alreadyLinked) - Number(b.alreadyLinked));
  }

  // -------------------------------------------------------------------------
  // Verbinden
  // -------------------------------------------------------------------------

  /**
   * Verbindet eine Bridge bzw. ein Gerät und importiert direkt alle davon
   * gemeldeten Geräte.
   */
  async add(
    householdId: string,
    input: AddIntegrationInput,
  ): Promise<{ integration: Integration; sync: SyncResult }> {
    const adapter = this.registry.get(input.type);
    const host = input.host?.trim();
    if (!host) throw badRequest('Es wurde keine Adresse angegeben');

    const duplicate = this.repos.integrations.findByHost(householdId, host);
    if (duplicate) {
      throw conflict(`${host} ist bereits als "${duplicate.name}" eingebunden`, {
        integrationId: duplicate.id,
      });
    }

    const linkRequest: LinkRequest = { host };
    if (input.name !== undefined) linkRequest.name = input.name;
    if (input.username !== undefined) linkRequest.username = input.username;
    if (input.password !== undefined) linkRequest.password = input.password;

    const result = await adapter.link(linkRequest);

    const integration: Integration = {
      id: createId('int'),
      householdId,
      type: input.type,
      name: result.name,
      status: 'linked',
      config: result.config,
      secretsEnc: result.secrets ? encryptJson(result.secrets, this.config.secretKey) : null,
      lastSeenAt: nowIso(),
      lastError: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.repos.integrations.insert(integration);
    events.emit('integration.updated', { integration });

    const sync = await this.sync(integration.id, input.importRooms ?? true);
    return { integration: this.get(integration.id), sync };
  }

  async rename(id: string, name: string): Promise<Integration> {
    const trimmed = name.trim();
    if (!trimmed) throw badRequest('Der Name darf nicht leer sein');
    const integration = await this.repos.integrations.patch(id, { name: trimmed }, 'Integration');
    events.emit('integration.updated', { integration });
    return integration;
  }

  async setEnabled(id: string, enabled: boolean): Promise<Integration> {
    const integration = await this.repos.integrations.patch(
      id,
      { status: enabled ? 'linked' : 'disabled' },
      'Integration',
    );
    events.emit('integration.updated', { integration });
    return integration;
  }

  /** Prüft die Verbindung und aktualisiert Status/Fehlermeldung. */
  async test(id: string): Promise<Integration> {
    const integration = this.get(id);
    const adapter = this.registry.get(integration.type);
    try {
      await adapter.test(this.contextFor(integration));
      return this.markHealthy(integration.id);
    } catch (err) {
      return this.markError(integration.id, errorMessage(err));
    }
  }

  async remove(id: string): Promise<{ removedDevices: number }> {
    const integration = this.get(id);
    for (const device of this.repos.devices.listByIntegration(id)) {
      this.telemetry.forgetDevice(device.id);
    }
    const removedDevices = await this.repos.devices.removeByIntegration(id);
    await this.repos.integrations.remove(id);
    log.info('Integration entfernt', { id, name: integration.name, removedDevices });
    return { removedDevices };
  }

  // -------------------------------------------------------------------------
  // Kontext & Synchronisierung
  // -------------------------------------------------------------------------

  /** Baut den Laufzeitkontext inklusive entschlüsselter Zugangsdaten. */
  contextFor(integration: Integration): IntegrationContext {
    let secrets: IntegrationSecrets | null = null;
    if (integration.secretsEnc) {
      try {
        secrets = decryptJson<IntegrationSecrets>(integration.secretsEnc, this.config.secretKey);
      } catch {
        throw badRequest(
          `Die Zugangsdaten für "${integration.name}" lassen sich nicht entschlüsseln. ` +
            'Stimmt SECRET_KEY noch? Andernfalls die Integration neu verbinden.',
        );
      }
    }
    return { integration, config: integration.config as IntegrationConfig, secrets };
  }

  /**
   * Gleicht die Geräte einer Integration mit dem Hub ab: neue anlegen,
   * verschwundene entfernen, Zustände aktualisieren.
   *
   * Vom Nutzer vergebene Gerätenamen und Raumzuordnungen bleiben erhalten.
   */
  async sync(integrationId: string, importRooms = true): Promise<SyncResult> {
    const integration = this.get(integrationId);
    const adapter = this.registry.get(integration.type);

    let adapterDevices: AdapterDevice[];
    try {
      adapterDevices = await adapter.listDevices(this.contextFor(integration));
    } catch (err) {
      await this.markError(integrationId, errorMessage(err));
      throw err;
    }

    const existing = this.repos.devices.listByIntegration(integrationId);
    const seen = new Set<string>();
    let added = 0;
    let updated = 0;

    for (const adapterDevice of adapterDevices) {
      seen.add(adapterDevice.externalId);
      const current = existing.find((device) => device.externalId === adapterDevice.externalId);

      if (!current) {
        let roomId: string | null = null;
        if (importRooms && adapterDevice.suggestedRoom) {
          const room = await this.rooms.ensure(integration.householdId, adapterDevice.suggestedRoom);
          roomId = room.id;
        }
        const device: Device = {
          id: createId('dev'),
          householdId: integration.householdId,
          integrationId,
          roomId,
          externalId: adapterDevice.externalId,
          vendor: integration.type,
          name: adapterDevice.name,
          manufacturer: adapterDevice.manufacturer ?? null,
          model: adapterDevice.model ?? null,
          firmware: adapterDevice.firmware ?? null,
          capabilities: adapterDevice.capabilities,
          state: { ...adapterDevice.state, updatedAt: nowIso() },
          reachable: adapterDevice.reachable,
          hidden: false,
          lastSeenAt: adapterDevice.reachable ? nowIso() : null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        };
        await this.repos.devices.insert(device);
        this.telemetry.record(device, device.state);
        events.emit('device.added', { device });
        added++;
        continue;
      }

      const patch: Partial<Device> = {
        capabilities: adapterDevice.capabilities,
        state: { ...current.state, ...adapterDevice.state, updatedAt: nowIso() },
        reachable: adapterDevice.reachable,
      };
      if (adapterDevice.model) patch.model = adapterDevice.model;
      if (adapterDevice.firmware) patch.firmware = adapterDevice.firmware;
      if (adapterDevice.manufacturer) patch.manufacturer = adapterDevice.manufacturer;
      if (adapterDevice.reachable) patch.lastSeenAt = nowIso();

      const device = await this.repos.devices.patch(current.id, patch, 'Gerät');
      this.telemetry.record(device, device.state);
      events.emit('device.updated', { device, changed: ['state', 'capabilities'] });
      updated++;
    }

    let removed = 0;
    for (const device of existing) {
      if (seen.has(device.externalId)) continue;
      await this.repos.devices.remove(device.id);
      this.telemetry.forgetDevice(device.id);
      events.emit('device.removed', { deviceId: device.id, householdId: device.householdId });
      removed++;
    }

    await this.markHealthy(integrationId);

    log.info('Integration synchronisiert', {
      integration: integration.name,
      added,
      updated,
      removed,
    });

    return {
      integrationId,
      added,
      updated,
      removed,
      devices: this.repos.devices.listByIntegration(integrationId),
    };
  }

  /** Synchronisiert alle aktiven Integrationen eines Haushalts. */
  async syncAll(householdId: string): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    for (const integration of this.list(householdId)) {
      if (integration.status === 'disabled') continue;
      try {
        results.push(await this.sync(integration.id));
      } catch (err) {
        log.warn('Synchronisierung fehlgeschlagen', {
          integration: integration.name,
          error: errorMessage(err),
        });
      }
    }
    return results;
  }

  async markHealthy(id: string): Promise<Integration> {
    const integration = await this.repos.integrations.patch(
      id,
      { status: 'linked', lastError: null, lastSeenAt: nowIso() },
      'Integration',
    );
    events.emit('integration.updated', { integration });
    return integration;
  }

  async markError(id: string, message: string): Promise<Integration> {
    const integration = await this.repos.integrations.patch(
      id,
      { status: 'error', lastError: message },
      'Integration',
    );
    events.emit('integration.updated', { integration });
    return integration;
  }

  /** Kontext eines Geräts – wird von DeviceService für Kommandos gebraucht. */
  contextForDevice(device: Device): IntegrationContext {
    const integration = this.repos.integrations.find(device.integrationId);
    if (!integration) throw notFound(`Integration ${device.integrationId}`);
    return this.contextFor(integration);
  }
}

function externalIdOf(integration: Integration): string | undefined {
  const config = integration.config as { bridgeId?: string; deviceId?: string };
  return config.bridgeId ?? config.deviceId;
}
