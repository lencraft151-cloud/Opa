import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { badRequest, errorMessage } from '../core/errors.js';
import { events } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import { requestJson } from '../util/http.js';
import { nowIso } from '../util/id.js';

const log = createLogger('hub-update');
const run = promisify(execFile);

/** Wurzel des Projekts – `src/` bzw. `dist/` liegt eine Ebene darunter. */
const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Aktualisierung des Hubs selbst.
 *
 * Zu unterscheiden von den Firmware-Updates der Geräte (`updateService.ts`) –
 * hier geht es um die Software, die diesen Dienst ausmacht.
 *
 * Drei Dinge macht der Hub, und drei bewusst nicht:
 *
 * - **Er liest sein eigenes Änderungsprotokoll.** `CHANGELOG.md` liegt neben
 *   dem Code; die Abschnitte werden nach Version zerlegt und angezeigt.
 * - **Er fragt nach, ob es eine neuere Fassung gibt** – aber nur, wenn das
 *   eingeschaltet ist. Ein Haushalts-Hub telefoniert nicht ungefragt nach
 *   Hause.
 * - **Er stößt die Aktualisierung an**, wenn er aus einer Git-Arbeitskopie
 *   läuft.
 *
 * Nicht: heimlich im Hintergrund aktualisieren, ohne Rückfrage neu starten,
 * oder behaupten, es hätte geklappt, wenn der Neustart Sache des
 * Betriebssystems ist.
 */

export interface ChangelogEntry {
  version: string;
  date: string | null;
  /** Der Abschnitt als Markdown, ohne die Überschrift. */
  body: string;
}

export interface HubVersionInfo {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** Alles, was zwischen der laufenden und der neuesten Fassung liegt. */
  pending: ChangelogEntry[];
  /** Der Abschnitt der laufenden Fassung – „was ist neu". */
  current: ChangelogEntry | null;
  checkedAt: string | null;
  /** Läuft der Hub aus einer Git-Arbeitskopie? Sonst geht kein Update. */
  canUpdate: boolean;
  reason: string | null;
}

export class HubUpdateService {
  private lastCheckedAt: string | null = null;
  private latestVersion: string | null = null;
  private busy = false;
  private updatabilityCache: {
    at: number;
    value: { canUpdate: boolean; reason: string | null };
  } | null = null;

  constructor(
    private readonly currentVersion: string,
    private readonly options: { checkUrl: string | null; root?: string } = { checkUrl: null },
  ) {}

  private get root(): string {
    return this.options.root ?? PROJECT_ROOT;
  }

  /** Zustand für die Oberfläche. */
  async info(): Promise<HubVersionInfo> {
    const entries = await this.changelog();
    const current = entries.find((entry) => entry.version === this.currentVersion) ?? null;
    const latest = this.latestVersion ?? entries[0]?.version ?? null;

    const updateAvailable = latest !== null && compareVersions(latest, this.currentVersion) > 0;
    const pending = updateAvailable
      ? entries.filter(
          (entry) =>
            compareVersions(entry.version, this.currentVersion) > 0 &&
            compareVersions(entry.version, latest) <= 0,
        )
      : [];

    const { canUpdate, reason } = await this.updatability();

    return {
      currentVersion: this.currentVersion,
      latestVersion: latest,
      updateAvailable,
      pending,
      current,
      checkedAt: this.lastCheckedAt,
      canUpdate,
      reason,
    };
  }

  /**
   * Liest `CHANGELOG.md` und zerlegt es in Abschnitte.
   *
   * Bewusst kein Markdown-Parser: Gebraucht wird nur die Überschriftzeile,
   * alles darunter geht unverändert an die Oberfläche.
   */
  async changelog(): Promise<ChangelogEntry[]> {
    let text: string;
    try {
      text = await readFile(path.join(this.root, 'CHANGELOG.md'), 'utf8');
    } catch {
      return [];
    }
    return parseChangelog(text);
  }

  /**
   * Fragt nach der neuesten Fassung.
   *
   * Ohne eingestellte Adresse passiert nichts – ein Haushalts-Hub soll nicht
   * ungefragt ins Internet telefonieren.
   */
  async check(): Promise<HubVersionInfo> {
    if (!this.options.checkUrl) {
      this.lastCheckedAt = nowIso();
      return this.info();
    }

    try {
      const release = await requestJson<{ tag_name?: string; name?: string }>(
        this.options.checkUrl,
        { timeoutMs: 8000, headers: { accept: 'application/vnd.github+json' } },
      );
      const tag = release.tag_name ?? release.name ?? '';
      const version = tag.replace(/^v/i, '').trim();
      if (version) this.latestVersion = version;
      this.lastCheckedAt = nowIso();
      log.info('Nach neuer Fassung gesehen', { latest: this.latestVersion });
    } catch (err) {
      log.warn('Versionsprüfung fehlgeschlagen', { error: errorMessage(err) });
      throw badRequest(
        'Die Prüfung auf eine neue Fassung hat nicht geklappt.',
        undefined,
        'Hat der Hub Internetzugang? Ohne ihn bleibt die eingebaute Liste der Änderungen die einzige Auskunft.',
      );
    }

    return this.info();
  }

