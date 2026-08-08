import dgram from 'node:dgram';
import { createLogger } from '../core/logger.js';

const log = createLogger('mdns');

const MDNS_ADDRESS = '224.0.0.251';
const MDNS_PORT = 5353;

const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_TXT = 16;
const TYPE_SRV = 33;
const CLASS_IN = 1;
/** Bit 15 der QCLASS: "unicast response requested" (RFC 6762, 5.4). */
const QU_BIT = 0x8000;

export interface MdnsService {
  /** Vollständiger Instanzname, z. B. `shelly1-A4CF12._shelly._tcp.local` */
  name: string;
  /** Hostname aus dem SRV-Record, z. B. `shelly1-A4CF12.local` */
  host?: string;
  port?: number;
  addresses: string[];
  txt: Record<string, string>;
}

// ---------------------------------------------------------------------------
// DNS-Nachrichten kodieren/dekodieren
// ---------------------------------------------------------------------------

function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.');
  const buffers: Buffer[] = [];
  for (const part of parts) {
    const label = Buffer.from(part, 'utf8');
    if (label.length > 63) throw new Error(`DNS-Label zu lang: ${part}`);
    buffers.push(Buffer.from([label.length]), label);
  }
  buffers.push(Buffer.from([0]));
  return Buffer.concat(buffers);
}

/**
 * Baut eine PTR-Anfrage.
 *
 * `unicastResponse` setzt das QU-Bit: das Gerät soll direkt an uns antworten
 * statt an die Multicast-Gruppe. Nötig nur, wenn wir nicht auf Port 5353
 * lauschen. Exportiert, damit dieses Verhalten prüfbar ist.
 */
export function buildQuery(serviceName: string, unicastResponse: boolean): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0, 0); // ID = 0 (mDNS)
  header.writeUInt16BE(0, 2); // Flags: Standard-Query
  header.writeUInt16BE(1, 4); // QDCOUNT
  const question = Buffer.concat([
    encodeName(serviceName),
    (() => {
      const tail = Buffer.alloc(4);
      tail.writeUInt16BE(TYPE_PTR, 0);
      tail.writeUInt16BE(unicastResponse ? CLASS_IN | QU_BIT : CLASS_IN, 2);
      return tail;
    })(),
  ]);
  return Buffer.concat([header, question]);
}

interface NameResult {
  name: string;
  offset: number;
}

function decodeName(buffer: Buffer, offset: number): NameResult {
  const labels: string[] = [];
  let position = offset;
  let jumped = false;
  let endOffset = offset;
  let guard = 0;

  while (position < buffer.length) {
    if (guard++ > 128) throw new Error('DNS-Namen-Schleife erkannt');
    const length = buffer[position] as number;
    if (length === 0) {
      position += 1;
      if (!jumped) endOffset = position;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      const pointer = (((length & 0x3f) << 8) | (buffer[position + 1] as number)) >>> 0;
      if (!jumped) endOffset = position + 2;
      jumped = true;
      position = pointer;
      continue;
    }
    position += 1;
    labels.push(buffer.subarray(position, position + length).toString('utf8'));
    position += length;
    if (!jumped) endOffset = position;
  }
  return { name: labels.join('.'), offset: endOffset };
}

interface ResourceRecord {
  name: string;
  type: number;
  data: Buffer;
  /** Offset der rdata im Gesamtpuffer – nötig wegen Namenskompression. */
  dataOffset: number;
}

interface DnsMessage {
  answers: ResourceRecord[];
}

function decodeMessage(buffer: Buffer): DnsMessage {
  if (buffer.length < 12) throw new Error('DNS-Nachricht zu kurz');
  const qdcount = buffer.readUInt16BE(4);
  const total =
    buffer.readUInt16BE(6) + buffer.readUInt16BE(8) + buffer.readUInt16BE(10); // AN + NS + AR

  let offset = 12;
  for (let i = 0; i < qdcount; i++) {
    offset = decodeName(buffer, offset).offset + 4;
  }

  const answers: ResourceRecord[] = [];
  for (let i = 0; i < total && offset < buffer.length; i++) {
    const nameResult = decodeName(buffer, offset);
    offset = nameResult.offset;
    if (offset + 10 > buffer.length) break;
    const type = buffer.readUInt16BE(offset);
    const rdlength = buffer.readUInt16BE(offset + 8);
    const dataOffset = offset + 10;
    if (dataOffset + rdlength > buffer.length) break;
    answers.push({
      name: nameResult.name,
      type,
      data: buffer.subarray(dataOffset, dataOffset + rdlength),
      dataOffset,
    });
    offset = dataOffset + rdlength;
  }
  return { answers };
}

