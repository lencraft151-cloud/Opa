import { badRequest, upstreamError } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { requestJson } from '../../util/http.js';
import { AuthenticationRequiredError } from '../types.js';

const log = createLogger('homematic:client');

/**
 * Client für die Homematic-Zentrale (CCU2, CCU3, RaspberryMatic).
 *
 * Angesprochen wird die JSON-RPC-Schnittstelle `/api/homematic.cgi`. Sie ist
 * älter und schlichter als die REST-Aufsätze mancher Zusatzpakete – genau
 * deshalb sprechen sie auch alte Zentralen. Kanäle werden über ihre Adresse
 * (`ABC1234567:1`) und einen Wertenamen (`LEVEL`, `ACTUAL_TEMPERATURE`)
 * gelesen und geschrieben.
 */

const RPC_PATH = '/api/homematic.cgi';
/** Sitzungen der CCU laufen nach etwa zehn Minuten Untätigkeit ab. */
const SESSION_TTL_MS = 8 * 60 * 1000;

export interface HomematicChannel {
  id: string;
  address: string;
  name: string;
  /** Kanaltyp, z. B. `BLIND_VIRTUAL_RECEIVER`, `CLIMATE_TRANSCEIVER`. */
  channelType: string;
  /** Auf welcher Schnittstelle der Kanal liegt (`BidCos-RF`, `HmIP-RF`, …). */
  interfaceName: string;
  deviceName: string;
  deviceType: string;
  deviceAddress: string;
}

interface RawChannel {
  id?: string;
  address?: string;
  name?: string;
  channelType?: string;
  category?: string;
  index?: number;
}

interface RawDevice {
  id?: string;
  address?: string;
  name?: string;
  type?: string;
  interface?: string;
  channels?: RawChannel[];
}

interface RpcResponse<T> {
  version?: string;
  session_id?: string | null;
  error?: { name?: string; code?: number; message?: string } | null;
  result?: T;
}

export interface HomematicInfo {
  serial: string;
  version: string;
}

export class HomematicClient {
  private sessionId: string | null = null;
  private sessionAt = 0;

  constructor(
    private readonly host: string,
    private readonly username: string,
    private readonly password: string,
    private readonly timeoutMs = 10_000,
  ) {}

  private get url(): string {
    return `http://${this.host}${RPC_PATH}`;
  }

  /**
   * Ruft eine Methode auf. Die Sitzung wird bei Bedarf angelegt und nach
   * einem Ablauf genau einmal erneuert – eine abgelaufene Sitzung ist der
   * Normalfall, nicht ein Fehler.
   */
  private async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const session = await this.ensureSession();
    try {
      return await this.rawCall<T>(method, { ...params, _session_id_: session });
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) throw err;
      log.debug('Sitzung abgelaufen – melde erneut an', { host: this.host });
      this.sessionId = null;
      const fresh = await this.ensureSession();
      return this.rawCall<T>(method, { ...params, _session_id_: fresh });
    }
  }

  private async rawCall<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const response = await requestJson<RpcResponse<T>>(this.url, {
      method: 'POST',
      json: { version: '1.1', method, params },
      timeoutMs: this.timeoutMs,
    });

    if (response.error) {
      const message = response.error.message ?? response.error.name ?? 'unbekannter Fehler';
      // Die CCU meldet eine ungültige Sitzung als gewöhnlichen Fehler.
      if (/session/i.test(message) || response.error.code === 400) {
        throw new SessionExpiredError(message);
      }
      throw upstreamError(`Die Homematic-Zentrale meldet: ${message}`, { method });
    }
    return response.result as T;
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId && Date.now() - this.sessionAt < SESSION_TTL_MS) return this.sessionId;

    const result = await requestJson<RpcResponse<string>>(this.url, {
      method: 'POST',
      json: {
        version: '1.1',
        method: 'Session.login',
        params: { username: this.username, password: this.password },
      },
      timeoutMs: this.timeoutMs,
    });

    if (result.error || !result.result) {
      throw new AuthenticationRequiredError(
        `Anmeldung an der Homematic-Zentrale ${this.host} fehlgeschlagen.`,
      );
    }
    this.sessionId = result.result;
    this.sessionAt = Date.now();
    return this.sessionId;
  }

  /** Gibt die Sitzung frei. Höflich gegenüber der Zentrale, die nur wenige zulässt. */
  async logout(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.rawCall('Session.logout', { _session_id_: this.sessionId });
    } catch {
      /* beim Beenden nicht weiter wichtig */
    }
    this.sessionId = null;
  }

  /**
   * Prüft, ob unter der Adresse eine Homematic-Zentrale erreichbar ist.
   * `CCU.getVersion` funktioniert ohne Anmeldung.
   */
  static async probe(host: string, timeoutMs = 5000): Promise<HomematicInfo> {
    const response = await requestJson<RpcResponse<string>>(`http://${host}${RPC_PATH}`, {
      method: 'POST',
      json: { version: '1.1', method: 'CCU.getVersion', params: {} },
      timeoutMs,
    });
    if (!response.result && !response.version) {
      throw upstreamError(`Unter ${host} antwortet keine Homematic-Zentrale.`, undefined,
        'Erwartet wird eine CCU2, CCU3 oder RaspberryMatic mit aktivierter JSON-API.');
    }
    return { serial: host, version: response.result ?? response.version ?? 'unbekannt' };
  }

  async listChannels(): Promise<HomematicChannel[]> {
    const devices = await this.call<RawDevice[]>('Device.listAllDetail');
    const channels: HomematicChannel[] = [];

    for (const device of devices ?? []) {
      if (!device.address) continue;
      for (const channel of device.channels ?? []) {
        if (!channel.address) continue;
        channels.push({
          id: channel.id ?? channel.address,
          address: channel.address,
          name: readableName(channel, device),
          channelType: channel.channelType ?? channel.category ?? '',
          interfaceName: device.interface ?? 'BidCos-RF',
          deviceName: device.name ?? device.address,
          deviceType: device.type ?? '',
          deviceAddress: device.address,
        });
      }
    }
    return channels;
  }

  /** Liest einen einzelnen Kanalwert. */
  async getValue(channelAddress: string, valueKey: string): Promise<unknown> {
    return this.call<unknown>('Channel.getValue', {
      address: channelAddress,
      valueKey,
    });
  }

  /**
   * Liest alle Werte eines Kanals in einem Aufruf. Deutlich sparsamer als
   * einzelne Abfragen – bei 40 Kanälen macht das den Unterschied zwischen
   * einer und vierzig Anfragen pro Durchlauf.
   */
  async getParamset(interfaceName: string, channelAddress: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>('Interface.getParamset', {
      interface: interfaceName,
      address: channelAddress,
      paramsetKey: 'VALUES',
    });
  }

  async setValue(
    interfaceName: string,
    channelAddress: string,
    valueKey: string,
    value: number | boolean | string,
    valueType: 'double' | 'boolean' | 'int' | 'string',
  ): Promise<void> {
    await this.call('Interface.setValue', {
      interface: interfaceName,
      address: channelAddress,
      valueKey,
      type: valueType,
      value,
    });
  }

  /** Fassade für den Verbindungstest. */
  async version(): Promise<string> {
    const result = await this.call<string>('CCU.getVersion');
    if (!result) throw badRequest('Die Zentrale liefert keine Versionsangabe');
    return result;
  }
}

