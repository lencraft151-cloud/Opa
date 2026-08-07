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