  /**
   * Stößt die Aktualisierung an.
   *
   * Läuft nur aus einer Git-Arbeitskopie und nur, wenn dort nichts
   * Ungespeichertes liegt – sonst würden eigene Änderungen überschrieben.
   * Der Neustart ist Sache des Betriebssystems (systemd, Docker, pm2); der
   * Hub sagt das auch, statt so zu tun, als hätte er ihn erledigt.
   */
  async install(householdId = ''): Promise<{ log: string[]; restartRequired: true }> {
    if (this.busy) {
      throw badRequest('Es läuft bereits eine Aktualisierung.');
    }
    const { canUpdate, reason } = await this.updatability();
    if (!canUpdate) {
      throw badRequest(
        'Der Hub kann sich hier nicht selbst aktualisieren.',
        undefined,
        reason ?? 'Aktualisiere ihn so, wie du ihn installiert hast.',
      );
    }

    this.busy = true;
    const output: string[] = [];
    try {
      for (const [command, args] of UPDATE_STEPS) {
        log.info('Aktualisierung', { command, args });
        const { stdout, stderr } = await run(command, args, {
          cwd: this.root,
          timeout: 10 * 60 * 1000,
          maxBuffer: 4 * 1024 * 1024,
        });
        output.push(`$ ${command} ${args.join(' ')}`);
        const combined = `${stdout}${stderr}`.trim();
        if (combined) output.push(combined);
      }
    } catch (err) {
      const message = errorMessage(err);
      output.push(`Fehlgeschlagen: ${message}`);
      log.warn('Aktualisierung fehlgeschlagen', { error: message });
      throw badRequest(
        'Die Aktualisierung ist fehlgeschlagen.',
        { log: output },
        'Der bisherige Stand läuft weiter. Die Ausgabe unten sagt, woran es lag.',
      );
    } finally {
      this.busy = false;
    }

    // Auch die anderen offenen Fenster sollen es erfahren – wer gerade in
    // einem zweiten Tab arbeitet, soll nicht rätseln, warum der Dienst gleich
    // kurz weg ist.
    events.emit('notification', {
      householdId,
      message: 'Der Hub wurde aktualisiert. Ein Neustart des Dienstes schließt es ab.',
      level: 'info',
    });

    return { log: output, restartRequired: true };
  }

  /**
   * Kann sich der Hub hier überhaupt selbst aktualisieren?
   *
   * Ruft `git` auf, deshalb kurz gepuffert: Die Oberfläche fragt den Zustand
   * bei jedem Öffnen der Einstellungen ab, und ein Prozessstart pro Klick
   * wäre für eine Antwort, die sich selten ändert, verschwendet.
   */
  private async updatability(): Promise<{ canUpdate: boolean; reason: string | null }> {
    const cached = this.updatabilityCache;
    if (cached && Date.now() - cached.at < 60_000) return cached.value;

    const value = await this.probeUpdatability();
    this.updatabilityCache = { at: Date.now(), value };
    return value;
  }

  private async probeUpdatability(): Promise<{ canUpdate: boolean; reason: string | null }> {
    try {
      const { stdout } = await run('git', ['status', '--porcelain'], {
        cwd: this.root,
        timeout: 10_000,
      });
      if (stdout.trim()) {
        return {
          canUpdate: false,
          reason:
            'In der Arbeitskopie liegen ungespeicherte Änderungen. Eine Aktualisierung würde sie überschreiben.',
        };
      }
      return { canUpdate: true, reason: null };
    } catch {
      return {
        canUpdate: false,
        reason:
          'Der Hub läuft nicht aus einer Git-Arbeitskopie – etwa in einem fertigen Docker-Abbild. ' +
          'Dort aktualisiert man ihn über das Abbild.',
      };
    }
  }
}

/**
 * Die Schritte einer Aktualisierung.
 *
 * `git pull --ff-only` weigert sich, wenn die Historie auseinandergelaufen
 * ist – lieber ein klarer Fehler als ein halb zusammengeführter Stand.
 */
const UPDATE_STEPS: Array<[string, string[]]> = [
  ['git', ['pull', '--ff-only']],
  ['npm', ['install', '--omit=dev', '--no-audit', '--no-fund']],
  ['npm', ['run', 'build']],
];

/**
 * Zerlegt ein Änderungsprotokoll in Abschnitte.
 *
 * Erwartet Überschriften der Form `## 1.2.0 – 2026-08-08`. Das Datum ist
 * optional, der Trenner darf Gedankenstrich oder Bindestrich sein.
 */
export function parseChangelog(text: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  const lines = text.split('\n');
  let current: ChangelogEntry | null = null;
  let body: string[] = [];

  const flush = (): void => {
    if (!current) return;
    entries.push({ ...current, body: body.join('\n').trim() });
    body = [];
  };

  for (const line of lines) {
    const heading = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:[–—-]\s*(.+))?$/.exec(line.trim());
    if (heading) {
      flush();
      current = {
        version: heading[1] as string,
        date: heading[2]?.trim() || null,
        body: '',
      };
      continue;
    }
    if (current) body.push(line);
  }
  flush();

  return entries;
}

/**
 * Vergleicht zwei Versionen nach ihren Zahlen.
 * Gibt >0, wenn `a` neuer ist als `b`.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/i, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);

  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
