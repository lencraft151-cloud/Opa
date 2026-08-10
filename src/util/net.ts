import { readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';

export interface LocalSubnet {
  interfaceName: string;
  address: string;
  netmask: string;
  cidr: number;
  /** Anzahl adressierbarer Hosts im Subnetz. */
  hostCount: number;
}

function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`Ungültige IPv4-Adresse: ${ip}`);
  }
  return (((parts[0] as number) << 24) | ((parts[1] as number) << 16) | ((parts[2] as number) << 8) | (parts[3] as number)) >>> 0;
}

function intToIp(value: number): string {
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join('.');
}

function maskToCidr(netmask: string): number {
  const int = ipToInt(netmask);
  let cidr = 0;
  for (let i = 31; i >= 0; i--) {
    if ((int >>> i) & 1) cidr++;
    else break;
  }
  return cidr;
}

/** Alle privaten IPv4-Netze, in denen dieser Host steht. */
export function localSubnets(): LocalSubnet[] {
  const result: LocalSubnet[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      let cidr: number;
      try {
        cidr = maskToCidr(addr.netmask);
      } catch {
        continue;
      }
      result.push({
        interfaceName: name,
        address: addr.address,
        netmask: addr.netmask,
        cidr,
        hostCount: cidr >= 31 ? 0 : 2 ** (32 - cidr) - 2,
      });
    }
  }
  return result;
}

/**
 * Zählt die Host-Adressen eines Subnetzes auf. Netze, die größer als
 * `maxHosts` sind, werden auf das umgebende /24 der eigenen Adresse begrenzt –
 * ein /16 vollständig zu scannen wäre unbrauchbar langsam.
 */
export function enumerateHosts(subnet: LocalSubnet, maxHosts = 254): string[] {
  const own = ipToInt(subnet.address);
  let cidr = subnet.cidr;
  if (2 ** (32 - cidr) - 2 > maxHosts) cidr = 24;

  const mask = cidr === 0 ? 0 : (0xffffffff << (32 - cidr)) >>> 0;
  const network = (own & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  const hosts: string[] = [];
  for (let ip = network + 1; ip < broadcast && hosts.length < maxHosts; ip++) {
    if (ip === own) continue;
    hosts.push(intToIp(ip));
  }
  return hosts;
}

/** Alle scanbaren Host-Adressen aller lokalen Netze (dedupliziert). */
export function scannableHosts(maxHostsPerSubnet = 254): string[] {
  const seen = new Set<string>();
  for (const subnet of localSubnets()) {
    for (const host of enumerateHosts(subnet, maxHostsPerSubnet)) seen.add(host);
  }
  return [...seen];
}

/**
 * Wo der Router steht.
 *
 * Für die FRITZ!Box ist das die entscheidende Adresse: Sie *ist* in aller
 * Regel der Router. Die Suche kannte bisher nur `fritz.box` und AVMs
 * Werksadresse `192.168.178.1` – wer sein Netz auf `192.168.1.x` umgestellt
 * hat (oder einen Provider-Router mit anderer Voreinstellung nutzt), fand
 * seine Box nie, außer über den gründlichen Scan.
 *
 * Zwei Wege: die echte Standardroute aus `/proc/net/route`, und als Rückfall
 * die üblichen Verdächtigen `.1` und `.254` jedes lokalen Netzes. Der zweite
 * Weg kostet zwei Anfragen und funktioniert auch dort, wo es kein `/proc`
 * gibt.
 */
export function defaultGateways(): string[] {
  const found = new Set<string>();

  try {
    // Format: Iface Destination Gateway … – Adressen als Little-Endian-Hex.
    for (const line of readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 3 || columns[1] !== '00000000') continue;
      const hex = columns[2] as string;
      if (!/^[0-9A-Fa-f]{8}$/.test(hex) || hex === '00000000') continue;
      const value = Number.parseInt(hex, 16);
      // Little Endian: Die Bytes stehen in umgekehrter Reihenfolge.
      const ip = [value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255];
      found.add(ip.join('.'));
    }
  } catch {
    /* Kein /proc (macOS, Windows) – dann eben nur die Faustregel. */
  }

  for (const subnet of localSubnets()) {
    for (const host of enumerateHosts(subnet, 254).slice(0, 1)) found.add(host);
    const parts = subnet.address.split('.');
    if (parts.length === 4) found.add(`${parts[0]}.${parts[1]}.${parts[2]}.254`);
  }

  return [...found];
}