function decodeTxt(data: Buffer): Record<string, string> {
  const result: Record<string, string> = {};
  let offset = 0;
  while (offset < data.length) {
    const length = data[offset] as number;
    offset += 1;
    if (length === 0 || offset + length > data.length) break;
    const entry = data.subarray(offset, offset + length).toString('utf8');
    offset += length;
    const eq = entry.indexOf('=');
    if (eq === -1) result[entry] = '';
    else result[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface MdnsBrowseOptions {
  timeoutMs?: number;
  /** Wie oft die Anfrage wiederholt wird (Pakete können verloren gehen). */
  queryCount?: number;
}

/**
 * Fragt per Multicast-DNS nach einem Servicetyp (z. B. `_hue._tcp.local`)
 * und sammelt alle Antworten bis zum Timeout.
 *
 * Bewusst eine eigene, minimale Implementierung: eine externe mDNS-Bibliothek
 * wäre die einzige native/umfangreiche Abhängigkeit des Projekts.
 */
export async function browse(
  serviceName: string,
  options: MdnsBrowseOptions = {},
): Promise<MdnsService[]> {
  const timeoutMs = options.timeoutMs ?? 4000;
  const queryCount = options.queryCount ?? 2;
  const collector = new ServiceCollector(serviceName);

  const bound = await bindListener();
  if (!bound) {
    log.warn('mDNS-Socket konnte nicht geöffnet werden – Suche übersprungen');
    return [];
  }
  const { socket, multicastCapable } = bound;

  return await new Promise<MdnsService[]>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* bereits geschlossen */
      }
      resolve(collector.result());
    };

    const timer = setTimeout(done, timeoutMs);

    socket.on('error', (err) => {
      log.debug('mDNS-Socket-Fehler', { error: err.message });
      done();
    });

    socket.on('message', (msg, rinfo) => collector.add(msg, rinfo.address));

    /*
     * Die Unicast-Antwort wird nur angefordert, wenn wir NICHT auf dem
     * Standardport lauschen. Auf 5353 empfangen wir die regulären
     * Multicast-Antworten – und die beantworten deutlich mehr Geräte.
     */
    const query = buildQuery(serviceName, !multicastCapable);
    let sent = 0;
    const send = (): void => {
      if (settled) return;
      socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDRESS, (err) => {
        if (err) log.debug('mDNS-Anfrage konnte nicht gesendet werden', { error: err.message });
      });
      sent += 1;
      if (sent < queryCount) setTimeout(send, Math.min(500, timeoutMs / queryCount));
    };
    send();
  });
}

/**
 * Öffnet den Empfangssocket.
 *
 * Entscheidend ist der Port: Antworten auf eine mDNS-Anfrage gehen per
 * Multicast an 224.0.0.251:**5353**. Ein Socket auf einem zufälligen Port
 * bekommt davon nichts zu sehen – er hört nur die Geräte, die das
 * "unicast response"-Bit beachten, und das tun längst nicht alle (Shellys
 * zum Beispiel nicht). Deshalb zuerst 5353 mit `reuseAddr`, damit wir uns
 * den Port mit einem laufenden Avahi/Bonjour teilen können.
 */
async function bindListener(): Promise<{
  socket: dgram.Socket;
  multicastCapable: boolean;
} | null> {
  const attempt = (port: number): Promise<dgram.Socket | null> =>
    new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      const onBindError = (err: Error): void => {
        log.debug('mDNS-Bind fehlgeschlagen', { port, error: err.message });
        try {
          socket.close();
        } catch {
          /* bereits zu */
        }
        resolve(null);
      };
      socket.once('error', onBindError);
      socket.bind(port, () => {
        socket.off('error', onBindError);
        resolve(socket);
      });
    });

  const primary = await attempt(MDNS_PORT);
  if (primary) {
    const joined = prepare(primary, true);
    if (joined) return { socket: primary, multicastCapable: true };
    // Ohne Gruppenmitgliedschaft bringt der Standardport nichts.
    try {
      primary.close();
    } catch {
      /* egal */
    }
  }

  const fallback = await attempt(0);
  if (!fallback) return null;
  prepare(fallback, false);
  log.debug('mDNS läuft im Unicast-Modus – manche Geräte antworten so nicht');
  return { socket: fallback, multicastCapable: false };
}

