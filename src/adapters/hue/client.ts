import type { IncomingMessage } from 'node:http';
import { createLogger } from '../../core/logger.js';
import { upstreamError } from '../../core/errors.js';
import { openStream, request, requestJson } from '../../util/http.js';
import { LinkButtonRequiredError } from '../types.js';

const log = createLogger('hue:client');

// ---------------------------------------------------------------------------
// Typen der Hue CLIP API v2
// ---------------------------------------------------------------------------

export interface HueResourceRef {
  rid: string;
  rtype: string;
}

export interface HueResource {
  id: string;
  type: string;
  id_v1?: string;
  owner?: HueResourceRef;
  metadata?: { name?: string; archetype?: string };
  product_data?: {
    model_id?: string;
    manufacturer_name?: string;
    product_name?: string;
    software_version?: string;
  };
  services?: HueResourceRef[];
  children?: HueResourceRef[];
  on?: { on: boolean };
  dimming?: { brightness: number; min_dim_level?: number };
  color_temperature?: { mirek: number | null; mirek_valid?: boolean };
  color?: { xy?: { x: number; y: number } };
  temperature?: {
    temperature?: number;
    temperature_valid?: boolean;
    temperature_report?: { changed: string; temperature: number };
  };
  motion?: {
    motion?: boolean;
    motion_valid?: boolean;
    motion_report?: { changed: string; motion: boolean };
  };
  light?: {
    light_level?: number;
    light_level_valid?: boolean;
    light_level_report?: { changed: string; light_level: number };
  };
  power_state?: { battery_level?: number; battery_state?: string };
  status?: string;
  enabled?: boolean;
}

interface HueEnvelope<T> {
  errors?: Array<{ description: string }>;
  data: T;
}

export interface HueBridgeConfig {
  name: string;
  bridgeid: string;
  modelid?: string;
  apiversion?: string;
  swversion?: string;
  mac?: string;
}

/** Ausschnitt aus `GET /api/<key>/config` – nur die Firmware-Felder. */
export interface HueFullConfig {
  name?: string;
  swversion?: string;
  apiversion?: string;
  bridgeid?: string;
  swupdate2?: {
    /** `noupdates` | `transferring` | `anyreadytoinstall` | `allreadytoinstall` */
    state?: string;
    checkforupdate?: boolean;
    lastchange?: string;
    autoinstall?: { on?: boolean; updatetime?: string };
    bridge?: { state?: string; lastinstall?: string };
  };
}

export interface HueLightUpdate {
  on?: { on: boolean };
  dimming?: { brightness: number };
  color_temperature?: { mirek: number };
  color?: { xy: { x: number; y: number } };
  alert?: { action: 'breathe' };
  identify?: { action: 'identify' };
}

const APP_NAME = 'smarthome-hub';

/**
 * Client für die Philips Hue Bridge.
 *
 * Das Pairing läuft über die V1-API (`POST /api`), alle weiteren Zugriffe über
 * die CLIP-API v2 (`/clip/v2/resource`). Hue Bridges liefern ein
 * selbstsigniertes Zertifikat aus, deshalb `insecureTLS`.
 */
export class HueClient {
  constructor(
    private readonly host: string,
    private readonly applicationKey?: string,
    private readonly timeoutMs = 8000,
  ) {}

  private get baseV2(): string {
    return `https://${this.host}/clip/v2`;
  }

  private headers(): Record<string, string> {
    if (!this.applicationKey) throw upstreamError('Es wurde kein Hue Application Key hinterlegt');
    return { 'hue-application-key': this.applicationKey };
  }

  // -------------------------------------------------------------------------
  // Pairing / Bridge-Infos (unauthentifiziert)
  // -------------------------------------------------------------------------

  /**
   * Liest die öffentliche Bridge-Konfiguration. Funktioniert ohne Application
   * Key und dient dazu, eine IP-Adresse als Hue Bridge zu identifizieren.
   */
  static async fetchBridgeConfig(host: string, timeoutMs = 4000): Promise<HueBridgeConfig> {
    const attempts: Array<{ url: string; insecureTLS: boolean }> = [
      { url: `https://${host}/api/config`, insecureTLS: true },
      { url: `http://${host}/api/config`, insecureTLS: false },
    ];
    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const config = await requestJson<HueBridgeConfig>(attempt.url, {
          timeoutMs,
          insecureTLS: attempt.insecureTLS,
        });
        if (!config?.bridgeid) throw upstreamError(`${host} ist keine Hue Bridge`);
        return config;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : upstreamError(`${host} antwortet nicht`);
  }

