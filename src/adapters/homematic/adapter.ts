import { badRequest, errorMessage, notFound } from '../../core/errors.js';
import { clamp } from '../../core/color.js';
import { createLogger } from '../../core/logger.js';
import type {
  DeviceCommand,
  DeviceState,
  HomematicIntegrationConfig,
  HomematicIntegrationSecrets,
} from '../../core/types.js';
import { mapWithConcurrency } from '../../util/http.js';
import { browse, MDNS_SERVICES } from '../../util/mdns.js';
import { isIPv4, scannableHosts } from '../../util/net.js';
import { disambiguate, HomematicClient, type HomematicChannel } from './client.js';
import {
  capabilitiesFor,
  classifyChannel,
  inferKind,
  pickPrimaryChannels,
  stateFromValues,
  targetTemperatureKey,
  tiltKey,
  type ChannelKind,
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

const log = createLogger('homematic:adapter');

type HomematicContext = IntegrationContext<
  HomematicIntegrationConfig,
  HomematicIntegrationSecrets
>;

interface ChannelEntry {
  channel: HomematicChannel;
  kind: ChannelKind;
  /** Letzte gelesene Werte – nötig, um beim Schreiben den Wertenamen zu wählen. */
  values: Record<string, unknown>;
}

/** Kanäle ändern sich selten; die Liste wird zwischengespeichert. */
const CHANNEL_TTL_MS = 10 * 60 * 1000;

export class HomematicAdapter implements IntegrationAdapter {
  readonly type = 'homematic' as const;
  readonly displayName = 'Homematic';

  private readonly clients = new Map<string, HomematicClient>();
  private readonly channelCache = new Map<
    string,
    { entries: Map<string, ChannelEntry>; expiresAt: number }
  >();
  /** Was beim letzten Einlesen liegen blieb – für die Diagnose. */
  private readonly skippedChannels = new Map<string, SkippedEntry[]>();

  async discover(options: DiscoverOptions): Promise<DiscoveredIntegration[]> {
    const hosts = new Set<string>();

    // RaspberryMatic und CCU3 melden sich per mDNS als HTTP-Dienst.
    try {
      const services = await browse(MDNS_SERVICES.http, { timeoutMs: options.timeoutMs });
      for (const service of services) {
        if (!/ccu|homematic|raspberrymatic/i.test(`${service.name} ${service.host ?? ''}`)) continue;
        const address = service.addresses.find(isIPv4);
        if (address) hosts.add(address);
      }
    } catch (err) {
      log.debug('mDNS-Suche fehlgeschlagen', { error: errorMessage(err) });
    }

    // Die alte CCU2 kennt kein mDNS – ohne Scan findet man sie nicht.
    if (options.allowScan) {
      for (const host of options.scanHosts ?? scannableHosts()) hosts.add(host);
    }

    const results = await mapWithConcurrency([...hosts], 24, async (host) => {
      try {
        const info = await HomematicClient.probe(host, Math.min(options.timeoutMs, 1500));
        const entry: DiscoveredIntegration = {
          type: 'homematic',
          host,
          externalId: `homematic-${host}`,
          name: 'Homematic Zentrale',
          model: `CCU ${info.version}`,
          authRequired: true,
          requiresLinkButton: false,
          source: options.allowScan ? 'scan' : 'mdns',
        };
        return entry;
      } catch {
        return null;
      }
    });

    return results.filter((entry): entry is DiscoveredIntegration => entry !== null);
  }

  async link(req: LinkRequest): Promise<LinkResult> {
    if (!req.host) throw badRequest('Für eine Homematic-Zentrale wird eine Adresse benötigt');
    if (!req.password) {
      throw badRequest(
        'Für die Homematic-Zentrale werden Benutzername und Passwort gebraucht.',
        undefined,
        'Nimm die Anmeldedaten der CCU-Weboberfläche; ein Benutzer mit Administratorrechten ist nötig.',
      );
    }

    const info = await HomematicClient.probe(req.host);
    const username = req.username?.trim() || 'Admin';

    const config: HomematicIntegrationConfig = {
      host: req.host,
      username,
      serial: info.serial,
      version: info.version,
    };
    const secrets: HomematicIntegrationSecrets = { password: req.password };

    // Anmeldung sofort prüfen, damit ein Tippfehler hier auffällt.
    const client = new HomematicClient(req.host, username, req.password);
    await client.version();
    await client.logout();

    log.info('Homematic-Zentrale verbunden', { host: req.host, version: info.version });

    return {
      name: req.name?.trim() || `Homematic (${req.host})`,
      externalId: config.serial ?? req.host,
      config,
      secrets,
    };
  }

  async test(ctx: IntegrationContext): Promise<void> {
    await this.clientFor(ctx as HomematicContext).version();
  }

  async listDevices(ctx: IntegrationContext): Promise<AdapterDevice[]> {
    const entries = await this.loadChannels(ctx as HomematicContext, true);

    return [...entries.values()].map((entry) => {
      const device: AdapterDevice = {
        externalId: entry.channel.address,
        name: entry.channel.name,
        manufacturer: 'eQ-3 (Homematic)',
        capabilities: capabilitiesFor(entry.kind, entry.values),
        state: stateFromValues(entry.kind, entry.values),
        reachable: true,
      };
      if (entry.channel.deviceType) device.model = entry.channel.deviceType;
      return device;
    });
  }

  async readStates(ctx: IntegrationContext): Promise<Map<string, DeviceState>> {
    const homematicCtx = ctx as HomematicContext;
    const entries = await this.loadChannels(homematicCtx, false);
    const client = this.clientFor(homematicCtx);
    const states = new Map<string, DeviceState>();

    // Die CCU verträgt keine hohe Parallelität – vier gleichzeitige Abfragen
    // sind für sie schon reichlich.
    await mapWithConcurrency([...entries.values()], 4, async (entry) => {
      try {
        const values = await client.getParamset(entry.channel.interfaceName, entry.channel.address);
        entry.values = values;
        states.set(entry.channel.address, stateFromValues(entry.kind, values));
      } catch (err) {
        log.debug('Kanal konnte nicht gelesen werden', {
          address: entry.channel.address,
          error: errorMessage(err),
        });
      }
    });

    return states;
  }

  async execute(
    ctx: IntegrationContext,
    externalId: string,
    command: DeviceCommand,
  ): Promise<DeviceState> {
    const homematicCtx = ctx as HomematicContext;
    const entries = await this.loadChannels(homematicCtx, false);
    const entry = entries.get(externalId);
    if (!entry) {
      throw notFound(
        `Kanal ${externalId} an der Homematic-Zentrale`,
        'Lies die Geräteliste neu ein – der Kanal wurde vielleicht umbenannt oder entfernt.',
      );
    }

    const client = this.clientFor(homematicCtx);
    const { interfaceName, address } = entry.channel;
    const write = (key: string, value: number | boolean, type: 'double' | 'boolean' | 'int') =>
      client.setValue(interfaceName, address, key, value, type);

    switch (command.type) {
      case 'setPower':
      case 'toggle': {
        if (entry.kind === 'switch') {
          const on =
            command.type === 'setPower'
              ? command.on
              : !(stateFromValues(entry.kind, entry.values).on ?? false);
          await write('STATE', on, 'boolean');
          return { on };
        }
        if (entry.kind === 'dimmer') {
          const current = stateFromValues(entry.kind, entry.values);
          const on = command.type === 'setPower' ? command.on : !(current.on ?? false);
          await write('LEVEL', on ? 1 : 0, 'double');
          return { on, brightness: on ? 100 : 0 };
        }
        throw badRequest(
          `Der Kanal "${entry.channel.name}" lässt sich nicht schalten.`,
          undefined,
          entry.kind === 'cover'
            ? 'Rollläden werden über Auf/Zu/Stop oder eine Position gesteuert.'
            : 'Dieser Kanal liefert nur Messwerte.',
        );
      }

      case 'setBrightness': {
        if (entry.kind !== 'dimmer') {
          throw badRequest(`Der Kanal "${entry.channel.name}" ist nicht dimmbar.`);
        }
        const brightness = clamp(command.brightness, 0, 100);
        await write('LEVEL', brightness / 100, 'double');
        return { brightness, on: brightness > 0 };
      }

      case 'setPosition': {
        assertCover(entry);
        const position = clamp(command.position, 0, 100);
        await write('LEVEL', position / 100, 'double');
        return { position, coverState: position >= 50 ? 'opening' : 'closing' };
      }

      case 'openCover': {
        assertCover(entry);
        await write('LEVEL', 1, 'double');
        return { coverState: 'opening' };
      }

      case 'closeCover': {
        assertCover(entry);
        await write('LEVEL', 0, 'double');
        return { coverState: 'closing' };
      }

      case 'stopCover': {
        assertCover(entry);
        await write('STOP', true, 'boolean');
        return { coverState: 'stopped' };
      }

      case 'setTilt': {
        assertCover(entry);
        const tilt = clamp(command.tilt, 0, 100);
        await write(tiltKey(entry.values), tilt / 100, 'double');
        return { tilt };
      }

      case 'setTargetTemperature': {
        if (entry.kind !== 'thermostat') {
          throw badRequest(
            `Der Kanal "${entry.channel.name}" ist keine Heizung.`,
            undefined,
            'Solltemperaturen nehmen nur Thermostate und Heizkörperventile an.',
          );
        }
        const target = clamp(command.targetTemperatureC, 4.5, 30.5);
        await write(targetTemperatureKey(entry.values), target, 'double');
        return { targetTemperatureC: target };
      }

      case 'setColor':
      case 'setColorTemperature':
        throw badRequest(
          'Farben werden von Homematic-Kanälen in dieser Fassung nicht unterstützt.',
          undefined,
          'Für farbiges Licht sind Hue-Leuchten und Shelly-RGBW-Kanäle vorgesehen.',
        );

      case 'identify':
        // Homematic kennt kein Identify; ein Schaltkanal lässt sich hörbar klacken.
        if (entry.kind === 'switch') {
          const current = stateFromValues(entry.kind, entry.values).on ?? false;
          await write('STATE', !current, 'boolean');
          await new Promise((resolve) => setTimeout(resolve, 600));
          await write('STATE', current, 'boolean');
        }
        return {};

      default:
        throw badRequest(`Unbekanntes Kommando: ${(command as { type: string }).type}`);
    }
  }

  // -------------------------------------------------------------------------

  /** Was beim Einlesen übersprungen wurde – beantwortet „wo ist mein Gerät?". */
  diagnostics(ctx: IntegrationContext): SkippedEntry[] {
    const key = (ctx as HomematicContext).integration?.id ?? (ctx as HomematicContext).config.host;
    return this.skippedChannels.get(key) ?? [];
  }

  private clientFor(ctx: HomematicContext): HomematicClient {
    const key = ctx.integration?.id ?? ctx.config.host;
    const existing = this.clients.get(key);
    if (existing) return existing;

    const password = ctx.secrets?.password;
    if (!password) {
      throw notFound(
        `Passwort der Homematic-Zentrale ${ctx.config.host}`,
        'Bitte die Integration neu verbinden.',
      );
    }
    const client = new HomematicClient(ctx.config.host, ctx.config.username, password);
    this.clients.set(key, client);
    return client;
  }

  /**
   * Lädt die Kanalliste inklusive erster Werte. Nur Kanäle, die der Hub
   * abbilden kann, werden behalten – eine CCU meldet pro Gerät auch
   * Dutzende reine Konfigurationskanäle.
   */
  private async loadChannels(
    ctx: HomematicContext,
    force: boolean,
  ): Promise<Map<string, ChannelEntry>> {
    const key = ctx.integration?.id ?? ctx.config.host;
    const cached = this.channelCache.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return cached.entries;

    const client = this.clientFor(ctx);
    const channels = await client.listChannels();
    const found: ChannelEntry[] = [];

    const skipped: SkippedEntry[] = [];

    await mapWithConcurrency(channels, 4, async (channel) => {
      let values: Record<string, unknown> = {};
      try {
        values = await client.getParamset(channel.interfaceName, channel.address);
      } catch (err) {
        skipped.push({
          address: channel.address,
          channelType: channel.channelType,
          reason: `nicht lesbar: ${errorMessage(err)}`,
        });
        return;
      }

      /*
       * Erst der Kanaltyp, dann die Werte. Der zweite Anlauf ist der
       * wichtige: Homematic ist seit 2010 gewachsen, und ein Kanaltyp, den
       * wir nicht kennen, hieß bisher „Gerät verschwindet wortlos".
       */
      const kind = classifyChannel(channel) ?? inferKind(values, channel.deviceType, channel.channelType);
      if (!kind) {
        skipped.push({
          address: channel.address,
          channelType: channel.channelType,
          reason: 'keine verwertbaren Werte',
        });
        return;
      }
      if (capabilitiesFor(kind, values).length === 0) {
        skipped.push({
          address: channel.address,
          channelType: channel.channelType,
          reason: 'Kanal ohne bedienbare Funktion',
        });
        return;
      }
      found.push({ channel, kind, values });
    });

    this.skippedChannels.set(key, skipped);

    /*
     * Aktoren melden bei HmIP mehrere gleichwertige Kanäle – ein Rollladen
     * hat fünf „virtual receiver“, die alle denselben Motor fahren. Ohne
     * diesen Schritt stünde er fünfmal in der Geräteliste.
     */
    const primary = pickPrimaryChannels(found);

    // Erst jetzt Namen eindeutig machen: Die fünf Empfängerkanäle eines
    // HmIP-Rollladens heißen alle gleich, übrig bleibt aber nur einer.
    const named = disambiguate(primary.map((entry) => entry.channel));
    const entries = new Map<string, ChannelEntry>();
    primary.forEach((entry, index) => {
      const channel = named[index] ?? entry.channel;
      entries.set(channel.address, { ...entry, channel });
    });

    this.channelCache.set(key, { entries, expiresAt: Date.now() + CHANNEL_TTL_MS });
    log.info('Homematic-Kanäle eingelesen', {
      host: ctx.config.host,
      gefunden: found.length,
      übernommen: entries.size,
    });
    return entries;
  }
}

function assertCover(entry: ChannelEntry): void {
  if (entry.kind === 'cover') return;
  throw badRequest(
    `Der Kanal "${entry.channel.name}" ist kein Rollladen.`,
    undefined,
    'Rollladen-Kommandos funktionieren nur mit Kanälen der Fähigkeit "cover".',
  );
}