/**
 * Welche Adressen im Netz überhaupt jemand belegt.
 *
 * Der Grund für diese Funktion ist eine Rechnung: Vier Hersteller, die
 * jeweils 254 Adressen mit einer HTTP-Anfrage abklopfen, ergeben gut tausend
 * Anfragen – und knapp eine Minute Wartezeit, in der die Oberfläche stillsteht.
 * Dabei sind in einem Haushalt vielleicht zwanzig Adressen belegt; die
 * übrigen zweihundertdreißig kosten nur Zeit.
 *
 * Deshalb zuerst ein einziger, billiger Durchgang: eine TCP-Verbindung
 * aufbauen und sofort wieder auflegen. Wer antwortet, kommt in die Liste, die
 * sich dann alle Hersteller teilen.
 *
 * Ein abgewiesener Verbindungsversuch (`ECONNREFUSED`) zählt dabei als
 * Treffer: Da ist ein Gerät, es hört nur auf diesem Port nicht. Nur
 * Zeitüberschreitungen bedeuten „niemand da“ – so verhalten sich unbelegte
 * Adressen im lokalen Netz.
 */
export async function reachableHosts(
  hosts: readonly string[],
  options: {
    ports?: number[];
    timeoutMs?: number;
    concurrency?: number;
    /** Zweiter, geduldigerer Durchgang für alles, was nicht geantwortet hat. */
    retryTimeoutMs?: number;
    /**
     * Wie eine einzelne Adresse abgeklopft wird.
     *
     * Nur für Tests austauschbar: Ein echter Durchgang hängt davon ab, ob im
     * Netz gerade jemand schweigt – und das lässt sich nicht herstellen.
     */
    probe?: (host: string, ports: number[], timeoutMs: number) => Promise<boolean>;
  } = {},
): Promise<string[]> {
  const ports = options.ports ?? [80, 443];
  const timeoutMs = options.timeoutMs ?? 400;
  // Ein TCP-Verbindungsversuch kostet fast nichts; die Grenze schützt nur
  // davor, dem Betriebssystem die Dateideskriptoren auszugehen.
  const concurrency = options.concurrency ?? 128;
  /*
   * Warum ein zweiter Durchgang?
   *
   * 400 ms genügen einem Gerät am Kabel mühelos. Ein Shelly im WLAN, der
   * gerade aus dem Stromsparmodus kommt, braucht gelegentlich das Dreifache –
   * und fehlt dann in der Trefferliste. Beim nächsten Versuch ist er da, beim
   * übernächsten wieder nicht. Genau das ist das „ich muss fünfmal suchen".
   *
   * Der zweite Durchgang kostet nichts für die Adressen, hinter denen ohnehin
   * niemand ist – die sind schnell wieder weg –, und er läuft nur über das,
   * was beim ersten Mal geschwiegen hat.
   */
  const retryTimeoutMs = options.retryTimeoutMs ?? Math.max(timeoutMs, 1200);
  const probe = options.probe ?? anyPortAnswers;

  const sweep = async (candidates: readonly string[], budget: number): Promise<Set<string>> => {
    const found = new Set<string>();
    let index = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const current = index++;
        if (current >= candidates.length) return;
        const host = candidates[current] as string;
        if (await probe(host, ports, budget)) found.add(host);
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, candidates.length) }, worker),
    );
    return found;
  };

  const first = await sweep(hosts, timeoutMs);
  const silent = hosts.filter((host) => !first.has(host));

  if (silent.length > 0 && retryTimeoutMs > timeoutMs) {
    for (const host of await sweep(silent, retryTimeoutMs)) first.add(host);
  }

  return [...first].sort();
}

function anyPortAnswers(host: string, ports: number[], timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let open = 0;
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    for (const port of ports) {
      open++;
      const socket = new Socket();
      const close = (): void => {
        socket.removeAllListeners();
        socket.destroy();
        if (--open === 0) finish(false);
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => {
        socket.removeAllListeners();
        socket.destroy();
        finish(true);
      });
      socket.once('timeout', close);
      socket.once('error', (err: NodeJS.ErrnoException) => {
        // Abgewiesen heißt: Da ist jemand, nur nicht auf diesem Port.
        if (err.code === 'ECONNREFUSED') {
          socket.removeAllListeners();
          socket.destroy();
          finish(true);
          return;
        }
        close();
      });
      socket.connect(port, host);
    }
  });
}

const PRIVATE_RANGES: Array<[string, number]> = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['169.254.0.0', 16],
  ['127.0.0.0', 8],
];

/** Prüft, ob eine IPv4-Adresse in einem privaten Bereich liegt. */
export function isPrivateIPv4(ip: string): boolean {
  let value: number;
  try {
    value = ipToInt(ip);
  } catch {
    return false;
  }
  return PRIVATE_RANGES.some(([base, bits]) => {
    const mask = (0xffffffff << (32 - bits)) >>> 0;
    return (value & mask) >>> 0 === (ipToInt(base) & mask) >>> 0;
  });
}

/** true, wenn der String eine IPv4-Adresse ist. */
export function isIPv4(value: string): boolean {
  try {
    ipToInt(value);
    return true;
  } catch {
    return false;
  }
}
