import { upstreamError } from '../../core/errors.js';
import type { TransportState } from '../../core/types.js';
import { request } from '../../util/http.js';
import type { XmlNode } from '../../util/xml.js';
import {
  findText,
  parseBrowseItems,
  parseDuration,
  parseTrackMetadata,
  parseUpnpError,
  parseZoneGroups,
  parseTransportState,
  soapEnvelope,
  soapResult,
  type SonosBrowseItem,
  type TrackInfo,
  type ZoneGroup,
} from './mapping.js';

/** Sonos steuert man immer über diesen Port – er ist nicht einstellbar. */
export const SONOS_PORT = 1400;

interface ServiceDef {
  path: string;
  type: string;
}

const SERVICES = {
  transport: {
    path: '/MediaRenderer/AVTransport/Control',
    type: 'urn:schemas-upnp-org:service:AVTransport:1',
  },
  rendering: {
    path: '/MediaRenderer/RenderingControl/Control',
    type: 'urn:schemas-upnp-org:service:RenderingControl:1',
  },
  topology: {
    path: '/ZoneGroupTopology/Control',
    type: 'urn:schemas-upnp-org:service:ZoneGroupTopology:1',
  },
  device: {
    path: '/DeviceProperties/Control',
    type: 'urn:schemas-upnp-org:service:DeviceProperties:1',
  },
  content: {
    path: '/MediaServer/ContentDirectory/Control',
    type: 'urn:schemas-upnp-org:service:ContentDirectory:1',
  },
} as const satisfies Record<string, ServiceDef>;

export interface NowPlaying extends TrackInfo {
  durationSeconds: number | null;
  positionSeconds: number | null;
}

/**
 * Ein Sonos-Lautsprecher, angesprochen über UPnP.
 *
 * Sonos spricht kein JSON und keine REST-API, sondern SOAP über HTTP auf Port
 * 1400 – ein Protokoll aus der Zeit, als Lautsprecher noch keine Konten
 * hatten. Der Vorteil: Es läuft vollständig im eigenen Netz, ohne Konto, ohne
 * Cloud und ohne Schlüssel, der ablaufen kann.
 */
export class SonosClient {
  private readonly host: string;
  private readonly port: number;

