import { badRequest, upstreamError } from '../../core/errors.js';
import { clamp } from '../../core/color.js';
import { createLogger } from '../../core/logger.js';
import type {
  DeviceCommand,
  DeviceState,
  ShellyIntegrationConfig,
  ShellyIntegrationSecrets,
} from '../../core/types.js';
import { ShellyClient, type ShellyCredentials } from './client.js';
import { discoverShellyDevices } from './discovery.js';
import {
  namingFromConfig,
  parseComponentId,
  parseGen1Status,
  parseGen2Status,
  type ShellyComponent,
  type ShellyNaming,
} from './mapping.js';
import type {
  AdapterDevice,
  DiscoverOptions,
  DiscoveredIntegration,
  IntegrationAdapter,
  IntegrationContext,
  LinkRequest,
  LinkResult,
} from '../types.js';

const log = createLogger('shelly:adapter');

type ShellyContext = IntegrationContext<ShellyIntegrationConfig, ShellyIntegrationSecrets>;

/** Namen ändern sich selten – Konfiguration wird deshalb zwischengespeichert. */
const NAMING_TTL_MS = 10 * 60 * 1000;

export class ShellyAdapter implements IntegrationAdapter {
  readonly type = 'shelly' as const;
  readonly displayName = 'Shelly';

  private readonly namingCache = new Map<string, { naming: ShellyNaming; expiresAt: number }>();

  async discover(options: DiscoverOptions): Promise<DiscoveredIntegration[]> {
    return discoverShellyDevices(options);
  }

  async link(req: LinkRequest): Promise<LinkResult> {
    if (!req.host) throw badRequest('Für ein Shelly-Gerät wird eine IP-Adresse benötigt');

    const probe = await ShellyClient.probe(req.host);
    // Gen2+ erwartet immer den Benutzer "admin"; Gen1 erlaubt einen eigenen.
    const username = probe.generation === 2 ? 'admin' : (req.username ?? 'admin');

    const config: ShellyIntegrationConfig = {
      host: req.host,
      generation: probe.generation,
      deviceId: probe.deviceId,
      authRequired: probe.authRequired,
      username,
    };
    if (probe.model) config.model = probe.model;
    if (probe.firmware) config.firmware = probe.firmware;

    const secrets: ShellyIntegrationSecrets | null = req.password ? { password: req.password } : null;

    // Verbindung sofort verifizieren – so scheitert das Einrichten früh und
    // mit einer verständlichen Meldung statt erst beim ersten Poll.
    const client = this.clientFor({ config, secrets } as ShellyContext);
    await client.getStatus();

    log.info('Shelly verbunden', {
      host: req.host,
      generation: probe.generation,
      model: probe.model,
    });

    return {
      name: req.name?.trim() || probe.name || probe.app || probe.model,
      externalId: probe.deviceId,
      config,
      secrets,
    };
  }

  async test(ctx: IntegrationContext): Promise<void> {
    const status = await this.clientFor(ctx as ShellyContext).getStatus();
    if (!status || typeof status !== 'object') {
      throw upstreamError('Das Shelly-Gerät liefert keinen auswertbaren Status');
    }
  }

  async listDevices(ctx: IntegrationContext): Promise<AdapterDevice[]> {
    const shellyCtx = ctx as ShellyContext;
    const naming = await this.loadNaming(shellyCtx, true);
    const components = await this.readComponents(shellyCtx, naming);

    return components.map((component) => {
      const device: AdapterDevice = {
        externalId: component.externalId,
        name: component.name,
        manufacturer: 'Allterco Robotics (Shelly)',
        capabilities: component.capabilities,
        state: component.state,
        reachable: true,
      };
      if (shellyCtx.config.model) device.model = shellyCtx.config.model;
      if (shellyCtx.config.firmware) device.firmware = shellyCtx.config.firmware;
      return device;
    });
  }

  async readStates(ctx: IntegrationContext): Promise<Map<string, DeviceState>> {
    const shellyCtx = ctx as ShellyContext;
    const naming = await this.loadNaming(shellyCtx, false);
    const components = await this.readComponents(shellyCtx, naming);
    return new Map(components.map((component) => [component.externalId, component.state]));
  }

