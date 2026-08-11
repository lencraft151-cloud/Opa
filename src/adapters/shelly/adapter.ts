import { badRequest, upstreamError } from '../../core/errors.js';
import { clamp, hsvToRgb } from '../../core/color.js';
import { createLogger } from '../../core/logger.js';
import type {
  CommandOptions,
  DeviceCommand,
  DeviceState,
  ShellyIntegrationConfig,
  ShellyIntegrationSecrets,
  UpdateInfo,
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
  SkippedEntry,
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

    /*
     * Der selbst vergebene Name steht bei Gen1 nur in `/settings`, nicht in
     * `/shelly`. Ohne diesen Schritt hieße ein Gerät, das in der Shelly-App
     * „Heizung Bad" heißt, im Hub „SHTRV-01" – und alle seine Kanäle gleich
     * mit.
     */
    let configuredName: string | undefined;
    try {
      const deviceConfig = await client.getConfig();
      const naming = namingFromConfig(deviceConfig, probe.generation, '');
      if (naming.deviceName) configuredName = naming.deviceName;
    } catch (err) {
      log.debug('Gerätename konnte nicht gelesen werden', {
        host: req.host,
        error: (err as Error).message,
      });
    }

    log.info('Shelly verbunden', {
      host: req.host,
      generation: probe.generation,
      model: probe.model,
    });

    return {
      name: req.name?.trim() || configuredName || probe.name || probe.app || probe.model,
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
    options?: CommandOptions,
  ): Promise<DeviceState> {
    const shellyCtx = ctx as ShellyContext;
    const client = this.clientFor(shellyCtx);
    const { kind, channel } = parseComponentId(externalId);
    // Rollläden fahren ohnehin in ihrer eigenen Zeit; Übergänge gelten fürs Licht.
    const fade = options?.transitionMs ?? 0;

    if (command.type === 'identify') {
      await client.identify(channel);
      return {};
    }

    switch (command.type) {
      case 'setPower':
      case 'toggle': {
        const isLight = kind === 'light' || kind === 'rgbw' || kind === 'rgb';
        if (!isLight && kind !== 'switch') {
          throw badRequest(
            `Die Komponente "${externalId}" lässt sich nicht schalten.`,
            undefined,
            kind === 'cover'
              ? 'Rollläden werden über Auf/Zu/Stop oder eine Position gesteuert, nicht über Ein/Aus.'
              : 'Sensoren liefern nur Messwerte und lassen sich nicht schalten.',
          );
        }
        // Nur zum Umschalten muss der aktuelle Zustand bekannt sein.
        const on =
          command.type === 'setPower'
            ? command.on
            : !((await this.readComponentState(shellyCtx, externalId)).on ?? false);
        if (isLight) await client.setLight(channel, on, undefined, fade);
        else await client.setSwitch(channel, on);
        return { on };
      }

      case 'setBrightness': {
        if (kind !== 'light' && kind !== 'rgbw' && kind !== 'rgb') {
          throw badRequest(
            `Die Komponente "${externalId}" ist nicht dimmbar.`,
            undefined,
            'Nur Dimmer- und Lichtkanäle unterstützen Helligkeit; ein Relais kennt nur Ein und Aus.',
          );
        }
        const brightness = clamp(command.brightness, 0, 100);
        const on = brightness > 0;
        await client.setLight(channel, on, on ? brightness : undefined, fade);
        return { on, brightness };
      }

      case 'setPosition': {
        ShellyAdapter.assertCoverComponent(kind, externalId);
        const position = clamp(command.position, 0, 100);
        await client.setCoverPosition(channel, position);
        return { position, coverState: position >= 50 ? 'opening' : 'closing' };
      }

      case 'openCover': {
        ShellyAdapter.assertCoverComponent(kind, externalId);
        await client.openCover(channel);
        return { coverState: 'opening' };
      }

      case 'closeCover': {
        ShellyAdapter.assertCoverComponent(kind, externalId);
        await client.closeCover(channel);
        return { coverState: 'closing' };
      }

      case 'stopCover': {
        ShellyAdapter.assertCoverComponent(kind, externalId);
        await client.stopCover(channel);
        // Die Endposition kennt erst das Gerät – der nächste Poll liefert sie.
        return { coverState: 'stopped' };
      }

      case 'setTilt': {
        ShellyAdapter.assertCoverComponent(kind, externalId);
        const tilt = clamp(command.tilt, 0, 100);
        await client.setCoverTilt(channel, tilt);
        return { tilt };
      }

      case 'setTargetTemperature': {
        // `thermostat` ist der Regler im Gerät, `blutrv` das Ventil am
        // Bluetooth-Zugang – beide nehmen eine Solltemperatur an.
        if (kind !== 'thermostat' && kind !== 'blutrv') {
          throw badRequest(
            `Die Komponente "${externalId}" ist keine Heizung.`,
            undefined,
            'Solltemperaturen nehmen nur Thermostate an – etwa der Shelly TRV oder ein BLU TRV.',
          );
        }
        const target = clamp(command.targetTemperatureC, 4, 35);
        await client.setThermostatTarget(channel, target, kind);
        return { targetTemperatureC: target };
      }

      case 'setColorTemperature': {
        // Weißton können `cct`-Lampen (Duo) und farbfähige Lampen, die
        // zusätzlich einen Weißkanal führen (RGBW2, Bulb).
        if (kind !== 'cct' && kind !== 'light' && kind !== 'rgbw') {
          throw badRequest(
            `Die Komponente "${externalId}" kann keine Weißtöne.`,
            undefined,
            'Weißtöne beherrschen Shelly Duo und RGBW-Lampen im Weißmodus – ein Relais nicht.',
          );
        }
        const kelvin = clamp(command.kelvin, 2700, 6500);
        await client.setColorTemperature(channel, kelvin, kind, fade);
        return { colorTemperatureK: kelvin };
      }

      case 'setColor': {
        if (kind !== 'rgb' && kind !== 'rgbw' && kind !== 'light') {
          throw badRequest(
            `Die Komponente "${externalId}" kann keine Farben.`,
            undefined,
            'Farben beherrschen nur RGB- und RGBW-Kanäle.',
          );
        }
        const hue = ((command.hue % 360) + 360) % 360;
        const saturation = clamp(command.saturation, 0, 100);
        const rgb = hsvToRgb(hue, saturation, 100);
        await client.setColor(channel, [rgb.r, rgb.g, rgb.b], kind, fade);
        return { on: true, hue, saturation };
      }

      default:
        throw badRequest(`Unbekanntes Kommando: ${(command as { type: string }).type}`);
    }
  }

  /** Wirft, wenn die Komponente kein Rollladen ist. */
  private static assertCoverComponent(kind: string, externalId: string): void {
    if (kind === 'cover') return;
    throw badRequest(
      `Die Komponente "${externalId}" ist kein Rollladen.`,
      undefined,
      'Rollladen-Kommandos funktionieren nur mit Geräten, die die Fähigkeit "cover" haben.',
    );
  }

  // -------------------------------------------------------------------------
  // Firmware
  // -------------------------------------------------------------------------

  async checkForUpdate(ctx: IntegrationContext): Promise<UpdateInfo> {
    const shellyCtx = ctx as ShellyContext;
    const { current, available } = await this.clientFor(shellyCtx).checkForUpdate();
    return {
      currentVersion: current ?? shellyCtx.config.firmware ?? null,
      availableVersion: available,
      updateAvailable: available !== null && available !== current,
      installable: true,
      checkedAt: new Date().toISOString(),
    };
  }

  async installUpdate(ctx: IntegrationContext): Promise<void> {
    const shellyCtx = ctx as ShellyContext;
    await this.clientFor(shellyCtx).installUpdate();
    log.info('Firmware-Update angestoßen', { host: shellyCtx.config.host });
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
    if (ctx.config.generation !== 2) return parseGen1Status(status, naming);

    // Was der Hub nicht deuten konnte, wird gemerkt statt verschwiegen –
    // die Diagnose beantwortet damit „wo ist mein Gerät?" auch für Shelly.
    const skipped: Array<{ id: string; reason: string }> = [];
    const components = parseGen2Status(status, naming, skipped);
    this.skipped.set(ctx.integration.id, skipped);
    return components;
  }

  /** Übersprungene Bauteile der letzten Abfrage, je Integration. */
  private readonly skipped = new Map<string, Array<{ id: string; reason: string }>>();

  diagnostics(ctx: ShellyContext): SkippedEntry[] {
    return (this.skipped.get(ctx.integration.id) ?? []).map((entry) => ({
      address: entry.id,
      channelType: entry.id.split(':')[0] ?? entry.id,
      reason: entry.reason,
    }));
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
