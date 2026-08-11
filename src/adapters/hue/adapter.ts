import { badRequest, notFound, upstreamError } from '../../core/errors.js';
import { clamp, clampMirek, hsvToXy, kelvinToMired } from '../../core/color.js';
import { createLogger } from '../../core/logger.js';
import type {
  CommandOptions,
  DeviceCommand,
  DeviceState,
  HueIntegrationConfig,
  HueIntegrationSecrets,
  UpdateInfo,
} from '../../core/types.js';
import { MAX_TRANSITION_MS } from '../../core/types.js';
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
import {
  buildV1Devices,
  degreesToHue,
  parseV1ExternalId,
  percentToBri,
  percentToSat,
  type HueV1Group,
  type HueV1Light,
  type HueV1Sensor,
} from './v1mapping.js';
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

    /*
     * Erst mit gültigem Schlüssel lässt sich prüfen, welche API die Bridge
     * spricht. Die alte runde BSB001 kennt nur die V1 – ohne diese Prüfung
     * erschiene sie als „verbunden, aber ohne Geräte“.
     */
    const probe = new HueClient(req.host, key.applicationKey);
    integrationConfig.protocol = (await probe.supportsV2()) ? 'v2' : 'v1';

    log.info('Hue Bridge verbunden', {
      host: req.host,
      bridgeId: config.bridgeid,
      protokoll: integrationConfig.protocol,
    });

    return {
      name: req.name?.trim() || config.name || 'Hue Bridge',
      externalId: config.bridgeid,
      config: integrationConfig,
      secrets,
    };
  }

  async test(ctx: IntegrationContext): Promise<void> {
    const hueCtx = ctx as HueContext;
    const client = this.clientFor(hueCtx);
    if (usesV1(hueCtx)) {
      const state = await client.getV1State();
      if (Object.keys(state.lights).length === 0 && Object.keys(state.sensors).length === 0) {
        throw upstreamError('Die Bridge liefert keine Geräte zurück');
      }
      return;
    }
    const resources = await client.getResourcesOfType('bridge');
    if (resources.length === 0) throw upstreamError('Die Bridge liefert keine Daten zurück');
  }

  async listDevices(ctx: IntegrationContext): Promise<AdapterDevice[]> {
    if (usesV1(ctx as HueContext)) return this.listV1Devices(ctx as HueContext);

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
    if (usesV1(ctx as HueContext)) {
      const devices = await this.listV1Devices(ctx as HueContext);
      return new Map(devices.map((device) => [device.externalId, device.state]));
    }

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
    options?: CommandOptions,
  ): Promise<DeviceState> {
    const hueCtx = ctx as HueContext;
    const client = this.clientFor(hueCtx);

    if (usesV1(hueCtx)) return this.executeV1(hueCtx, externalId, command, options);

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
    const { update, optimistic } = buildLightUpdate(command, current, options?.transitionMs ?? 0);
    await client.updateLight(lightId, update);

    // Bridge übernimmt Änderungen asynchron; der optimistische Zustand wird
    // beim nächsten Poll bzw. Event korrigiert.
    return { ...current, ...optimistic };
  }

  // -------------------------------------------------------------------------
  // API v1 (alte runde Bridge)
  // -------------------------------------------------------------------------

  private async listV1Devices(ctx: HueContext): Promise<AdapterDevice[]> {
    const state = await this.clientFor(ctx).getV1State();
    return buildV1Devices({
      lights: state.lights as Record<string, HueV1Light>,
      sensors: state.sensors as Record<string, HueV1Sensor>,
      groups: state.groups as Record<string, HueV1Group>,
    });
  }

  private async executeV1(
    ctx: HueContext,
    externalId: string,
    command: DeviceCommand,
    options?: CommandOptions,
  ): Promise<DeviceState> {
    const parsed = parseV1ExternalId(externalId);
    if (!parsed || parsed.kind !== 'light') {
      throw badRequest(
        'Dieses Hue-Gerät lässt sich nicht schalten.',
        undefined,
        'Sensoren und Schalter liefern nur Messwerte – steuerbar sind nur Leuchten.',
      );
    }

    const client = this.clientFor(ctx);
    if (command.type === 'identify') {
      await client.alertV1Light(parsed.id);
      return {};
    }

    const { body, optimistic } = buildV1LightUpdate(command, options?.transitionMs ?? 0);
    await client.setV1LightState(parsed.id, body);
    return optimistic;
  }

  async subscribe(ctx: IntegrationContext, onUpdate: StateUpdateHandler): Promise<() => void> {
    const hueCtx = ctx as HueContext;
    // Die V1-API hat keinen Ereignisstrom – dort bleibt es beim Abfragen.
    if (usesV1(hueCtx)) return () => undefined;
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

/** Spricht diese Bridge nur die alte V1-API? */
function usesV1(ctx: HueContext): boolean {
  return ctx.config.protocol === 'v1';
}

/**
 * Übersetzt ein Hub-Kommando in einen V1-Lichtzustand.
 * Die V1 rechnet in eigenen Einheiten: Helligkeit 0..254, Farbton 0..65535.
 */
export function buildV1LightUpdate(
  command: DeviceCommand,
  transitionMs = 0,
): {
  body: Record<string, unknown>;
  optimistic: DeviceState;
} {
  /*
   * Die alte API rechnet Übergänge in Zehntelsekunden – und rundet nicht
   * selbst: Aus 450 ms würde ohne diese Zeile `transitiontime: 45`, also
   * viereinhalb Sekunden. Beim Ausschalten bleibt es beim Sprung, sonst
   * meldete der Hub „aus", während die Lampe noch leuchtet.
   */
  const fade = (body: Record<string, unknown>): Record<string, unknown> =>
    transitionMs > 0 && body['on'] !== false
      ? { ...body, transitiontime: Math.round(Math.min(transitionMs, MAX_TRANSITION_MS) / 100) }
      : body;

  switch (command.type) {
    case 'setPower':
      return { body: fade({ on: command.on }), optimistic: { on: command.on } };

    case 'toggle':
      // Die V1 kennt kein Umschalten; der Aufrufer kennt den Zustand.
      throw badRequest(
        'Umschalten wird von dieser alten Bridge nicht direkt unterstützt.',
        undefined,
        'Sende stattdessen Ein oder Aus.',
      );

    case 'setBrightness': {
      const brightness = clamp(command.brightness, 0, 100);
      if (brightness === 0) return { body: { on: false }, optimistic: { on: false, brightness: 0 } };
      return {
        body: fade({ on: true, bri: percentToBri(brightness) }),
        optimistic: { on: true, brightness },
      };
    }

    case 'setColorTemperature': {
      const kelvin = clamp(command.kelvin, 2000, 6500);
      return {
        body: fade({ on: true, ct: clampMirek(kelvinToMired(kelvin)) }),
        optimistic: { on: true, colorTemperatureK: Math.round(kelvin) },
      };
    }

    case 'setColor': {
      const hue = ((command.hue % 360) + 360) % 360;
      const saturation = clamp(command.saturation, 0, 100);
      return {
        body: fade({ on: true, hue: degreesToHue(hue), sat: percentToSat(saturation) }),
        optimistic: { on: true, hue, saturation },
      };
    }

    default:
      throw badRequest(
        'Dieses Kommando passt nicht zu einer Hue-Leuchte.',
        undefined,
        'Rollläden und Heizungen werden von Shelly- und Homematic-Geräten bedient.',
      );
  }
}

/**
 * Übersetzt ein Hub-Kommando in ein Hue-Light-Update.
 *
 * `transitionMs` gibt die Bridge als `dynamics.duration` an die Leuchte
 * weiter. Beim Ausschalten bleibt es außen vor: Eine Lampe, die über drei
 * Sekunden „aus" geht, ist für den Hub bereits aus, während sie noch leuchtet
 * – und der nächste Abgleich meldete dann einen Zustand, den niemand sieht.
 */
export function buildLightUpdate(
  command: DeviceCommand,
  current: DeviceState,
  transitionMs = 0,
): { update: HueLightUpdate; optimistic: DeviceState } {
  const fade = (update: HueLightUpdate): HueLightUpdate =>
    transitionMs > 0 && update.on?.on !== false
      ? { ...update, dynamics: { duration: Math.min(transitionMs, MAX_TRANSITION_MS) } }
      : update;

  switch (command.type) {
    case 'setPower':
      return { update: fade({ on: { on: command.on } }), optimistic: { on: command.on } };

    case 'toggle': {
      const next = !(current.on ?? false);
      return { update: fade({ on: { on: next } }), optimistic: { on: next } };
    }

    case 'setBrightness': {
      const brightness = clamp(command.brightness, 0, 100);
      if (brightness === 0) {
        return { update: { on: { on: false } }, optimistic: { on: false, brightness: 0 } };
      }
      return {
        update: fade({ on: { on: true }, dimming: { brightness } }),
        optimistic: { on: true, brightness },
      };
    }

    case 'setColorTemperature': {
      const kelvin = clamp(command.kelvin, 2000, 6500);
      return {
        update: fade({
          on: { on: true },
          color_temperature: { mirek: clampMirek(kelvinToMired(kelvin)) },
        }),
        optimistic: { on: true, colorTemperatureK: Math.round(kelvin) },
      };
    }

    case 'setColor': {
      const hue = ((command.hue % 360) + 360) % 360;
      const saturation = clamp(command.saturation, 0, 100);
      return {
        update: fade({ on: { on: true }, color: { xy: hsvToXy(hue, saturation) } }),
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
