import { badRequest, errorMessage, notFound } from '../../core/errors.js';
import { clamp } from '../../core/color.js';
import { createLogger } from '../../core/logger.js';
import type {
  DeviceCommand,
  DeviceState,
  FritzboxIntegrationConfig,
  FritzboxIntegrationSecrets,
} from '../../core/types.js';
import { sha256Hex } from '../../util/crypto.js';
import { mapWithConcurrency } from '../../util/http.js';
import { browse, MDNS_SERVICES } from '../../util/mdns.js';
import { defaultGateways, isIPv4, scannableHosts } from '../../util/net.js';
import { children } from '../../util/xml.js';
import { FritzboxClient } from './client.js';
import { celsiusToHalfDegrees, parseDevice, type FritzDevice } from './mapping.js';
import type {
  AdapterDevice,
  DiscoverOptions,
  DiscoveredIntegration,
  IntegrationAdapter,
  IntegrationContext,
  LinkRequest,
  LinkResult,
} from '../types.js';

const log = createLogger('fritzbox:adapter');

type FritzboxContext = IntegrationContext<FritzboxIntegrationConfig, FritzboxIntegrationSecrets>;

/**
 * Adressen, unter denen eine FRITZ!Box üblicherweise erreichbar ist. `fritz.box`
 * ist der Name, den die Box selbst im Heimnetz auflöst; die beiden Adressen
 * sind die Werkseinstellungen von AVM.
 */
/**
 * Adressen, unter denen eine FRITZ!Box üblicherweise erreichbar ist.
 *
 * `fritz.box` ist der von AVM vergebene Name, die beiden IP-Adressen sind
 * Werkseinstellung und Notfalladresse. Dazu kommt zur Laufzeit der
 * tatsächliche Router – siehe `defaultGateways`. Denn die FRITZ!Box *ist* in
 * aller Regel der Router, und wer sein Netz auf `192.168.1.x` umgestellt hat,
 * fand sie über diese Liste allein nie.
 */
const KNOWN_HOSTS = ['fritz.box', 'fritz.box.', '192.168.178.1', '169.254.1.1'];

/**
 * FRITZ!Box als Smart-Home-Zentrale (experimentell).
 *
 * An der Box hängen DECT-Geräte: Schaltsteckdosen mit Verbrauchsmessung,
 * Heizkörperregler, Lampen und – über HAN-FUN – Rollläden und Melder. Die
 * Schnittstelle dafür ist gut dokumentiert und seit Jahren stabil, aber der
 * Zoo an Geräten ist groß und nicht jedes verhält sich wie beschrieben.
 * Deshalb steht diese Integration als „experimentell“ in der Oberfläche:
 * Sie funktioniert, aber sie ist weniger erprobt als Hue und Shelly.
 */
export class FritzboxAdapter implements IntegrationAdapter {
  readonly type = 'fritzbox' as const;
  readonly displayName = 'FRITZ!Box (experimentell)';

  private readonly clients = new Map<string, { client: FritzboxClient; fingerprint: string }>();

  async discover(options: DiscoverOptions): Promise<DiscoveredIntegration[]> {
    const hosts = new Set<string>(KNOWN_HOSTS);
    for (const gateway of defaultGateways()) hosts.add(gateway);

    /*
     * AVM-Boxen melden sich auch per mDNS. Das kostet nichts, was die Suche
     * nicht ohnehin täte, und findet eine Box, die weder unter ihrem Namen
     * noch als Router erreichbar ist – etwa hinter einem zweiten Router.
     */
    try {
      for (const service of await browse(MDNS_SERVICES.fritzbox, {
        timeoutMs: options.timeoutMs,
      })) {
        const address = service.addresses.find(isIPv4);
        if (address) hosts.add(address);
      }
    } catch {
      /* Ohne mDNS bleiben die bekannten Adressen. */
    }

    // Im Zweifel auch das eigene Subnetz – manche Boxen laufen unter einer
    // anderen Adresse, etwa hinter einem zweiten Router.
    if (options.allowScan) {
      for (const host of options.scanHosts ?? scannableHosts()) hosts.add(host);
    }

    const found = await mapWithConcurrency([...hosts], 16, async (host) => {
      try {
        const info = await FritzboxClient.probe(host, Math.min(options.timeoutMs, 2000));
        const entry: DiscoveredIntegration = {
          type: 'fritzbox',
          host,
          externalId: `fritzbox-${host}`,
          name: info.model,
          model: `FRITZ!OS ${info.firmware}`,
          authRequired: true,
          requiresLinkButton: false,
          source: options.allowScan ? 'scan' : 'mdns',
        };
        return entry;
      } catch {
        return null;
      }
    });

    /*
     * `fritz.box` und die IP-Adresse sind oft dieselbe Box. Doppelte Einträge
     * würden im Assistenten wie zwei Geräte aussehen – der Name gewinnt, er
     * bleibt auch nach einem Adresswechsel gültig.
     */
    const unique: DiscoveredIntegration[] = [];
    for (const entry of found) {
      if (!entry) continue;
      const alreadyByName = unique.some((other) => !isIPv4(other.host));
      if (isIPv4(entry.host) && alreadyByName) continue;
      unique.push(entry);
    }
    return unique;
  }