/** Setzt Socket-Optionen; gibt zurück, ob die Multicast-Gruppe erreicht wurde. */
function prepare(socket: dgram.Socket, joinGroup: boolean): boolean {
  try {
    socket.setBroadcast(true);
    socket.setMulticastTTL(255);
  } catch {
    /* nicht überall erlaubt – Senden klappt meist trotzdem */
  }
  if (!joinGroup) return false;
  try {
    socket.addMembership(MDNS_ADDRESS);
    return true;
  } catch (err) {
    log.debug('Multicast-Gruppe konnte nicht betreten werden', {
      error: (err as Error).message,
    });
    return false;
  }
}

/**
 * Sammelt die Antworten mehrerer Pakete zu einer Diensteliste.
 *
 * Ein Gerät verteilt seine Angaben oft über PTR-, SRV-, TXT- und A-Records,
 * teils in getrennten Paketen – deshalb wird über alle Antworten hinweg
 * zusammengeführt.
 */
class ServiceCollector {
  private readonly services = new Map<string, MdnsService>();
  private readonly hostAddresses = new Map<string, string[]>();

  constructor(private readonly serviceName: string) {}

  add(message: Buffer, responderAddress: string): void {
    let decoded: DnsMessage;
    try {
      decoded = decodeMessage(message);
    } catch {
      return; // unvollständiges oder fremdes Paket
    }
    for (const record of decoded.answers) {
      try {
        handleRecord(
          record,
          message,
          responderAddress,
          this.serviceName,
          this.services,
          this.hostAddresses,
        );
      } catch {
        /* fehlerhafte Records ignorieren */
      }
    }
  }

  result(): MdnsService[] {
    for (const service of this.services.values()) {
      if (!service.host) continue;
      const addresses = this.hostAddresses.get(service.host.toLowerCase());
      if (addresses) service.addresses = [...new Set([...service.addresses, ...addresses])];
    }
    return [...this.services.values()];
  }
}

/**
 * Wertet eine einzelne mDNS-Antwort aus. Exportiert, damit sich der Parser
 * ohne echtes Netzwerk prüfen lässt.
 */
export function parseResponse(
  message: Buffer,
  serviceName: string,
  responderAddress = '0.0.0.0',
): MdnsService[] {
  const collector = new ServiceCollector(serviceName);
  collector.add(message, responderAddress);
  return collector.result();
}

function handleRecord(
  record: ResourceRecord,
  message: Buffer,
  responderAddress: string,
  serviceName: string,
  services: Map<string, MdnsService>,
  hostAddresses: Map<string, string[]>,
): void {
  const suffix = serviceName.replace(/\.$/, '').toLowerCase();

  // Ein Record ohne verwertbaren Namen würde sonst einen leeren Geisterdienst
  // in der Liste erzeugen.
  const ensure = (name: string): MdnsService | null => {
    if (!name) return null;
    let service = services.get(name);
    if (!service) {
      service = { name, addresses: [], txt: {} };
      services.set(name, service);
    }
    return service;
  };

  switch (record.type) {
    case TYPE_PTR: {
      if (!record.name.toLowerCase().endsWith(suffix)) return;
      const target = decodeName(message, record.dataOffset).name;
      const service = ensure(target);
      if (!service) return;
      if (!service.addresses.includes(responderAddress)) service.addresses.push(responderAddress);
      break;
    }
    case TYPE_SRV: {
      if (!record.name.toLowerCase().endsWith(suffix)) return;
      const service = ensure(record.name);
      if (!service) return;
      service.port = record.data.readUInt16BE(4);
      service.host = decodeName(message, record.dataOffset + 6).name;
      if (!service.addresses.includes(responderAddress)) service.addresses.push(responderAddress);
      break;
    }
    case TYPE_TXT: {
      if (!record.name.toLowerCase().endsWith(suffix)) return;
      const service = ensure(record.name);
      if (!service) return;
      service.txt = { ...service.txt, ...decodeTxt(record.data) };
      break;
    }
    case TYPE_A: {
      if (record.data.length !== 4) return;
      const ip = Array.from(record.data).join('.');
      const key = record.name.toLowerCase();
      const list = hostAddresses.get(key) ?? [];
      if (!list.includes(ip)) list.push(ip);
      hostAddresses.set(key, list);
      break;
    }
    default:
      break;
  }
}

export const MDNS_SERVICES = {
  hue: '_hue._tcp.local',
  shelly: '_shelly._tcp.local',
  http: '_http._tcp.local',
} as const;
