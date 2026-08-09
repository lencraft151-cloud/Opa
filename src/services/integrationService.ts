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
import { reachableHosts, scannableHosts } from '../util/net.js';
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

/**
 * Was während einer laufenden Suche gemeldet wird.
 *
 * `progress` sagt, wer noch sucht – damit die Oberfläche zeigen kann, worauf
 * gerade gewartet wird, statt nur „bitte warten".
 */
export type DiscoveryEvent =
  | { kind: 'found'; entry: DiscoveredIntegration }
  | { kind: 'progress'; pending: IntegrationType[]; message: string }
  | { kind: 'failed'; adapter: IntegrationType; message: string }
  | { kind: 'done'; count: number };

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
    const results: DiscoveredIntegration[] = [];
    await this.discoverStream(householdId, { type, allowScan }, (event) => {
      if (event.kind === 'found') results.push(event.entry);
    });
    return results.sort((a, b) => Number(a.alreadyLinked) - Number(b.alreadyLinked));
  }

  /**
   * Wie `discover`, meldet aber jeden Treffer sofort.
   *
   * Der Grund ist Wartezeit, die sich nicht wegoptimieren lässt: Eine
   * mDNS-Suche muss die volle Zeit lauschen, wenn auf einen Diensttyp
   * *niemand* antwortet – ein schlafender Batteriesensor darf sich auch spät
   * noch melden. Fünf Sekunden vor einem leeren Kasten fühlen sich aber an wie
   * ein Fehler, und genau so wurde es auch gemeldet: „dauert lange oder geht
   * nicht".
   *
   * Also wird nicht schneller gesucht, sondern früher berichtet: Jeder
   * Hersteller meldet, sobald er fertig ist, und was er gefunden hat, steht
   * sofort auf dem Bildschirm.
   */
  async discoverStream(
    householdId: string,
    options: { type?: IntegrationType; allowScan?: boolean },
    emit: (event: DiscoveryEvent) => void,
  ): Promise<void> {
    const allowScan = options.allowScan ?? false;
    const adapters = options.type ? [this.registry.get(options.type)] : this.registry.list();
    const existing = this.list(householdId);
    const seen = new Set<string>();

    const publish = (entry: DiscoveredIntegration): void => {
      const key = `${entry.type}:${entry.host}`;
      if (seen.has(key)) return;
      seen.add(key);

      // Bereits eingebundene Geräte markieren statt ausblenden – so sieht der
      // Nutzer im Assistenten, dass die Bridge gefunden wurde.
      entry.alreadyLinked = existing.some(
        (integration) =>
          integration.type === entry.type &&
          (externalIdOf(integration) === entry.externalId ||
            (integration.config as { host?: string }).host === entry.host),
      );
      emit({ kind: 'found', entry });
    };

    /*
     * Beim gründlichen Suchen einmal feststellen, welche Adressen überhaupt
     * belegt sind – und die Liste allen Herstellern geben.
     *
     * Vorher klopfte jeder Adapter das ganze Subnetz selbst mit einer
     * HTTP-Anfrage ab: vier Hersteller × 254 Adressen, gemessene 54 Sekunden.
     * Ein TCP-Verbindungsversuch ist um Größenordnungen billiger als eine
     * HTTP-Anfrage mit Zeitüberschreitung, und danach bleiben statt 254
     * Adressen die paar übrig, hinter denen wirklich ein Gerät steht.
     */
    let scanHosts: string[] | undefined;
    if (allowScan) {
      const started = Date.now();
      const candidates = scannableHosts();
      scanHosts = await reachableHosts(candidates);
      log.info('Netz abgeklopft', {
        geprüft: candidates.length,
        belegt: scanHosts.length,
        ms: Date.now() - started,
      });
    }

    const discoverOptions = {
      timeoutMs: this.config.discoveryTimeoutMs,
      allowCloud: this.config.allowCloudDiscovery,
      allowScan,
      scanHosts,
    };

    emit({
      kind: 'progress',
      pending: adapters.map((adapter) => adapter.type),
      message: allowScan
        ? `${scanHosts?.length ?? 0} belegte Adressen im Netz – sie werden jetzt abgefragt.`
        : 'Der Hub horcht ins Netz.',
    });

    // Jeder Hersteller meldet für sich, sobald er fertig ist.
    const pending = new Set(adapters.map((adapter) => adapter.type));
    await Promise.all(
      adapters.map(async (adapter) => {
        const started = Date.now();
        try {
          for (const entry of await adapter.discover(discoverOptions)) publish(entry);
        } catch (err) {
          log.warn('Discovery fehlgeschlagen', {
            adapter: adapter.type,
            error: errorMessage(err),
          });
          emit({ kind: 'failed', adapter: adapter.type, message: errorMessage(err) });
        } finally {
          pending.delete(adapter.type);
          emit({
            kind: 'progress',
            pending: [...pending],
            message: `${adapter.displayName}: fertig nach ${Math.round(
              (Date.now() - started) / 100,
            ) / 10} s`,
          });
        }
      }),
    );

    emit({ kind: 'done', count: seen.size });
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
      updateInfo: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.repos.integrations.insert(integration);
    events.emit('integration.updated', { integration });

    const sync = await this.sync(integration.id, input.importRooms ?? true);
    return { integration: this.get(integration.id), sync };
  }

  /**
   * Erneut verbinden – mit neuen Zugangsdaten oder nach einem Knopfdruck an
   * der Bridge.
   *
   * Der entscheidende Unterschied zum Entfernen und Neuanlegen: Die
   * Integration behält ihre ID. Damit bleiben Geräte, Raumzuordnungen,
   * Szenen und Automationen erhalten – sonst müsste man nach einem
   * Passwortwechsel die halbe Wohnung neu einrichten.
   */
  async relink(
    id: string,
    input: { host?: string; username?: string; password?: string },
  ): Promise<{ integration: Integration; sync: SyncResult }> {
    const integration = this.get(id);
    const adapter = this.registry.get(integration.type);
    const host = input.host?.trim() || (integration.config as { host?: string }).host;
    if (!host) throw badRequest('Es wurde keine Adresse angegeben');

    const linkRequest: LinkRequest = { host, name: integration.name };
    if (input.username !== undefined) linkRequest.username = input.username;
    if (input.password !== undefined) linkRequest.password = input.password;

    const result = await adapter.link(linkRequest);

    const updated = await this.repos.integrations.patch(
      id,
      {
        // Der Anzeigename bleibt: Er wurde vielleicht von Hand vergeben.
        config: result.config,
        secretsEnc: result.secrets ? encryptJson(result.secrets, this.config.secretKey) : null,
        status: 'linked',
        lastError: null,
        lastSeenAt: nowIso(),
      },
      'Integration',
    );
    events.emit('integration.updated', { integration: updated });
    log.info('Integration erneut verbunden', { name: updated.name, host });

    const sync = await this.sync(id, false);
    return { integration: this.get(id), sync };
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
          capabilityOverride: null,
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

      /*
       * Die vom Gerät gemeldeten Fähigkeiten werden immer aktualisiert – ein
       * Firmware-Update kann neue bringen. Eine Richtigstellung des Nutzers
       * steht daneben und überlebt jeden Abgleich (siehe `effectiveDevice`).
       */
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
