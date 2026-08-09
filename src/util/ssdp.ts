import dgram from 'node:dgram';
import { createLogger } from '../core/logger.js';

const log = createLogger('ssdp');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

/** Der Diensttyp, unter dem sich jeder Sonos-Lautsprecher meldet. */
export const SONOS_SEARCH_TARGET = 'urn:schemas-upnp-org:device:ZonePlayer:1';

export interface SsdpResponse {
  /** Adresse, von der die Antwort kam. */
  address: string;
  /** `LOCATION`-Kopfzeile: die Gerätebeschreibung als vollständige URL. */
  location: string;
  /** `USN`, enthält bei Sonos die `uuid:RINCON_…`. */
  usn: string;
  /** `ST` bzw. `NT` – wonach gesucht wurde. */
  searchTarget: string;
  headers: Record<string, string>;
}

/**
 * Zerlegt eine SSDP-Antwort.
 *
 * Das Format ist HTTP-artig, aber kein HTTP: eine Statuszeile, danach
 * Kopfzeilen. Groß-/Kleinschreibung ist bei den Namen egal – Sonos schreibt
 * `LOCATION`, andere Geräte `Location`.
 *
 * Exportiert, damit sich der Parser ohne Netzwerk prüfen lässt.
 */
export function parseSsdpResponse(message: string, address: string): SsdpResponse | null {
  const lines = message.split(/\r?\n/);
  const first = lines[0]?.trim() ?? '';
  // Antwort auf unsere Suche oder eine unaufgeforderte Ankündigung.
  if (!/^HTTP\/1\.[01] 200/i.test(first) && !/^NOTIFY /i.test(first)) return null;

  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!key) continue;
    headers[key] = line.slice(colon + 1).trim();
  }

  const location = headers['location'] ?? '';
  if (!location) return null;

  return {
    address,
    location,
    usn: headers['usn'] ?? '',
    searchTarget: headers['st'] ?? headers['nt'] ?? '',
    headers,
  };
}

export interface SsdpSearchOptions {
  timeoutMs?: number;
  /** Wie oft die Suche wiederholt wird – UDP-Pakete gehen verloren. */
  queryCount?: number;
  /** Ruhezeit nach der letzten *neuen* Antwort, nach der die Suche endet. */
  quietMs?: number;
  /**
   * `MX`-Wert der Suche: So viele Sekunden dürfen sich die Geräte Zeit
   * lassen, bevor sie antworten. Kleiner heißt schneller, aber in großen
   * Netzen auch mehr gleichzeitige Antworten.
   */
  mx?: number;
}

/**
 * Sucht per SSDP nach Geräten eines Typs.
 *
 * Wie bei mDNS bewusst selbst gebaut statt mit einer Bibliothek – es sind
 * fünfzig Zeilen, und der Hub kommt sonst mit zwei Laufzeitabhängigkeiten
 * aus.
 *
 * Der Aufbau folgt `browse()` aus `mdns.ts`, inklusive des vorzeitigen
 * Endes bei abebbender Antwortwelle: Wer geantwortet hat, hat geantwortet;
 * nur wenn es von Anfang an still bleibt, wird die volle Zeit gewartet.
 */
export async function search(
  searchTarget: string,
  options: SsdpSearchOptions = {},
): Promise<SsdpResponse[]> {
  const timeoutMs = options.timeoutMs ?? 3000;
  const queryCount = options.queryCount ?? 2;
  const quietMs = options.quietMs ?? 600;
  const mx = options.mx ?? 1;

  const socket = await bind();
  if (!socket) {
    log.warn('SSDP-Socket konnte nicht geöffnet werden – Suche übersprungen');
    return [];
  }

  const found = new Map<string, SsdpResponse>();

  return await new Promise<SsdpResponse[]>((resolve) => {
    let settled = false;
    let quiet: NodeJS.Timeout | undefined;

    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (quiet) clearTimeout(quiet);
      try {
        socket.close();
      } catch {
        /* bereits geschlossen */
      }
      resolve([...found.values()]);
    };

    const timer = setTimeout(done, timeoutMs);

    socket.on('error', (err) => {
      log.debug('SSDP-Socket-Fehler', { error: err.message });
      done();
    });

    socket.on('message', (msg, rinfo) => {
      const parsed = parseSsdpResponse(msg.toString('utf8'), rinfo.address);
      if (!parsed) return;
      // Auf eine gezielte Suche antworten Geräte auch mit anderen Diensten,
      // wenn sie gerade etwas anzukündigen haben.
      if (searchTarget !== 'ssdp:all' && !parsed.searchTarget.startsWith(searchTarget)) return;

      const key = parsed.usn || `${parsed.address}|${parsed.location}`;
      if (found.has(key)) return;
      found.set(key, parsed);

      if (quiet) clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
      quiet.unref?.();
    });

    const query = Buffer.from(
      [
        'M-SEARCH * HTTP/1.1',
        `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
        'MAN: "ssdp:discover"',
        `MX: ${mx}`,
        `ST: ${searchTarget}`,
        '',
        '',
      ].join('\r\n'),
      'utf8',
    );

    let sent = 0;
    const send = (): void => {
      if (settled) return;
      socket.send(query, 0, query.length, SSDP_PORT, SSDP_ADDRESS, (err) => {
        if (err) log.debug('SSDP-Anfrage konnte nicht gesendet werden', { error: err.message });
      });
      sent += 1;
      if (sent < queryCount) setTimeout(send, Math.min(400, timeoutMs / queryCount));
    };
    send();
  });
}

/**
 * Öffnet den Socket für die Suche.
 *
 * Anders als bei mDNS wird hier auf einem *zufälligen* Port gelauscht: Die
 * Antwort auf ein M-SEARCH geht per Unicast zurück an den Absenderport. Port
 * 1900 bräuchte man nur, um unaufgeforderte Ankündigungen mitzuhören – und
 * ihn belegt auf vielen Systemen schon ein anderer Dienst.
 */
async function bind(): Promise<dgram.Socket | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const onError = (err: Error): void => {
      log.debug('SSDP-Bind fehlgeschlagen', { error: err.message });
      try {
        socket.close();
      } catch {
        /* bereits zu */
      }
      resolve(null);
    };
    socket.once('error', onError);
    socket.bind(0, () => {
      socket.off('error', onError);
      try {
        socket.setBroadcast(true);
        socket.setMulticastTTL(4);
      } catch {
        /* nicht überall erlaubt – senden klappt meist trotzdem */
      }
      resolve(socket);
    });
  });
}
