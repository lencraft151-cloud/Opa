import { URL } from 'node:url';
import { upstreamError } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { buildBasicHeader, buildDigestHeader, parseDigestChallenge } from '../../util/digest.js';
import { buildUrl, parseJson, request, type HttpResponse, type RequestOptions } from '../../util/http.js';
import { AuthenticationRequiredError } from '../types.js';

const log = createLogger('shelly:client');

/** Antwort von `GET /shelly` – funktioniert bei allen Generationen. */
export interface ShellyProbe {
  /** Gen1: Modellcode (z. B. `SHSW-1`), Gen2+: `model` */
  model: string;
  /** Eindeutige Geräte-ID (Gen2: `id`, Gen1: aus MAC abgeleitet) */
  deviceId: string;
  mac?: string;
  name?: string;
  generation: 1 | 2;
  firmware?: string;
  authRequired: boolean;
  app?: string;
}

interface ShellyProbeRaw {
  type?: string;
  model?: string;
  mac?: string;
  id?: string;
  name?: string | null;
  auth?: boolean;
  auth_en?: boolean;
  fw?: string;
  ver?: string;
  fw_id?: string;
  gen?: number;
  app?: string;
}

export interface ShellyCredentials {
  username: string;
  password: string;
}

const DEFAULT_TIMEOUT = 6000;

/**
 * Client für Shelly-Geräte.
 *
 * Gen1 (SHSW-*, SHHT-*, …) spricht eine flache REST-API (`/status`,
 * `/relay/0?turn=on`) mit HTTP-Basic-Auth. Gen2 und neuer (Plus/Pro/Gen3/Gen4)
 * sprechen JSON-RPC unter `/rpc` mit HTTP-Digest-Auth (SHA-256, Benutzer
 * immer `admin`).
 */
export class ShellyClient {
  constructor(
    private readonly host: string,
    private readonly generation: 1 | 2,
    private readonly credentials?: ShellyCredentials | undefined,
    private readonly timeoutMs = DEFAULT_TIMEOUT,
  ) {}

  /** Identifiziert ein Gerät unter einer IP-Adresse. */
  static async probe(host: string, timeoutMs = 4000): Promise<ShellyProbe> {
    const res = await request(`http://${host}/shelly`, { timeoutMs });
    if (res.status >= 400 && res.status !== 401) {
      throw upstreamError(`${host} antwortet mit HTTP ${res.status} auf /shelly`);
    }
    const raw = parseJson<ShellyProbeRaw>(res.body, host);
    const generation: 1 | 2 = (raw.gen ?? 1) >= 2 ? 2 : 1;

    const model = raw.model ?? raw.type;
    const mac = raw.mac;
    if (!model && !mac) throw upstreamError(`${host} ist kein Shelly-Gerät`);

    const probe: ShellyProbe = {
      model: model ?? 'unbekannt',
      deviceId: raw.id ?? (mac ? `shelly-${mac.toLowerCase()}` : host),
      generation,
      authRequired: raw.auth_en ?? raw.auth ?? false,
    };
    if (mac) probe.mac = mac;
    if (raw.name) probe.name = raw.name;
    if (raw.ver ?? raw.fw) probe.firmware = raw.ver ?? raw.fw;
    if (raw.app) probe.app = raw.app;
    return probe;
  }

  // -------------------------------------------------------------------------
  // Gemeinsamer Anfragepfad inkl. Authentifizierung
  // -------------------------------------------------------------------------

