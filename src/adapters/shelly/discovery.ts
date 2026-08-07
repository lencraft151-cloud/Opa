import { createLogger } from '../../core/logger.js';
import { mapWithConcurrency } from '../../util/http.js';
import { browse, MDNS_SERVICES } from '../../util/mdns.js';
import { isIPv4, scannableHosts } from '../../util/net.js';
import type { DiscoverOptions, DiscoveredIntegration } from '../types.js';
import { ShellyClient, type ShellyProbe } from './client.js';

const log = createLogger('shelly:discovery');

/**
 * Shellys melden sich per mDNS als `_shelly._tcp` (Gen2+) bzw. als
 * `_http._tcp` mit `shelly`-Hostnamen (Gen1). Zusätzlich kann das Subnetz
 * gescannt werden – Batteriegeräte wie der H&T schlafen die meiste Zeit und
 * antworten auf mDNS nur direkt nach dem Aufwachen.
 */
export async function discoverShellyDevices(
  options: DiscoverOptions,
): Promise<DiscoveredIntegration[]> {
  const hosts = new Set<string>();

  // Beide Servicetypen gleichzeitig abfragen – nacheinander würde die
  // Discovery doppelt so lange dauern.
  const [shellyServices, httpServices] = await Promise.all([
    browse(MDNS_SERVICES.shelly, { timeoutMs: options.timeoutMs }).catch((err: Error) => {
      log.debug('mDNS-Suche (_shelly._tcp) fehlgeschlagen', { error: err.message });
      return [];
    }),
    browse(MDNS_SERVICES.http, { timeoutMs: options.timeoutMs }).catch(() => []),
  ]);

  for (const service of shellyServices) {
    const address = service.addresses.find(isIPv4);
    if (address) hosts.add(address);
  }

  // Gen1-Geräte melden sich nur als generischer HTTP-Dienst.
  for (const service of httpServices) {
    if (!/shelly/i.test(service.name) && !/shelly/i.test(service.host ?? '')) continue;
    const address = service.addresses.find(isIPv4);
    if (address) hosts.add(address);
  }

  const found = new Map<string, DiscoveredIntegration>();
  for (const entry of await probeHosts([...hosts], options.timeoutMs, 'mdns', 8)) {
    found.set(entry.host, entry);
  }

  if (options.allowScan) {
    const remaining = scannableHosts().filter((host) => !found.has(host));
    log.info('Starte Subnetz-Scan nach Shelly-Geräten', { hosts: remaining.length });
    for (const entry of await probeHosts(remaining, Math.min(options.timeoutMs, 1200), 'scan', 32)) {
      found.set(entry.host, entry);
    }
  }

  return [...found.values()];
}

function toDiscovered(
  host: string,
  probe: ShellyProbe,
  source: DiscoveredIntegration['source'],
): DiscoveredIntegration {
  const entry: DiscoveredIntegration = {
    type: 'shelly',
    host,
    externalId: probe.deviceId,
    name: probe.name ?? probe.app ?? probe.model,
    generation: probe.generation,
    authRequired: probe.authRequired,
    requiresLinkButton: false,
    source,
  };
  if (probe.model) entry.model = probe.model;
  return entry;
}

async function probeHosts(
  hosts: string[],
  timeoutMs: number,
  source: DiscoveredIntegration['source'],
  concurrency: number,
): Promise<DiscoveredIntegration[]> {
  const results = await mapWithConcurrency(hosts, concurrency, async (host) => {
    try {
      const probe = await ShellyClient.probe(host, timeoutMs);
      return toDiscovered(host, probe, source);
    } catch {
      return null;
    }
  });
  return results.filter((entry): entry is DiscoveredIntegration => entry !== null);
}