  async execute(
    ctx: IntegrationContext,
    externalId: string,
    command: DeviceCommand,
  ): Promise<DeviceState> {
    const shellyCtx = ctx as ShellyContext;
    const client = this.clientFor(shellyCtx);
    const { kind, channel } = parseComponentId(externalId);

    if (command.type === 'identify') {
      await client.identify(channel);
      return {};
    }

    switch (command.type) {
      case 'setPower':
      case 'toggle': {
        const isLight = kind === 'light' || kind === 'rgbw' || kind === 'rgb';
        if (!isLight && kind !== 'switch') {
          throw badRequest(`Komponente ${externalId} lässt sich nicht schalten`);
        }
        // Nur zum Umschalten muss der aktuelle Zustand bekannt sein.
        const on =
          command.type === 'setPower'
            ? command.on
            : !((await this.readComponentState(shellyCtx, externalId)).on ?? false);
        if (isLight) await client.setLight(channel, on);
        else await client.setSwitch(channel, on);
        return { on };
      }

      case 'setBrightness': {
        if (kind !== 'light' && kind !== 'rgbw' && kind !== 'rgb') {
          throw badRequest(`Komponente ${externalId} ist nicht dimmbar`);
        }
        const brightness = clamp(command.brightness, 0, 100);
        const on = brightness > 0;
        await client.setLight(channel, on, on ? brightness : undefined);
        return { on, brightness };
      }

      case 'setPosition': {
        if (kind !== 'cover') throw badRequest(`Komponente ${externalId} ist kein Rollladen`);
        const position = clamp(command.position, 0, 100);
        await client.setCoverPosition(channel, position);
        return { position };
      }

      case 'setColorTemperature':
        throw badRequest('Farbtemperatur wird von diesem Shelly-Kanal nicht unterstützt');

      case 'setColor':
        throw badRequest('Farbsteuerung wird von diesem Shelly-Kanal nicht unterstützt');

      default:
        throw badRequest(`Unbekanntes Kommando: ${(command as { type: string }).type}`);
    }
  }

  // -------------------------------------------------------------------------

  private clientFor(ctx: ShellyContext): ShellyClient {
    const password = ctx.secrets?.password;
    let credentials: ShellyCredentials | undefined;
    if (password) {
      credentials = { username: ctx.config.username ?? 'admin', password };
    }
    return new ShellyClient(ctx.config.host, ctx.config.generation, credentials);
  }

  private async readComponents(
    ctx: ShellyContext,
    naming: ShellyNaming,
  ): Promise<ShellyComponent[]> {
    const status = await this.clientFor(ctx).getStatus();
    return ctx.config.generation === 2
      ? parseGen2Status(status, naming)
      : parseGen1Status(status, naming);
  }

  private async readComponentState(ctx: ShellyContext, externalId: string): Promise<DeviceState> {
    const naming = await this.loadNaming(ctx, false);
    const components = await this.readComponents(ctx, naming);
    return components.find((component) => component.externalId === externalId)?.state ?? {};
  }

  private async loadNaming(ctx: ShellyContext, force: boolean): Promise<ShellyNaming> {
    const cached = this.namingCache.get(ctx.integration?.id ?? ctx.config.host);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.naming;

    const fallback = ctx.integration?.name ?? ctx.config.model ?? 'Shelly';
    let naming: ShellyNaming = { deviceName: fallback, channelNames: new Map() };
    try {
      const config = await this.clientFor(ctx).getConfig();
      naming = namingFromConfig(config, ctx.config.generation, fallback);
      // Der Anzeigename der Integration hat Vorrang vor dem Gerätenamen.
      if (ctx.integration?.name) naming.deviceName = ctx.integration.name;
    } catch (err) {
      log.debug('Gerätekonfiguration konnte nicht gelesen werden', {
        host: ctx.config.host,
        error: (err as Error).message,
      });
    }
    this.namingCache.set(ctx.integration?.id ?? ctx.config.host, {
      naming,
      expiresAt: Date.now() + NAMING_TTL_MS,
    });
    return naming;
  }
}