  private async send(
    path: string,
    options: RequestOptions & { query?: RequestOptions['query'] } = {},
  ): Promise<HttpResponse> {
    const url = buildUrl(`http://${this.host}${path}`, options.query);
    const method = options.method ?? 'GET';
    const headers: Record<string, string> = { ...(options.headers ?? {}) };

    // Gen1 akzeptiert Basic-Auth direkt – spart einen 401-Roundtrip.
    if (this.generation === 1 && this.credentials) {
      headers['authorization'] = buildBasicHeader(
        this.credentials.username,
        this.credentials.password,
      );
    }

    const first = await request(url, {
      ...options,
      query: undefined,
      method,
      headers,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    });
    if (first.status !== 401) return first;

    if (!this.credentials) {
      throw new AuthenticationRequiredError(
        `Das Shelly-Gerät ${this.host} ist passwortgeschützt. Bitte Passwort angeben.`,
      );
    }

    const challengeHeader = first.headers['www-authenticate'];
    const challenge =
      typeof challengeHeader === 'string' ? parseDigestChallenge(challengeHeader) : null;

    if (!challenge) {
      throw new AuthenticationRequiredError(
        `Anmeldung an ${this.host} fehlgeschlagen – bitte Benutzername und Passwort prüfen.`,
      );
    }

    const parsed = new URL(url);
    headers['authorization'] = buildDigestHeader(challenge, {
      username: this.credentials.username,
      password: this.credentials.password,
      method,
      uri: `${parsed.pathname}${parsed.search}`,
    });

    const second = await request(url, {
      ...options,
      query: undefined,
      method,
      headers,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
    });
    if (second.status === 401) {
      throw new AuthenticationRequiredError(
        `Anmeldung an ${this.host} fehlgeschlagen – bitte Passwort prüfen.`,
      );
    }
    return second;
  }

