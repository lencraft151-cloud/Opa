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

/**
 * Wie eine Aktualisierung hier ablaufen würde.
 *
 * - `pull` – es gibt eine Arbeitskopie, es wird nachgezogen.
 * - `bootstrap` – es gibt keine, der Hub holt sie sich zuerst.
 * - `none` – geht nicht; `reason` sagt, warum.
 */
export const UPDATE_MODES = ['pull', 'bootstrap', 'none'] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];

export interface Updatability {
  canUpdate: boolean;
  mode: UpdateMode;
  reason: string | null;
}

export interface HubVersionInfo {
  currentVersion: string;
  /**
   * Der Zweig, auf dem die Arbeitskopie steht – und der, der beim
   * Aktualisieren gezogen würde.
   *
   * Beides gehört sichtbar in die Oberfläche, weil genau hier der stille
   * Rückschritt entsteht: Wer den Hub von einem Zweig aufgesetzt hat und
   * dann aktualisiert, während `main` eingestellt ist, bekommt einen
   * *älteren* Stand – und wundert sich, warum alles weg ist.
   */
  branch: string | null;
  updateBranch: string;
  /** Die letzten sieben Stellen des Commits, für den Fall der Fälle. */
  commit: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** Alles, was zwischen der laufenden und der neuesten Fassung liegt. */
  pending: ChangelogEntry[];
  /** Der Abschnitt der laufenden Fassung – „was ist neu". */
  current: ChangelogEntry | null;
  checkedAt: string | null;
  canUpdate: boolean;
  /** Was beim Aktualisieren passieren würde – siehe `UpdateMode`. */
  mode: UpdateMode;
  reason: string | null;
}

export interface HubUpdateOptions {
  checkUrl: string | null;
  /** Wurzel der Installation. Standard: das Verzeichnis über `src`/`dist`. */
  root?: string;
  /**
   * Woher der Quelltext kommt, wenn noch keine Arbeitskopie da ist.
   * Ohne diese Adresse bleibt `bootstrap` verschlossen.
   */
  repoUrl?: string | null;
  /** Zweig, der gezogen wird. */
  branch?: string;
  /**
   * Verzeichnis mit Datenbank und Messwerten. Wird beim Ziehen der
   * Arbeitskopie geschützt: Liegt dort ein Pfad, den auch das Repository
   * führt, bricht der Hub ab, statt die Daten zu überschreiben.
   */
  dataDir?: string;
}

/**
 * Wie oft im Hintergrund nach einer neuen Fassung gesehen wird.
 *
 * Einmal am Tag genügt: Fassungen erscheinen nicht stündlich, und jede
 * Anfrage ist eine Verbindung nach außen, die ein Haushalts-Hub nicht ohne
 * Grund aufbaut.
 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Wie lange nach dem Start das erste Mal nachgesehen wird.
 *
 * Nicht sofort: Beim Start hat der Hub Wichtigeres zu tun, als eine fremde
 * Adresse anzufragen – Geräte abfragen zum Beispiel. Eine Minute ist lang
 * genug, dass alles andere steht, und kurz genug, dass man es noch mit dem
 * Start in Verbindung bringt.
 */
const FIRST_CHECK_DELAY_MS = 60 * 1000;

export class HubUpdateService {
  private lastCheckedAt: string | null = null;
  private latestVersion: string | null = null;
  private busy = false;
  private updatabilityCache: { at: number; value: Updatability } | null = null;
  /** Zuletzt gelesener Zweig der Arbeitskopie – siehe `branch`. */
  private checkedOutBranch: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private firstTimer: NodeJS.Timeout | null = null;
  /**
   * Welche Fassung schon angekündigt wurde.
   *
   * Ohne dieses Gedächtnis meldete sich der Hub bei jeder Prüfung erneut –
   * täglich dieselbe Nachricht über dieselbe Fassung. Eine Benachrichtigung,
   * die man schon dreimal weggeklickt hat, liest niemand mehr.
   */
  private announcedVersion: string | null = null;

  constructor(
    private readonly currentVersion: string,
    private readonly options: HubUpdateOptions = { checkUrl: null },
  ) {}

