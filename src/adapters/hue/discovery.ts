import { createLogger } from '../../core/logger.js';
import { requestJson, mapWithConcurrency } from '../../util/http.js';
import { browse, MDNS_SERVICES } from '../../util/mdns.js';
import { isIPv4, scannableHosts } from '../../util/net.js';
import type { DiscoverOptions, DiscoveredIntegration } from '../types.js';
import { HueClient } from './client.js';

const log = createLogger('hue:discovery');

const CLOUD_DISCOVERY_URL = 'https://discovery.meethue.com/';

interface CloudEntry {
  id: string;
  internalipaddress: string;
  port?: number;
}

/**
 * Sucht Hue Bridges auf drei Wegen:
 *  1. mDNS (`_hue._tcp`) – rein lokal, funktioniert ohne Internet
 *  2. Philips Cloud-Discovery – findet Bridges auch bei zickigem Multicast
 *  3. Subnetz-Scan auf `/api/config` – letzter Ausweg
 */
export async function discoverHueBridges(
  options: DiscoverOptions,
): Promise<DiscoveredIntegration[]> {
  const found = new Map<string, DiscoveredIntegration>();

  const add = (entry: DiscoveredIntegration): void => {
    const existing = found.get(entry.externalId.toLowerCase());
    if (existing) {
      // mDNS/Scan-Treffer sind verlässlicher als der Cloud-Eintrag.
      if (existing.source === 'cloud' && entry.source !== 'cloud') {
        found.set(entry.externalId.toLowerCase(), entry);
      }
      return;
    }
    found.set(entry.externalId.toLowerCase(), entry);
  };

  const tasks: Array<Promise<void>> = [
    discoverViaMdns(options.timeoutMs)
      .then((entries) => entries.forEach(add))
      .catch((err) => log.debug('mDNS-Suche fehlgeschlagen', { error: (err as Error).message })),
  ];

  if (options.allowCloud) {
    tasks.push(
      discoverViaCloud(options.timeoutMs)
        .then((entries) => entries.forEach(add))
        .catch((err) =>
          log.debug('Cloud-Discovery fehlgeschlagen', { error: (err as Error).message }),
        ),
    );
  }

  await Promise.all(tasks);

  /*
   * Der Scan lief bisher nur, wenn gar nichts gefunden wurde. Wer zwei
   * Bridges hat und von denen eine per mDNS meldet, bekam die zweite nie zu
   * sehen. Wenn der Nutzer "gründlich suchen" wählt, wird jetzt immer
   * gescannt – bereits gefundene Hosts werden dabei übersprungen.
   */
  if (options.allowScan) {
    const known = new Set([...found.values()].map((entry) => entry.host));
    log.info('Starte Subnetz-Scan nach Hue Bridges', { bereitsGefunden: known.size });
    for (const entry of await discoverViaScan(options.timeoutMs, known)) add(entry);
  }

  return [...found.values()];
}

async function discoverViaMdns(timeoutMs: number): Promise<DiscoveredIntegration[]> {
  const services = await browse(MDNS_SERVICES.hue, { timeoutMs });
  const candidates = services
    .map((service) => ({
      host: service.addresses.find(isIPv4) ?? service.host ?? '',
      bridgeId: service.txt['bridgeid'] ?? '',
      modelId: service.txt['modelid'],
    }))
    .filter((entry) => entry.host !== '');

  return probeHosts(
    candidates.map((c) => c.host),
    timeoutMs,
    'mdns',
  );
}

async function discoverViaCloud(timeoutMs: number): Promise<DiscoveredIntegration[]> {
  const entries = await requestJson<CloudEntry[]>(CLOUD_DISCOVERY_URL, { timeoutMs });
  return entries
    .filter((entry) => entry.internalipaddress)
    .map((entry) => ({
      type: 'hue' as const,
      host: entry.internalipaddress,
      externalId: entry.id,
      name: 'Hue Bridge',
      requiresLinkButton: true,
      source: 'cloud' as const,
    }));
}

async function discoverViaScan(
  timeoutMs: number,
  skip: ReadonlySet<string> = new Set(),
): Promise<DiscoveredIntegration[]> {
  const hosts = scannableHosts().filter((host) => !skip.has(host));
  // Kurzes Timeout pro Host, sonst dauert ein /24-Scan Minuten.
  return probeHosts(hosts, Math.min(timeoutMs, 1200), 'scan', 32);
}

async function probeHosts(
  hosts: string[],
  timeoutMs: number,
  source: DiscoveredIntegration['source'],
  concurrency = 8,
): Promise<DiscoveredIntegration[]> {
  const results = await mapWithConcurrency(hosts, concurrency, async (host) => {
    try {
      const config = await HueClient.fetchBridgeConfig(host, timeoutMs);
      const entry: DiscoveredIntegration = {
        type: 'hue',
        host,
        externalId: config.bridgeid,
        name: config.name || 'Hue Bridge',
        requiresLinkButton: true,
        source,
      };
      if (config.modelid) entry.model = config.modelid;
      return entry;
    } catch {
      return null;
    }
  });
  return results.filter((entry): entry is DiscoveredIntegration => entry !== null);
}
