import { badRequest, notFound, upstreamError } from '../../core/errors.js';
import { clamp, clampMirek, hsvToXy, kelvinToMired } from '../../core/color.js';
import { createLogger } from '../../core/logger.js';
import type {
  DeviceCommand,
  DeviceState,
  HueIntegrationConfig,
  HueIntegrationSecrets,
  UpdateInfo,
} from '../../core/types.js';
import { sleep } from '../../util/http.js';
import { HueClient, parseEventStreamChunk, type HueLightUpdate } from './client.js';
import { discoverHueBridges } from './discovery.js';
import {
  capabilitiesFor,
  deviceNameOf,
  indexResources,
  isControllableDevice,
  isReachable,
  stateFor,
  type HueIndex,
} from './mapping.js';
import type {
  AdapterDevice,
  DiscoverOptions,
  DiscoveredIntegration,
  IntegrationAdapter,
  IntegrationContext,
  LinkRequest,
  LinkResult,
  StateUpdateHandler,
} from '../types.js';

const log = createLogger('hue:adapter');

type HueContext = IntegrationContext<HueIntegrationConfig, HueIntegrationSecrets>;

export class HueAdapter implements IntegrationAdapter {
  readonly type = 'hue' as const;
  readonly displayName = 'Philips Hue';

  /** Zuletzt gelesener Ressourcen-Index je Integration (für Kommandos/Events). */
  private readonly indexCache = new Map<string, HueIndex>();

  async discover(options: DiscoverOptions): Promise<DiscoveredIntegration[]> {
    return discoverHueBridges(options);
  }

  async link(req: LinkRequest): Promise<LinkResult> {
    if (!req.host) throw badRequest('Für eine Hue Bridge wird eine IP-Adresse benötigt');

    const config = await HueClient.fetchBridgeConfig(req.host);
    // Wirft LinkButtonRequiredError, solange der Knopf nicht gedrückt wurde.
    const key = await HueClient.createApplicationKey(req.host, config.bridgeid.slice(-6));

    const integrationConfig: HueIntegrationConfig = {
      host: req.host,
      bridgeId: config.bridgeid,
    };
    if (config.modelid) integrationConfig.modelId = config.modelid;
    if (config.apiversion) integrationConfig.apiVersion = config.apiversion;
    if (config.swversion) integrationConfig.swVersion = config.swversion;

    const secrets: HueIntegrationSecrets = { applicationKey: key.applicationKey };
    if (key.clientKey) secrets.clientKey = key.clientKey;

    log.info('Hue Bridge verbunden', { host: req.host, bridgeId: config.bridgeid });

    return {
      name: req.name?.trim() || config.name || 'Hue Bridge',
      externalId: config.bridgeid,
      config: integrationConfig,
      secrets,
    };
  }

  async test(ctx: IntegrationContext): Promise<void> {
    const client = this.clientFor(ctx as HueContext);
    const resources = await client.getResourcesOfType('bridge');
    if (resources.length === 0) throw upstreamError('Die Bridge liefert keine Daten zurück');
  }

  async listDevices(ctx: IntegrationContext): Promise<AdapterDevice[]> {
    const index = await this.refreshIndex(ctx as HueContext);
    const devices: AdapterDevice[] = [];

    for (const [deviceId, resource] of index.byId) {
      if (resource.type !== 'device') continue;
      if (!isControllableDevice(deviceId, index)) continue;

      const device: AdapterDevice = {
        externalId: deviceId,
        name: deviceNameOf(resource),
        capabilities: capabilitiesFor(deviceId, index),
        state: stateFor(deviceId, index),
        reachable: isReachable(deviceId, index),
      };
      const manufacturer = resource.product_data?.manufacturer_name;
      const model = resource.product_data?.model_id;
      const firmware = resource.product_data?.software_version;
      const room = index.roomByDevice.get(deviceId);
      if (manufacturer) device.manufacturer = manufacturer;
      if (model) device.model = model;
      if (firmware) device.firmware = firmware;
      if (room) device.suggestedRoom = room;
      devices.push(device);
    }

    return devices;
  }