  private async sendJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.send(path, options);
    if (res.status >= 400) {
      throw upstreamError(`Shelly ${this.host} antwortet mit HTTP ${res.status}`, {
        path,
        body: res.body.slice(0, 300),
      });
    }
    return parseJson<T>(res.body, this.host);
  }

  // -------------------------------------------------------------------------
  // Gen2+ JSON-RPC
  // -------------------------------------------------------------------------

  async rpc<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const response = await this.sendJson<{ result?: T; error?: { code: number; message: string } }>(
      '/rpc',
      {
        method: 'POST',
        json: { id: Date.now() % 100000, method, ...(params ? { params } : {}) },
      },
    );
    if (response.error) {
      throw upstreamError(`Shelly ${this.host}: ${response.error.message}`, {
        code: response.error.code,
        method,
      });
    }
    return response.result as T;
  }

  // -------------------------------------------------------------------------
  // Statusabfrage (generationsunabhängig)
  // -------------------------------------------------------------------------

  /** Roher Gerätestatus – Struktur unterscheidet sich je Generation. */
  async getStatus(): Promise<Record<string, unknown>> {
    if (this.generation === 2) {
      return this.rpc<Record<string, unknown>>('Shelly.GetStatus');
    }
    return this.sendJson<Record<string, unknown>>('/status');
  }

  /** Gerätekonfiguration – liefert u. a. die Namen der Kanäle. */
  async getConfig(): Promise<Record<string, unknown>> {
    if (this.generation === 2) {
      return this.rpc<Record<string, unknown>>('Shelly.GetConfig');
    }
    return this.sendJson<Record<string, unknown>>('/settings');
  }

  // -------------------------------------------------------------------------
  // Steuerung
  // -------------------------------------------------------------------------

  async setSwitch(channel: number, on: boolean): Promise<void> {
    if (this.generation === 2) {
      await this.rpc('Switch.Set', { id: channel, on });
      return;
    }
    await this.sendJson(`/relay/${channel}`, { query: { turn: on ? 'on' : 'off' } });
  }

  /**
   * Übergangszeit für Gen2: `transition_duration` zählt in **Sekunden**.
   *
   * Shelly nimmt bis zu fünf Sekunden an; alles darüber lehnt die Firmware
   * ab, statt zu kürzen – deshalb wird hier gekürzt.
   */
  private fadeGen2(params: Record<string, unknown>, transitionMs = 0): Record<string, unknown> {
    if (transitionMs <= 0 || params['on'] === false) return params;
    return { ...params, transition_duration: Math.min(5, transitionMs / 1000) };
  }

  /** Dasselbe für Gen1 – dort in Millisekunden und ebenfalls bei 5 s gedeckelt. */
  private fadeGen1(
    query: Record<string, string | number>,
    transitionMs = 0,
  ): Record<string, string | number> {
    if (transitionMs <= 0 || query['turn'] === 'off') return query;
    return { ...query, transition: Math.round(Math.min(5000, transitionMs)) };
  }

  async setLight(
    channel: number,
    on: boolean,
    brightness?: number,
    transitionMs = 0,
  ): Promise<void> {
    if (this.generation === 2) {
      const params: Record<string, unknown> = { id: channel, on };
      if (brightness !== undefined) params['brightness'] = Math.round(brightness);
      await this.rpc('Light.Set', this.fadeGen2(params, transitionMs));
      return;
    }
    const query: Record<string, string | number> = { turn: on ? 'on' : 'off' };
    if (brightness !== undefined) query['brightness'] = Math.round(brightness);
    await this.sendJson(`/light/${channel}`, { query: this.fadeGen1(query, transitionMs) });
  }

  /**
   * Setzt die Farbe eines RGB-/RGBW-Kanals.
   *
   * Gen2 kennt je nach Kanaltyp `RGB.Set` oder `RGBW.Set`; Gen1-Bulbs und der
   * RGBW2 nehmen die Kanäle direkt als Query-Parameter entgegen.
   */
  async setColor(
    channel: number,
    rgb: [number, number, number],
    kind: 'rgb' | 'rgbw' | 'light',
    transitionMs = 0,
  ): Promise<void> {
    const clamped = rgb.map((value) => Math.round(Math.min(255, Math.max(0, value)))) as [
      number,
      number,
      number,
    ];

    if (this.generation === 2) {
      const method = kind === 'rgbw' ? 'RGBW.Set' : 'RGB.Set';
      await this.rpc(method, this.fadeGen2({ id: channel, on: true, rgb: clamped }, transitionMs));
      return;
    }

    await this.sendJson(`/light/${channel}`, {
      query: this.fadeGen1(
        {
          turn: 'on',
          mode: 'color',
          red: clamped[0],
          green: clamped[1],
          blue: clamped[2],
        },
        transitionMs,
      ),
    });
  }

  async setCoverPosition(channel: number, position: number): Promise<void> {
    const pos = Math.round(Math.min(100, Math.max(0, position)));
    if (this.generation === 2) {
      await this.rpc('Cover.GoToPosition', { id: channel, pos });
      return;
    }
    await this.sendJson(`/roller/${channel}`, { query: { go: 'to_pos', roller_pos: pos } });
  }

  /**
   * Lamellenstellung einer Jalousie. Nur Gen2+ kennt `slat_pos`; Gen1-Roller
   * haben keine Lamellensteuerung.
   */
  async setCoverTilt(channel: number, tilt: number): Promise<void> {
    if (this.generation !== 2) {
      throw upstreamError('Dieses Gerät unterstützt keine Lamellenverstellung');
    }
    const slatPos = Math.round(Math.min(100, Math.max(0, tilt)));
    await this.rpc('Cover.GoToPosition', { id: channel, slat_pos: slatPos });
  }

  /**
   * Solltemperatur einer Heizung. Der Gen1-TRV nimmt sie als Query-Parameter,
   * Gen2-Thermostate über die RPC-Schnittstelle.
   */
  /**
   * Solltemperatur setzen.
   *
   * @param kind Bauteilart – `blutrv` geht einen anderen Weg als `thermostat`.
   */
  async setThermostatTarget(channel: number, targetC: number, kind = 'thermostat'): Promise<void> {
    const target = Math.round(targetC * 10) / 10;

    /*
     * Ein BLU TRV hängt per Bluetooth an einem Gen3-Shelly, der als Zugang
     * dient. Befehle gehen deshalb nicht direkt an das Ventil, sondern
     * eingepackt über `BluTrv.Call` an den Zugang, der sie weiterreicht.
     */
    if (kind === 'blutrv') {
      await this.rpc('BluTrv.Call', {
        id: channel,
        method: 'Trv.SetTarget',
        params: { id: 0, target_C: target },
      });
      return;
    }

    if (this.generation === 2) {
      await this.rpc('Thermostat.SetConfig', {
        id: channel,
        config: { target_C: target },
      });
      return;
    }
    await this.sendJson(`/thermostat/${channel}`, {
      query: { target_t_enabled: 1, target_t: target },
    });
  }

  /**
   * Weißton setzen.
   *
   * Gen2 kennt zwei Bauteilarten: `cct` für reine Weißton-Lampen und `light`
   * für solche, die auch Farbe können. Beide nehmen `ct` in Kelvin. Gen1
   * (Shelly Duo, RGBW2 im Weißmodus) will `temp` an `/light/N`.
   */
  async setColorTemperature(
    channel: number,
    kelvin: number,
    kind = 'light',
    transitionMs = 0,
  ): Promise<void> {
    const ct = Math.round(kelvin);
    if (this.generation === 2) {
      await this.rpc(
        kind === 'cct' ? 'CCT.Set' : 'Light.Set',
        this.fadeGen2({ id: channel, ct }, transitionMs),
      );
      return;
    }
    await this.sendJson(`/light/${channel}`, {
      query: this.fadeGen1({ temp: ct, mode: 'white' }, transitionMs),
    });
  }

  async openCover(channel: number): Promise<void> {
    if (this.generation === 2) {
      await this.rpc('Cover.Open', { id: channel });
      return;
    }
    await this.sendJson(`/roller/${channel}`, { query: { go: 'open' } });
  }

  async closeCover(channel: number): Promise<void> {
    if (this.generation === 2) {
      await this.rpc('Cover.Close', { id: channel });
      return;
    }
    await this.sendJson(`/roller/${channel}`, { query: { go: 'close' } });
  }

  async stopCover(channel: number): Promise<void> {
    if (this.generation === 2) {
      await this.rpc('Cover.Stop', { id: channel });
      return;
    }
    await this.sendJson(`/roller/${channel}`, { query: { go: 'stop' } });
  }

  // -------------------------------------------------------------------------
  // Firmware
  // -------------------------------------------------------------------------

  /**
   * Fragt beim Gerät nach neuer Firmware.
   *
   * Gen2+ beantwortet `Shelly.CheckForUpdate` mit den verfügbaren Kanälen,
   * Gen1 meldet den Stand in `/status` (`has_update`, `update.new_version`).
   */
  async checkForUpdate(): Promise<{ current: string | null; available: string | null }> {
    if (this.generation === 2) {
      const info = await this.rpc<{
        stable?: { version?: string };
        beta?: { version?: string };
      }>('Shelly.CheckForUpdate');
      const device = await this.rpc<{ ver?: string }>('Shelly.GetDeviceInfo');
      return { current: device.ver ?? null, available: info?.stable?.version ?? null };
    }

    const status = await this.sendJson<{
      update?: { has_update?: boolean; new_version?: string; old_version?: string };
    }>('/status');
    const update = status.update;
    return {
      current: update?.old_version ?? null,
      available: update?.has_update ? (update.new_version ?? null) : null,
    };
  }

  /** Stößt die Installation der stabilen Firmware an; das Gerät startet neu. */
  async installUpdate(): Promise<void> {
    if (this.generation === 2) {
      await this.rpc('Shelly.Update', { stage: 'stable' });
      return;
    }
    await this.sendJson('/ota', { query: { update: 'true' } });
  }

  /**
   * Shelly kennt kein herstellerweites "Identify". Für schaltbare Kanäle wird
   * deshalb zweimal umgeschaltet – das Klicken des Relais ist am Gerät hörbar.
   */
  async identify(channel = 0): Promise<void> {
    const toggle = async (): Promise<void> => {
      if (this.generation === 2) await this.rpc('Switch.Toggle', { id: channel });
      else await this.sendJson(`/relay/${channel}`, { query: { turn: 'toggle' } });
    };
    try {
      await toggle();
      await new Promise((resolve) => setTimeout(resolve, 600));
      await toggle();
    } catch (err) {
      log.debug('Identify wird von diesem Gerät nicht unterstützt', {
        host: this.host,
        error: (err as Error).message,
      });
    }
  }
}