  /**
   * `host` darf einen Port mitbringen (`192.168.1.42:1400`).
   *
   * Gebraucht wird das selten – Sonos hört immer auf 1400 –, aber die
   * Gruppenauskunft nennt die Mitspieler als vollständige Adresse, und wer
   * einen Lautsprecher von Hand einträgt, tippt gern die Adresse ab, die im
   * Browser stand.
   */
  constructor(host: string, port?: number) {
    const [parsedHost, parsedPort] = splitHostPort(host);
    this.host = parsedHost;
    this.port = port ?? parsedPort ?? SONOS_PORT;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  // -------------------------------------------------------------------------
  // Steuern
  // -------------------------------------------------------------------------

  async play(): Promise<void> {
    await this.soap(SERVICES.transport, 'Play', { InstanceID: 0, Speed: 1 });
  }

  async pause(): Promise<void> {
    await this.soap(SERVICES.transport, 'Pause', { InstanceID: 0 });
  }

  async next(): Promise<void> {
    await this.soap(SERVICES.transport, 'Next', { InstanceID: 0 });
  }

  async previous(): Promise<void> {
    await this.soap(SERVICES.transport, 'Previous', { InstanceID: 0 });
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = Math.min(100, Math.max(0, Math.round(volume)));
    await this.soap(SERVICES.rendering, 'SetVolume', {
      InstanceID: 0,
      Channel: 'Master',
      DesiredVolume: clamped,
    });
  }

  async setMute(muted: boolean): Promise<void> {
    await this.soap(SERVICES.rendering, 'SetMute', {
      InstanceID: 0,
      Channel: 'Master',
      DesiredMute: muted ? 1 : 0,
    });
  }

  // -------------------------------------------------------------------------
  // Lesen
  // -------------------------------------------------------------------------

  async transportState(): Promise<TransportState | null> {
    const result = await this.soap(SERVICES.transport, 'GetTransportInfo', { InstanceID: 0 });
    return parseTransportState(findText(result, 'CurrentTransportState'));
  }

  async nowPlaying(): Promise<NowPlaying> {
    const result = await this.soap(SERVICES.transport, 'GetPositionInfo', { InstanceID: 0 });
    const track = parseTrackMetadata(findText(result, 'TrackMetaData'), this.baseUrl);
    return {
      ...track,
      durationSeconds: parseDuration(findText(result, 'TrackDuration')),
      positionSeconds: parseDuration(findText(result, 'RelTime')),
    };
  }

  async volume(): Promise<number | null> {
    const result = await this.soap(SERVICES.rendering, 'GetVolume', {
      InstanceID: 0,
      Channel: 'Master',
    });
    const value = Number(findText(result, 'CurrentVolume'));
    return Number.isFinite(value) ? value : null;
  }

  async muted(): Promise<boolean> {
    const result = await this.soap(SERVICES.rendering, 'GetMute', {
      InstanceID: 0,
      Channel: 'Master',
    });
    return (findText(result, 'CurrentMute') ?? '0').trim() === '1';
  }

  /**
   * Die Gruppenaufteilung des ganzen Haushalts.
   *
   * Jeder Lautsprecher kennt sie – man muss also nicht alle fragen, einer
   * genügt.
   */
  async zoneGroups(): Promise<ZoneGroup[]> {
    const result = await this.soap(SERVICES.topology, 'GetZoneGroupState', {});
    return parseZoneGroups(findText(result, 'ZoneGroupState'));
  }

  /**
   * Blättert einen Behälter des ContentDirectory auf.
   *
   * `count = 0` hieße bei Sonos „alles" – wird hier bewusst nicht genutzt:
   * Wer tausend Titel gespeichert hat, bekäme ein Megabyte XML für eine Liste,
   * die niemand durchscrollt.
   */
  async browse(
    objectId: string,
    options: { start?: number; count?: number } = {},
  ): Promise<SonosBrowseItem[]> {
    const result = await this.soap(SERVICES.content, 'Browse', {
      ObjectID: objectId,
      BrowseFlag: 'BrowseDirectChildren',
      Filter: '*',
      StartingIndex: options.start ?? 0,
      RequestedCount: options.count ?? 100,
      SortCriteria: '',
    });
    return parseBrowseItems(findText(result, 'Result'));
  }

  /** Legt eine Quelle auf – Radiostream, Warteschlange, einzelner Titel. */
  async setAvTransportUri(uri: string, metadata = ''): Promise<void> {
    await this.soap(SERVICES.transport, 'SetAVTransportURI', {
      InstanceID: 0,
      CurrentURI: uri,
      CurrentURIMetaData: metadata,
    });
  }

  async addUriToQueue(uri: string, metadata = ''): Promise<void> {
    await this.soap(SERVICES.transport, 'AddURIToQueue', {
      InstanceID: 0,
      EnqueuedURI: uri,
      EnqueuedURIMetaData: metadata,
      // 0 heißt „ans Ende"; die Warteschlange ist an dieser Stelle ohnehin leer.
      DesiredFirstTrackNumberEnqueued: 0,
      EnqueueAsNext: 0,
    });
  }

  async clearQueue(): Promise<void> {
    await this.soap(SERVICES.transport, 'RemoveAllTracksFromQueue', { InstanceID: 0 });
  }

  /** Die Gerätebeschreibung, aus der Name, Modell und UUID kommen. */
  async description(): Promise<string> {
    const res = await request(`${this.baseUrl}/xml/device_description.xml`, {
      timeoutMs: 4000,
      maxBodyBytes: 512 * 1024,
    });
    if (res.status >= 400) {
      throw upstreamError(`${this.host} hat mit HTTP ${res.status} geantwortet.`, {
        status: res.status,
      });
    }
    return res.body;
  }

  // -------------------------------------------------------------------------

  private async soap(
    service: ServiceDef,
    action: string,
    args: Record<string, string | number>,
  ): Promise<XmlNode | undefined> {
    const res = await request(`${this.baseUrl}${service.path}`, {
      method: 'POST',
      headers: {
        'content-type': 'text/xml; charset="utf-8"',
        soapaction: `"${service.type}#${action}"`,
      },
      body: soapEnvelope(service.type, action, args),
      timeoutMs: 6000,
      maxBodyBytes: 1024 * 1024,
    });

    if (res.status >= 400) {
      /*
       * Ein UPnP-Fehler kommt als HTTP 500 mit einer SOAP-Fault-Antwort. Der
       * Code darin ist die eigentliche Auskunft – „HTTP 500" allein sagt nur,
       * dass etwas nicht ging.
       */
      const fault = parseUpnpError(res.body);
      if (fault) {
        throw upstreamError(fault.message, { upnpErrorCode: fault.code, action });
      }
      throw upstreamError(`Der Lautsprecher hat mit HTTP ${res.status} geantwortet.`, {
        status: res.status,
        action,
      });
    }

    return soapResult(res.body);
  }
}

/** `192.168.1.42:1400` → `['192.168.1.42', 1400]`, `sonos.local` → `['sonos.local', null]`. */
export function splitHostPort(value: string): [string, number | null] {
  const trimmed = value.trim();
  const colon = trimmed.lastIndexOf(':');
  if (colon <= 0) return [trimmed, null];
  const port = Number(trimmed.slice(colon + 1));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return [trimmed, null];
  return [trimmed.slice(0, colon), port];
}