  /**
   * Erzeugt einen Application Key. Schlägt mit {@link LinkButtonRequiredError}
   * fehl, solange der Knopf auf der Bridge nicht gedrückt wurde.
   */
  static async createApplicationKey(
    host: string,
    instanceName = 'hub',
    timeoutMs = 8000,
  ): Promise<{ applicationKey: string; clientKey?: string }> {
    const payload = {
      devicetype: `${APP_NAME}#${instanceName}`.slice(0, 40),
      generateclientkey: true,
    };

    const attempts: Array<{ url: string; insecureTLS: boolean }> = [
      { url: `https://${host}/api`, insecureTLS: true },
      { url: `http://${host}/api`, insecureTLS: false },
    ];

    let lastError: unknown;
    for (const attempt of attempts) {
      try {
        const response = await requestJson<
          Array<{
            success?: { username: string; clientkey?: string };
            error?: { type: number; description: string };
          }>
        >(attempt.url, {
          method: 'POST',
          json: payload,
          timeoutMs,
          insecureTLS: attempt.insecureTLS,
        });

        const first = response[0];
        if (first?.success?.username) {
          const result: { applicationKey: string; clientKey?: string } = {
            applicationKey: first.success.username,
          };
          if (first.success.clientkey) result.clientKey = first.success.clientkey;
          return result;
        }
        if (first?.error) {
          // 101 = "link button not pressed"
          if (first.error.type === 101) throw new LinkButtonRequiredError();
          throw upstreamError(`Hue Bridge meldet: ${first.error.description}`);
        }
        throw upstreamError('Unerwartete Antwort der Hue Bridge beim Pairing');
      } catch (err) {
        if (err instanceof LinkButtonRequiredError) throw err;
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : upstreamError('Pairing fehlgeschlagen');
  }

  // -------------------------------------------------------------------------
  // CLIP v2
  // -------------------------------------------------------------------------

  /** Holt alle Ressourcen der Bridge in einem Rutsch. */
  async getAllResources(): Promise<HueResource[]> {
    const envelope = await requestJson<HueEnvelope<HueResource[]>>(`${this.baseV2}/resource`, {
      headers: this.headers(),
      insecureTLS: true,
      timeoutMs: this.timeoutMs,
      maxBodyBytes: 16 * 1024 * 1024,
    });
    if (envelope.errors?.length) {
      log.warn('Hue Bridge meldet Fehler', { errors: envelope.errors.map((e) => e.description) });
    }
    return envelope.data ?? [];
  }

  async getResourcesOfType(type: string): Promise<HueResource[]> {
    const envelope = await requestJson<HueEnvelope<HueResource[]>>(
      `${this.baseV2}/resource/${type}`,
      { headers: this.headers(), insecureTLS: true, timeoutMs: this.timeoutMs },
    );
    return envelope.data ?? [];
  }

  async updateLight(lightId: string, update: HueLightUpdate): Promise<void> {
    const res = await request(`${this.baseV2}/resource/light/${lightId}`, {
      method: 'PUT',
      headers: this.headers(),
      json: update,
      insecureTLS: true,
      timeoutMs: this.timeoutMs,
    });
    if (res.status >= 400) {
      throw upstreamError(`Hue Bridge lehnt die Änderung ab (HTTP ${res.status})`, {
        body: res.body.slice(0, 300),
      });
    }
    const parsed = JSON.parse(res.body) as HueEnvelope<unknown>;
    if (parsed.errors?.length) {
      throw upstreamError(`Hue Bridge: ${parsed.errors.map((e) => e.description).join('; ')}`);
    }
  }

  async identifyDevice(deviceId: string): Promise<void> {
    await request(`${this.baseV2}/resource/device/${deviceId}`, {
      method: 'PUT',
      headers: this.headers(),
      json: { identify: { action: 'identify' } },
      insecureTLS: true,
      timeoutMs: this.timeoutMs,
    });
  }

  // -------------------------------------------------------------------------
  // API v1 – für die alte runde Bridge (BSB001) und sehr alte Firmware
  // -------------------------------------------------------------------------

  /**
   * Prüft, ob diese Bridge die CLIP-API v2 beherrscht. Die runde Bridge
   * antwortet auf `/clip/v2/...` mit einem Fehler; erst danach wissen wir
   * verlässlich, welchen Weg wir gehen müssen.
   */
  async supportsV2(): Promise<boolean> {
    try {
      const res = await request(`${this.baseV2}/resource/bridge`, {
        headers: this.headers(),
        insecureTLS: true,
        timeoutMs: this.timeoutMs,
      });
      if (res.status >= 400) return false;
      const parsed = JSON.parse(res.body) as { data?: unknown[] };
      return Array.isArray(parsed.data);
    } catch {
      return false;
    }
  }

  /** Sammelt Leuchten, Sensoren und Gruppen in einem Aufruf. */
  async getV1State(): Promise<{
    lights: Record<string, unknown>;
    sensors: Record<string, unknown>;
    groups: Record<string, unknown>;
  }> {
    if (!this.applicationKey) throw upstreamError('Es wurde kein Hue Application Key hinterlegt');
    // Die alte Bridge liefert unter /api/<key> den gesamten Datenspeicher.
    const all = await requestJson<{
      lights?: Record<string, unknown>;
      sensors?: Record<string, unknown>;
      groups?: Record<string, unknown>;
    }>(this.v1Base(), { insecureTLS: true, timeoutMs: this.timeoutMs, maxBodyBytes: 16 * 1024 * 1024 });

    return {
      lights: all.lights ?? {},
      sensors: all.sensors ?? {},
      groups: all.groups ?? {},
    };
  }

  async setV1LightState(lightId: string, state: Record<string, unknown>): Promise<void> {
    const res = await request(`${this.v1Base()}/lights/${lightId}/state`, {
      method: 'PUT',
      json: state,
      insecureTLS: true,
      timeoutMs: this.timeoutMs,
    });
    if (res.status >= 400) {
      throw upstreamError(`Die Hue Bridge lehnt die Änderung ab (HTTP ${res.status}).`);
    }
    const parsed = JSON.parse(res.body) as Array<{ error?: { description?: string } }>;
    const failure = parsed.find((entry) => entry.error);
    if (failure?.error) {
      throw upstreamError(`Hue Bridge: ${failure.error.description ?? 'unbekannter Fehler'}`);
    }
  }

  /** Blinken lassen – das Identify der V1-API. */
  async alertV1Light(lightId: string): Promise<void> {
    await this.setV1LightState(lightId, { alert: 'select' });
  }

  private v1Base(): string {
    return `https://${this.host}/api/${this.applicationKey}`;
  }

  // -------------------------------------------------------------------------
  // Firmware der Bridge (nur über die V1-API verfügbar)
  // -------------------------------------------------------------------------

  /** Vollständige Bridge-Konfiguration inklusive `swupdate2`. */
  async getFullConfig(): Promise<HueFullConfig> {
    if (!this.applicationKey) throw upstreamError('Es wurde kein Hue Application Key hinterlegt');
    return requestJson<HueFullConfig>(
      `https://${this.host}/api/${this.applicationKey}/config`,
      { insecureTLS: true, timeoutMs: this.timeoutMs },
    );
  }

  /**
   * Weist die Bridge an, nach Updates zu suchen bzw. das bereitliegende
   * Update zu installieren.
   */
  async setSoftwareUpdate(payload: { checkforupdate?: boolean; install?: boolean }): Promise<void> {
    if (!this.applicationKey) throw upstreamError('Es wurde kein Hue Application Key hinterlegt');
    const res = await request(`https://${this.host}/api/${this.applicationKey}/config`, {
      method: 'PUT',
      json: { swupdate2: payload },
      insecureTLS: true,
      timeoutMs: this.timeoutMs,
    });
    if (res.status >= 400) {
      throw upstreamError(`Die Hue Bridge lehnt die Update-Anfrage ab (HTTP ${res.status}).`);
    }
  }

  // -------------------------------------------------------------------------
  // Eventstream (Server-Sent Events)
  // -------------------------------------------------------------------------

  /**
   * Öffnet den Eventstream der Bridge. Der zurückgegebene Stream muss vom
   * Aufrufer beendet werden (`destroy()`).
   */
  async openEventStream(): Promise<IncomingMessage> {
    return openStream(`https://${this.host}/eventstream/clip/v2`, {
      headers: { ...this.headers(), accept: 'text/event-stream' },
      insecureTLS: true,
      // Der Stream bleibt dauerhaft offen – kein Request-Timeout.
      timeoutMs: 0,
    });
  }
}

export interface HueEvent {
  id: string;
  type: string;
  creationtime?: string;
  data: HueResource[];
}

/**
 * Zerlegt einen SSE-Chunk in Hue-Events. Gibt den nicht verarbeiteten Rest
 * zurück, damit unvollständige Nachrichten gepuffert werden können.
 */
export function parseEventStreamChunk(buffer: string): { events: HueEvent[]; rest: string } {
  const events: HueEvent[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';

  for (const block of blocks) {
    const dataLines = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    try {
      const parsed = JSON.parse(dataLines.join('')) as HueEvent[] | HueEvent;
      if (Array.isArray(parsed)) events.push(...parsed);
      else events.push(parsed);
    } catch {
      log.debug('Eventstream-Block konnte nicht geparst werden');
    }
  }
  return { events, rest };
}