  /**
   * Sieht von sich aus nach neuen Fassungen und sagt Bescheid.
   *
   * Ohne eingestellte Prüfadresse passiert gar nichts – ein Haushalts-Hub
   * telefoniert nicht ungefragt nach Hause, und das gilt für den Takt genauso
   * wie für den Knopf.
   */
  start(householdId: string): void {
    this.stop();
    if (!this.options.checkUrl) {
      log.debug('Keine Prüfadresse gesetzt – es wird nicht von selbst nachgesehen');
      return;
    }

    const look = (): void => {
      void this.checkAndAnnounce(householdId);
    };

    this.firstTimer = setTimeout(look, FIRST_CHECK_DELAY_MS);
    this.firstTimer.unref?.();
    this.timer = setInterval(look, CHECK_INTERVAL_MS);
    this.timer.unref?.();
    log.info('Prüfung auf neue Fassungen läuft', { alleStunden: CHECK_INTERVAL_MS / 3600000 });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.firstTimer) clearTimeout(this.firstTimer);
    this.timer = null;
    this.firstTimer = null;
  }

  /**
   * Nachsehen – und, wenn etwas Neues da ist, es einmal sagen.
   *
   * Die Nachricht nennt die Fassung und die Überschrift dessen, was sich
   * geändert hat. „Ein Update ist verfügbar" allein beantwortet nämlich nicht
   * die einzige Frage, die man dann hat: ob es sich lohnt.
   */
  async checkAndAnnounce(householdId: string): Promise<HubVersionInfo | null> {
    let info: HubVersionInfo;
    try {
      info = await this.check();
    } catch (err) {
      // Kein Netz, kein Dienst: Das ist kein Fehler, über den jemand eine
      // Einblendung sehen muss. Beim nächsten Takt wieder.
      log.debug('Prüfung im Hintergrund fehlgeschlagen', { error: errorMessage(err) });
      return null;
    }

    this.announceIfNew(householdId, info);
    return info;
  }

  /**
   * Sagt einmal Bescheid, wenn diese Fassung noch nicht angekündigt wurde.
   *
   * Getrennt von `checkAndAnnounce`, weil auch der Knopf „Jetzt nachsehen"
   * hier durchkommen muss: Wer selbst nachsieht und etwas findet, soll den
   * Punkt an der Reiterleiste bekommen wie jeder andere auch – und nicht
   * erst beim nächsten Tagestakt.
   */
  announceIfNew(householdId: string, info: HubVersionInfo): boolean {
    if (!info.updateAvailable || !info.latestVersion) return false;
    if (info.latestVersion === this.announcedVersion) return false;

    this.announcedVersion = info.latestVersion;
    const headline = info.pending[0] ? firstSentence(info.pending[0].body) : null;

    events.emit('notification', {
      householdId,
      message: `Fassung ${info.latestVersion} ist da – du hast ${this.currentVersion}.`,
      level: 'info',
      source: 'hub-update',
      ...(headline ? { hint: headline } : {}),
    });
    log.info('Neue Fassung angekündigt', { fassung: info.latestVersion });
    return true;
  }

  private get root(): string {
    return this.options.root ?? PROJECT_ROOT;
  }

  /**
   * Der Zweig, der beim Aktualisieren gezogen wird.
   *
   * Ohne ausdrückliche Angabe **der Zweig, auf dem die Arbeitskopie steht** –
   * nicht `main`. Das ist die Reparatur eines Fehlers, der teuer war: Wer
   * seinen Hub von einem Entwicklungszweig aufgesetzt und dann den Knopf
   * „aktualisieren" gedrückt hat, wurde auf `main` gezogen und damit auf
   * einen viel älteren Stand zurückgeworfen. Die Aktualisierung soll den
   * Stand fortschreiben, auf dem man ist, und nicht heimlich den Zweig
   * wechseln.
   */
  private get branch(): string {
    return this.options.branch || this.checkedOutBranch || 'main';
  }

  /** Auf welchem Zweig steht die Arbeitskopie? `null` heißt: keine da. */
  private async readCheckout(): Promise<{ branch: string | null; commit: string | null }> {
    try {
      const [branch, commit] = await Promise.all([
        run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.root, timeout: 10_000 }),
        run('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: this.root, timeout: 10_000 }),
      ]);
      const name = branch.stdout.trim();
      return {
        // Ein losgelöster HEAD meldet „HEAD" – das ist kein Zweigname.
        branch: name && name !== 'HEAD' ? name : null,
        commit: commit.stdout.trim() || null,
      };
    } catch {
      return { branch: null, commit: null };
    }
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

    const { canUpdate, mode, reason } = await this.updatability();
    const checkout = await this.readCheckout();
    this.checkedOutBranch = checkout.branch;

    return {
      currentVersion: this.currentVersion,
      branch: checkout.branch,
      updateBranch: this.branch,
      commit: checkout.commit,
      latestVersion: latest,
      updateAvailable,
      pending,
      current,
      checkedAt: this.lastCheckedAt,
      canUpdate,
      mode,
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
   * Fehlt die Arbeitskopie, holt der Hub sie sich zuerst selbst (siehe
   * `bootstrapWorkingCopy`). Der Neustart bleibt Sache des Betriebssystems
   * (systemd, Docker, pm2); der Hub sagt das auch, statt so zu tun, als hätte
   * er ihn erledigt.
   */
  async install(householdId = ''): Promise<{ log: string[]; restartRequired: true }> {
    if (this.busy) {
      throw badRequest('Es läuft bereits eine Aktualisierung.');
    }
    const { canUpdate, mode, reason } = await this.updatability();
    if (!canUpdate) {
      throw badRequest(
        'Der Hub kann sich hier nicht selbst aktualisieren.',
        undefined,
        reason ?? 'Aktualisiere ihn so, wie du ihn installiert hast.',
      );
    }

    this.busy = true;
    const output: string[] = [];
    const step = async (command: string, args: string[]): Promise<void> => {
      log.info('Aktualisierung', { command, args });
      const { stdout, stderr } = await run(command, args, {
        cwd: this.root,
        timeout: 10 * 60 * 1000,
        maxBuffer: 4 * 1024 * 1024,
      });
      output.push(`$ ${command} ${args.join(' ')}`);
      const combined = `${stdout}${stderr}`.trim();
      if (combined) output.push(combined);
    };

    try {
      if (mode === 'bootstrap') await this.fetchSources(step);
      for (const [command, args] of UPDATE_STEPS) await step(command, args);
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
      // Aus „keine Arbeitskopie" ist gerade eine geworden.
      this.updatabilityCache = null;
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
   * Holt die Arbeitskopie nach, ohne die Daten anzufassen.
   *
   * Der Trick ist, dass Git nur *verfolgte* Dateien anfasst. Ein `git init`
   * im bestehenden Verzeichnis, ein flacher `fetch` und ein `checkout -f`
   * ersetzen den Quelltext – und lassen alles unberührt, was das Repository
   * nicht führt: `data/`, `.env`, `node_modules/`. Genau deshalb wird hier
   * nicht woandershin geklont und umkopiert: Was nicht bewegt wird, kann auch
   * nicht verlorengehen.
   *
   * Vorher wird geprüft, ob das Repository einen Pfad führt, unter dem die
   * Daten liegen. Wäre das so, würde `checkout -f` sie überschreiben – dann
   * bricht der Hub ab, statt es zu tun.
   */
  async fetchSources(
    step: (command: string, args: string[]) => Promise<void> = async (command, args) => {
      await run(command, args, { cwd: this.root, timeout: 10 * 60 * 1000 });
    },
  ): Promise<void> {
    const url = this.options.repoUrl;
    if (!url) throw new Error('Keine Adresse für den Quelltext hinterlegt.');

    log.info('Arbeitskopie wird nachgeholt', { url, branch: this.branch });

    await step('git', ['init']);
    // Ein zweiter Anlauf nach einem Fehlschlag soll nicht daran scheitern,
    // dass die Gegenstelle schon eingetragen ist.
    await step('git', ['remote', 'remove', 'origin']).catch(() => undefined);
    await step('git', ['remote', 'add', 'origin', url]);

    /*
     * Bewusst ohne `--depth 1`, obwohl das schneller wäre: Nach einem flachen
     * Erstabruf hat die nächste Aktualisierung keinen gemeinsamen Vorfahren
     * mehr und `git pull --ff-only` bricht mit „Not possible to fast-forward"
     * ab. Der Hub wäre also genau einmal aktualisierbar. Die vollständige
     * Historie einmal zu holen kostet ein paar Sekunden und spart diesen
     * Fehler für immer.
     */
    await step('git', ['fetch', 'origin', this.branch]);

    await this.assertDataSafe();

    // `-f` überschreibt verfolgte Dateien; unverfolgte bleiben liegen.
    await step('git', ['checkout', '-f', '-B', this.branch, 'FETCH_HEAD']);
    await step('git', ['branch', `--set-upstream-to=origin/${this.branch}`, this.branch]).catch(
      () => undefined,
    );

    // Aus „keine Arbeitskopie" ist gerade eine geworden.
    this.updatabilityCache = null;
  }

  /**
   * Führt das Repository einen Pfad, unter dem die Daten liegen?
   *
   * Der übliche Fall ist `DATA_DIR=./data` – im Repository steht `data/` in
   * `.gitignore` und wird nicht geführt, alles gut. Wer aber `DATA_DIR` auf
   * `./public` oder `./src` gesetzt hat, verlöre beim `checkout -f` seine
   * Datenbank. Lieber einmal zu viel nachgesehen.
   */
  private async assertDataSafe(): Promise<void> {
    const dataDir = this.options.dataDir;
    if (!dataDir) return;

    const relative = path.relative(this.root, path.resolve(dataDir));
    // Außerhalb der Installation (oder ein anderes Laufwerk) – unerreichbar
    // für den Checkout und damit sicher.
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;

    const { stdout } = await run('git', ['ls-tree', '-r', '--name-only', 'FETCH_HEAD'], {
      cwd: this.root,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const prefix = `${relative.split(path.sep).join('/')}/`;
    const collides = stdout
      .split('\n')
      .some((line) => line === relative || line.startsWith(prefix));

    if (collides) {
      throw new Error(
        `Die Daten liegen unter "${relative}" – einem Pfad, den auch der Quelltext führt. ` +
          'Ein Nachziehen würde sie überschreiben. Setze DATA_DIR auf ein Verzeichnis ' +
          'außerhalb der Installation und starte den Dienst neu.',
      );
    }
  }

  /**
   * Kann sich der Hub hier überhaupt selbst aktualisieren?
   *
   * Ruft `git` auf, deshalb kurz gepuffert: Die Oberfläche fragt den Zustand
   * bei jedem Öffnen der Einstellungen ab, und ein Prozessstart pro Klick
   * wäre für eine Antwort, die sich selten ändert, verschwendet.
   */
  private async updatability(): Promise<Updatability> {
    const cached = this.updatabilityCache;
    if (cached && Date.now() - cached.at < 60_000) return cached.value;

    const value = await this.probeUpdatability();
    this.updatabilityCache = { at: Date.now(), value };
    return value;
  }

  private async probeUpdatability(): Promise<Updatability> {
    // Ohne Git geht gar nichts – und das ist der eine Fall, den der Hub
    // wirklich nicht selbst lösen kann.
    try {
      await run('git', ['--version'], { cwd: this.root, timeout: 10_000 });
    } catch {
      return {
        canUpdate: false,
        mode: 'none',
        reason:
          'Auf diesem System ist git nicht installiert. Ohne git kommt der Hub nicht an ' +
          'seinen eigenen Quelltext. Unter Debian/Ubuntu: "apt install git".',
      };
    }

    let porcelain: string;
    try {
      const result = await run('git', ['status', '--porcelain'], {
        cwd: this.root,
        timeout: 10_000,
      });
      porcelain = result.stdout;
    } catch {
      // Keine Arbeitskopie – etwa ein entpacktes Archiv oder ein Abbild ohne
      // `.git`. Der Hub holt sie sich, sofern er weiß, woher.
      if (!this.options.repoUrl) {
        return {
          canUpdate: false,
          mode: 'none',
          reason:
            'Der Hub läuft nicht aus einer Git-Arbeitskopie, und es ist keine Adresse für ' +
            'den Quelltext hinterlegt. Trage HUB_REPO_URL ein – dann holt er sie sich beim ' +
            'nächsten Mal selbst.',
        };
      }
      return {
        canUpdate: true,
        mode: 'bootstrap',
        reason:
          'Der Hub läuft nicht aus einer Git-Arbeitskopie. Er holt sie sich beim ' +
          'Aktualisieren selbst; Datenbank, Messwerte und Einstellungen bleiben dabei liegen.',
      };
    }

    const blocking = blockingChanges(porcelain);
    if (blocking.length > 0) {
      return {
        canUpdate: false,
        mode: 'none',
        reason:
          `In der Arbeitskopie liegen geänderte Dateien (${blocking.slice(0, 3).join(', ')}` +
          `${blocking.length > 3 ? ` und ${blocking.length - 3} weitere` : ''}). ` +
          'Eine Aktualisierung würde sie überschreiben. Deine Daten sind davon nicht ' +
          'betroffen – gemeint sind Änderungen am Quelltext selbst.',
      };
    }

    return { canUpdate: true, mode: 'pull', reason: null };
  }
}

/**
 * Welche Einträge aus `git status --porcelain` einer Aktualisierung wirklich
 * im Weg stehen.
 *
 * Nur geänderte **verfolgte** Dateien. Unverfolgtes (`??`) fasst ein
 * `git pull --ff-only` nicht an – und unverfolgt ist alles, was einen Hub
 * ausmacht, aber nicht zum Quelltext gehört: `data/`, `.env`, `node_modules/`,
 * ein dort abgelegtes Skript. Die vorige Fassung hat das alles als Hindernis
 * gewertet und damit auf einer ganz normalen Installation jede Aktualisierung
 * verweigert.
 */
export function blockingChanges(porcelain: string): string[] {
  const files: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (line.length < 4) continue;
    if (line.startsWith('??') || line.startsWith('!!')) continue;
    // Format: XY<Leerzeichen>Pfad, bei Umbenennungen "alt -> neu".
    const file = line.slice(3).trim();
    const renamed = file.split(' -> ').pop();
    if (renamed) files.push(renamed);
  }
  return files;
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

/**
 * Der erste vollständige Satz eines Änderungsabschnitts.
 *
 * Gebraucht für die Einblendung: Dort ist Platz für eine Zeile, und diese
 * eine Zeile soll die Frage beantworten, ob sich das Aktualisieren lohnt.
 * Markdown-Auszeichnung wird entfernt – ein `**fett**` mitten im Popup sähe
 * nach einem Fehler aus.
 */
export function firstSentence(markdown: string, maxLength = 160): string | null {
  const text = markdown
    .split('\n')
    // Überschriften und Listenzeichen tragen hier nichts bei.
    .filter((line) => line.trim() && !line.startsWith('#'))
    .join(' ')
    .replace(/[*_`]/g, '')
    .replace(/^[-–]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;

  /*
   * Satzende suchen – aber nicht mitten in „z. B." abschneiden.
   *
   * Nach einem Leerzeichen und einem Großbuchstaben zu suchen genügt nicht:
   * Genau so sieht auch eine Abkürzung aus. Deshalb zusätzlich die
   * Bedingung, dass vor dem Punkt kein *einzelner* Buchstabe steht – „z."
   * und „B." fallen damit raus, „Suche." nicht.
   */
  const end = text.search(/(?<![\s(][A-Za-zÄÖÜäöü])[.!?](\s+[A-ZÄÖÜ]|$)/);
  const sentence = end === -1 ? text : text.slice(0, end + 1);
  return sentence.length > maxLength ? `${sentence.slice(0, maxLength - 1).trimEnd()}…` : sentence;
}
