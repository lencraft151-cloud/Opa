import { createHash } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../core/logger.js';

const log = createLogger('assets');

/**
 * Kennung der ausgelieferten Oberfläche.
 *
 * Die Weboberfläche fragt sie regelmäßig ab und lädt sich neu, sobald sie
 * sich ändert. Ohne so eine Kennung müsste man nach jedem Update von Hand
 * den Zwischenspeicher leeren – auf dem Handy findet diesen Knopf kaum
 * jemand.
 *
 * Gebildet wird sie aus Pfad, Größe und Änderungszeit aller Dateien unter
 * `public/`. Das ist stabil (gleicher Stand ⇒ gleiche Kennung), erkennt
 * jede Änderung und kostet keine Datei-Lesevorgänge.
 */

/** Wie lange eine berechnete Kennung wiederverwendet wird. */
const CACHE_MS = 15_000;

let cached: { value: string; at: number } | null = null;

export async function assetVersion(dir: string): Promise<string> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;

  const hash = createHash('sha256');
  try {
    for (const file of await collect(dir)) {
      const info = await stat(file);
      hash.update(`${path.relative(dir, file)}:${info.size}:${Math.round(info.mtimeMs)}\n`);
    }
  } catch (err) {
    // Ohne lesbare Dateien gibt es nichts zu vergleichen – dann bleibt die
    // Oberfläche eben so, wie sie ist. Ein Fehler wäre hier übertrieben.
    log.debug('Kennung der Oberfläche nicht ermittelbar', { error: String(err) });
    return 'unbekannt';
  }

  const value = hash.digest('hex').slice(0, 12);
  cached = { value, at: Date.now() };
  return value;
}

/** Nur für Tests: erzwingt eine Neuberechnung. */
export function resetAssetVersionCache(): void {
  cached = null;
}

async function collect(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}