  async readStates(ctx: IntegrationContext): Promise<Map<string, DeviceState>> {
    const index = await this.refreshIndex(ctx as HueContext);
    const states = new Map<string, DeviceState>();
    for (const [deviceId, resource] of index.byId) {
      if (resource.type !== 'device') continue;
      if (!isControllableDevice(deviceId, index)) continue;
      states.set(deviceId, stateFor(deviceId, index));
    }
    return states;
  }

  async execute(
    ctx: IntegrationContext,
    externalId: string,
    command: DeviceCommand,
  ): Promise<DeviceState> {
    const hueCtx = ctx as HueContext;
    const client = this.clientFor(hueCtx);

    if (command.type === 'identify') {
      await client.identifyDevice(externalId);
      return {};
    }

    const index = await this.ensureIndex(hueCtx);
    const services = index.services.get(externalId);
    const lightId = services?.light;
    if (!lightId) {
      throw badRequest(
        'Dieses Hue-Gerät lässt sich nicht schalten.',
        undefined,
        'Bewegungsmelder und Schalter liefern nur Messwerte – steuerbar sind nur Leuchten.',
      );
    }

    const current = stateFor(externalId, index);
    const { update, optimistic } = buildLightUpdate(command, current);
    await client.updateLight(lightId, update);

    // Bridge übernimmt Änderungen asynchron; der optimistische Zustand wird
    // beim nächsten Poll bzw. Event korrigiert.
    return { ...current, ...optimistic };
  }