  async link(req: LinkRequest): Promise<LinkResult> {
    if (!req.host) throw badRequest('Für eine FRITZ!Box wird eine Adresse benötigt');
    if (!req.password) {
      /*
       * Der Benutzername ist wirklich optional: Viele Boxen sind auf
       * „Anmeldung nur mit Passwort" eingestellt, und dann gibt es gar keinen
       * einzutragen. Die Box nimmt in diesem Fall eine leere Kennung an und
       * verwendet ihren Standardbenutzer.
       */
      throw badRequest(
        'Für die FRITZ!Box wird das Passwort gebraucht.',
        undefined,
        'Das ist das Kennwort der Box-Oberfläche. Ein Benutzername ist nur nötig, wenn ' +
          'unter „System → FRITZ!Box-Benutzer" mehrere Konten angelegt sind – dann muss ' +
          'das gewählte die Berechtigung „Smart-Home-Geräte steuern" haben.',
      );
    }

    const info = await FritzboxClient.probe(req.host);
    const username = req.username?.trim() ?? '';

    const config: FritzboxIntegrationConfig = {
      host: req.host,
      username,
      model: info.model,
      firmware: info.firmware,
    };
    const secrets: FritzboxIntegrationSecrets = { password: req.password };

    // Anmeldung sofort prüfen, damit ein Tippfehler hier auffällt und nicht
    // erst beim ersten Schalten.
    const client = new FritzboxClient(req.host, username, req.password);
    await client.deviceList();
    await client.logout();

    log.info('FRITZ!Box verbunden', { host: req.host, model: info.model });

    return {
      name: req.name?.trim() || info.model,
      externalId: `fritzbox-${req.host}`,
      config,
      secrets,
    };
  }

  async test(ctx: IntegrationContext): Promise<void> {
    await this.clientFor(ctx as FritzboxContext).deviceList();
  }

  async listDevices(ctx: IntegrationContext): Promise<AdapterDevice[]> {
    const devices = await this.readDevices(ctx as FritzboxContext);

    return devices.map((device) => {
      const entry: AdapterDevice = {
        externalId: device.ain,
        name: device.name,
        manufacturer: device.manufacturer,
        capabilities: device.capabilities,
        state: device.state,
        reachable: device.present,
      };
      if (device.productName) entry.model = device.productName;
      if (device.firmware) entry.firmware = device.firmware;
      return entry;
    });
  }

  async readStates(ctx: IntegrationContext): Promise<Map<string, DeviceState>> {
    const devices = await this.readDevices(ctx as FritzboxContext);
    const states = new Map<string, DeviceState>();
    for (const device of devices) states.set(device.ain, device.state);
    return states;
  }