class SessionExpiredError extends Error {}

/**
 * Aus einem Kanalnamen der CCU eine Beschriftung machen, die man vorlesen
 * kann.
 *
 * Die Zentrale benennt Kanäle als `<Gerätename>:<Kanalnummer>` – also
 * „Rollladen Wohnzimmer:4“. Die Nummer ist eine interne Angelegenheit und
 * hat auf einer Gerätekarte nichts verloren. Wurde das Gerät nie benannt,
 * steht dort stattdessen die Seriennummer (`HEQ0123456:1`); dann ist der
 * Gerätename mit Kanalnummer immer noch die bessere Auskunft.
 */
function readableName(channel: RawChannel, device: RawDevice): string {
  const raw = channel.name?.trim();
  const index = String(channel.index ?? channel.address?.split(':')[1] ?? '');
  const base = device.name ?? device.address ?? 'Homematic';

  if (raw && !/^[A-Z0-9]{8,}:\d+$/.test(raw)) {
    // Die angehängte Kanalnummer weg – „Rollladen Wohnzimmer:4“ ist für
    // niemanden verständlicher als „Rollladen Wohnzimmer“.
    const withoutIndex = raw.replace(/:\d+$/, '').trim();
    return withoutIndex || raw;
  }

  return index === '' ? base : `${base} · Kanal ${index}`;
}

/**
 * Zwei Kanäle können nach dem Kürzen gleich heißen (etwa der Klima- und der
 * Wartungskanal eines Wettersensors). Dann kommt die Kanalnummer zurück –
 * aber nur bei denen, die es wirklich betrifft.
 *
 * Angewendet wird das erst, wenn feststeht, welche Kanäle überhaupt Geräte
 * werden: Die fünf Empfängerkanäle eines HmIP-Rollladens heißen alle gleich,
 * übrig bleibt aber nur einer – der braucht dann auch keine Nummer.
 */
export function disambiguate(channels: HomematicChannel[]): HomematicChannel[] {
  const counts = new Map<string, number>();
  for (const channel of channels) counts.set(channel.name, (counts.get(channel.name) ?? 0) + 1);

  return channels.map((channel) => {
    if ((counts.get(channel.name) ?? 0) < 2) return channel;
    const index = channel.address.split(':')[1];
    return { ...channel, name: index ? `${channel.name} · Kanal ${index}` : channel.name };
  });
}