  async subscribe(ctx: IntegrationContext, onUpdate: StateUpdateHandler): Promise<() => void> {
    const hueCtx = ctx as HueContext;
    let stopped = false;
    let currentStream: { destroy: () => void } | null = null;

    const run = async (): Promise<void> => {
      let backoffMs = 1000;
      while (!stopped) {
        try {
          const client = this.clientFor(hueCtx);
          const stream = await client.openEventStream();
          currentStream = stream;
          backoffMs = 1000;
          log.info('Hue Eventstream verbunden', { host: hueCtx.config.host });

          let buffer = '';
          for await (const chunk of stream) {
            if (stopped) break;
            buffer += (chunk as Buffer).toString('utf8');
            const { events, rest } = parseEventStreamChunk(buffer);
            buffer = rest;
            if (events.length === 0) continue;

            const index = await this.ensureIndex(hueCtx);
            const touched = new Set<string>();
            for (const event of events) {
              for (const resource of event.data ?? []) {
                // Ereignis in den Index einpflegen …
                const existing = index.byId.get(resource.id);
                index.byId.set(resource.id, { ...(existing ?? {}), ...resource });
                // … und das besitzende Gerät ermitteln.
                const ownerId =
                  resource.owner?.rtype === 'device'
                    ? resource.owner.rid
                    : index.ownerByService.get(resource.id);
                if (ownerId) touched.add(ownerId);
              }
            }
            for (const deviceId of touched) {
              if (!isControllableDevice(deviceId, index)) continue;
              onUpdate(deviceId, stateFor(deviceId, index));
            }
          }
        } catch (err) {
          if (!stopped) {
            log.warn('Hue Eventstream unterbrochen', {
              host: hueCtx.config.host,
              error: (err as Error).message,
            });
          }
        }
        currentStream = null;
        if (stopped) break;
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    };

    void run();

    return () => {
      stopped = true;
      currentStream?.destroy();
    };
  }

  // -------------------------------------------------------------------------
  // Firmware der Bridge
  // -------------------------------------------------------------------------

  async checkForUpdate(ctx: IntegrationContext): Promise<UpdateInfo> {
    const hueCtx = ctx as HueContext;
    const client = this.clientFor(hueCtx);

    // Die Bridge sucht nur auf Aufforderung nach Updates; das Ergebnis steht
    // erst beim nächsten Auslesen der Konfiguration bereit.
    try {
      await client.setSoftwareUpdate({ checkforupdate: true });
    } catch (err) {
      log.debug('Update-Suche konnte nicht angestoßen werden', {
        error: (err as Error).message,
      });
    }

    const config = await client.getFullConfig();
    const state = config.swupdate2?.state ?? 'noupdates';
    const ready = state === 'allreadytoinstall' || state === 'anyreadytoinstall';

    const info: UpdateInfo = {
      currentVersion: config.swversion ?? hueCtx.config.swVersion ?? null,
      // Hue nennt keine Zielversion – bekannt ist nur, dass etwas bereitliegt.
      availableVersion: ready ? 'bereit zur Installation' : null,
      updateAvailable: ready,
      installable: ready,
      checkedAt: new Date().toISOString(),
    };
    if (state === 'transferring') {
      info.note = 'Die Bridge lädt gerade ein Update herunter.';
    }
    return info;
  }

  async installUpdate(ctx: IntegrationContext): Promise<void> {
    const hueCtx = ctx as HueContext;
    await this.clientFor(hueCtx).setSoftwareUpdate({ install: true });
    log.info('Bridge-Update angestoßen', { host: hueCtx.config.host });
  }

  // -------------------------------------------------------------------------

  private clientFor(ctx: HueContext): HueClient {
    const key = ctx.secrets?.applicationKey;
    if (!key) {
      throw notFound(
        `Application Key der Hue Bridge ${ctx.config.host} (Integration bitte neu verbinden)`,
      );
    }
    return new HueClient(ctx.config.host, key);
  }

  private async refreshIndex(ctx: HueContext): Promise<HueIndex> {
    const resources = await this.clientFor(ctx).getAllResources();
    const index = indexResources(resources);
    this.indexCache.set(ctx.integration.id, index);
    return index;
  }

  private async ensureIndex(ctx: HueContext): Promise<HueIndex> {
    return this.indexCache.get(ctx.integration.id) ?? (await this.refreshIndex(ctx));
  }
}

/** Übersetzt ein Hub-Kommando in ein Hue-Light-Update. */
export function buildLightUpdate(
  command: DeviceCommand,
  current: DeviceState,
): { update: HueLightUpdate; optimistic: DeviceState } {
  switch (command.type) {
    case 'setPower':
      return { update: { on: { on: command.on } }, optimistic: { on: command.on } };

    case 'toggle': {
      const next = !(current.on ?? false);
      return { update: { on: { on: next } }, optimistic: { on: next } };
    }

    case 'setBrightness': {
      const brightness = clamp(command.brightness, 0, 100);
      if (brightness === 0) {
        return { update: { on: { on: false } }, optimistic: { on: false, brightness: 0 } };
      }
      return {
        update: { on: { on: true }, dimming: { brightness } },
        optimistic: { on: true, brightness },
      };
    }

    case 'setColorTemperature': {
      const kelvin = clamp(command.kelvin, 2000, 6500);
      return {
        update: { on: { on: true }, color_temperature: { mirek: clampMirek(kelvinToMired(kelvin)) } },
        optimistic: { on: true, colorTemperatureK: Math.round(kelvin) },
      };
    }

    case 'setColor': {
      const hue = ((command.hue % 360) + 360) % 360;
      const saturation = clamp(command.saturation, 0, 100);
      return {
        update: { on: { on: true }, color: { xy: hsvToXy(hue, saturation) } },
        optimistic: { on: true, hue, saturation },
      };
    }

    case 'setPosition':
    case 'openCover':
    case 'closeCover':
    case 'stopCover':
    case 'setTilt':
      throw badRequest(
        'Hue-Leuchten lassen sich nicht wie ein Rollladen fahren.',
        undefined,
        'Rollladen-Kommandos funktionieren mit Shelly-Rollladenaktoren (Fähigkeit "cover").',
      );

    default:
      throw badRequest(`Unbekanntes Kommando: ${(command as { type: string }).type}`);
  }
}