  async execute(
    ctx: IntegrationContext,
    externalId: string,
    command: DeviceCommand,
  ): Promise<DeviceState> {
    const client = this.clientFor(ctx as FritzboxContext);
    const ain = { ain: externalId };

    switch (command.type) {
      case 'setPower':
        await client.command(command.on ? 'setswitchon' : 'setswitchoff', ain);
        return { on: command.on };

      case 'toggle': {
        const result = await client.command('setswitchtoggle', ain);
        return { on: result.trim() === '1' };
      }

      case 'setBrightness': {
        // AVM erwartet 0..255, nicht Prozent.
        const level = Math.round((clamp(command.brightness, 0, 100) / 100) * 255);
        await client.command('setlevel', { ...ain, level: String(level) });
        if (command.brightness > 0) await client.command('setsimpleonoff', { ...ain, onoff: '1' });
        return { brightness: command.brightness, on: command.brightness > 0 };
      }

      case 'setColorTemperature': {
        // Die Box nimmt nur bestimmte Stufen an und rundet sonst selbst.
        const kelvin = Math.round(clamp(command.kelvin, 2700, 6500));
        await client.command('setcolortemperature', {
          ...ain,
          temperature: String(kelvin),
          duration: '0',
        });
        return { colorTemperatureK: kelvin, on: true };
      }

      case 'setColor': {
        await client.command('setcolor', {
          ...ain,
          hue: String(Math.round(clamp(command.hue, 0, 359))),
          saturation: String(Math.round((clamp(command.saturation, 0, 100) / 100) * 255)),
          duration: '0',
        });
        return { hue: command.hue, saturation: command.saturation, on: true };
      }

      case 'setTargetTemperature': {
        await client.command('sethkrtsoll', {
          ...ain,
          param: String(celsiusToHalfDegrees(command.targetTemperatureC)),
        });
        return { targetTemperatureC: command.targetTemperatureC };
      }

      case 'openCover':
        await client.command('setblind', { ...ain, target: 'open' });
        return { coverState: 'opening' };

      case 'closeCover':
        await client.command('setblind', { ...ain, target: 'close' });
        return { coverState: 'closing' };

      case 'stopCover':
        await client.command('setblind', { ...ain, target: 'stop' });
        return { coverState: 'stopped' };

      case 'setPosition': {
        // AVM zählt umgekehrt: 0 ist offen, 100 ist geschlossen.
        const level = Math.round(100 - clamp(command.position, 0, 100));
        await client.command('setlevelpercentage', { ...ain, level: String(level) });
        return { position: command.position };
      }

      case 'setTilt':
        throw badRequest(
          'Lamellen lassen sich über die FRITZ!Box nicht verstellen.',
          undefined,
          'Die Box kennt bei Rollläden nur die Höhe.',
        );

      case 'identify':
        // Die AHA-Schnittstelle kennt kein „blinken“.
        throw badRequest(
          'Die FRITZ!Box kann ein Gerät nicht blinken lassen.',
          undefined,
          'Schalte es zum Wiedererkennen kurz aus und wieder ein.',
        );

      default: {
        const unreachable: never = command;
        throw badRequest(`Unbekanntes Kommando: ${JSON.stringify(unreachable)}`);
      }
    }
  }

  // -------------------------------------------------------------------------

  private async readDevices(ctx: FritzboxContext): Promise<FritzDevice[]> {
    const root = await this.clientFor(ctx).deviceList();
    const devices: FritzDevice[] = [];

    // Gruppen sind für den Hub gewöhnliche Geräte – wer in der FRITZ!App
    // eine Gruppe angelegt hat, will sie hier auch schalten können.
    for (const node of [...children(root, 'device'), ...children(root, 'group')]) {
      try {
        const device = parseDevice(node);
        if (device) devices.push(device);
      } catch (err) {
        log.debug('Gerät übersprungen', {
          ain: node.attrs['identifier'],
          error: errorMessage(err),
        });
      }
    }

    return devices;
  }

  /**
   * Der Sitzungshalter zu dieser Box.
   *
   * Wiederverwendet wird er aus einem handfesten Grund: Eine FRITZ!Box zählt
   * Anmeldungen. Für jede Abfrage neu anzumelden – alle paar Sekunden – sieht
   * für die Box aus wie ein Angriff, und sie sperrt irgendwann.
   *
   * Neu gebaut wird er, sobald sich Adresse, Benutzername oder Kennwort
   * ändern. Ohne diesen Vergleich hätte ein „Erneut verbinden" mit
   * berichtigtem Kennwort keine Wirkung: Der Hub liefe weiter mit dem alten,
   * inklusive dessen Wartezeit.
   */
  private clientFor(ctx: FritzboxContext): FritzboxClient {
    const key = ctx.integration?.id ?? ctx.config.host;

    if (!ctx.secrets?.password) {
      throw notFound(
        `Zugangsdaten der FRITZ!Box ${ctx.config.host}`,
        'Verbinde die Box in den Einstellungen erneut – das Passwort fehlt.',
      );
    }

    const fingerprint = sha256Hex(
      `${ctx.config.host}|${ctx.config.username}|${ctx.secrets.password}`,
    );
    const existing = this.clients.get(key);
    if (existing && existing.fingerprint === fingerprint) return existing.client;

    const client = new FritzboxClient(
      ctx.config.host,
      ctx.config.username,
      ctx.secrets.password,
    );
    this.clients.set(key, { client, fingerprint });
    return client;
  }
}
