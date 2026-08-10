import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LOG_LEVELS, type LogLevel } from './core/logger.js';

/**
 * Minimaler .env-Loader – bewusst ohne Abhängigkeit auf `dotenv`.
 * Bereits gesetzte Umgebungsvariablen haben Vorrang.
 */
export function loadDotEnv(file = '.env'): void {
  const full = path.resolve(process.cwd(), file);
  if (!existsSync(full)) return;
  const content = readFileSync(full, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Wo dieser Hub herkommt.
 *
 * Steht als Vorgabe hier, damit eine Installation ohne `.git` – ein
 * entpacktes Archiv, ein Abbild ohne Historie – sich trotzdem aktualisieren
 * kann, ohne dass jemand erst eine Adresse eintragen muss. Wer einen eigenen
 * Abzug betreibt, überschreibt sie mit `HUB_REPO_URL`.
 */
const DEFAULT_REPO_URL = 'https://github.com/lencraft151-cloud/Opa';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Umgebungsvariable ${name} muss eine Zahl sein (erhalten: "${raw}")`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  databaseFile: string;
  telemetryDir: string;
  secretKey: string;
  authDisabled: boolean;
  pollIntervalSeconds: number;
  telemetryRetentionDays: number;
  telemetryMinIntervalSeconds: number;
  allowCloudDiscovery: boolean;
  discoveryTimeoutMs: number;
  /**
   * Adresse, unter der nach einer neueren Fassung des Hubs gefragt wird –
   * etwa die Releases-API des Projekts. Leer heißt: gar nicht fragen. Ein
   * Haushalts-Hub telefoniert nicht ungefragt nach Hause.
   */
  hubUpdateCheckUrl: string | null;
  /**
   * Woher der Hub seinen Quelltext holt, wenn keine Git-Arbeitskopie da ist
   * (entpacktes Archiv, Abbild ohne `.git`). Er zieht sie dann beim
   * Aktualisieren selbst nach – die Daten bleiben unangetastet.
   */
  hubRepoUrl: string | null;
  /** Zweig, der dabei gezogen wird. */
  hubBranch: string;
  logLevel: LogLevel;
  /** Woher der Verschlüsselungsschlüssel kam – nur fürs Protokoll. */
  secretKeySource: 'env' | 'file' | 'created';
  /** Hinweis zum Datenordner (Umzug, Problem) – `null`, wenn alles still lief. */
  dataDirNote: string | null;
}

/**
 * Wo die Daten liegen, wenn niemand etwas anderes sagt.
 *
 * **Außerhalb der Arbeitskopie.** Das ist der ganze Punkt: Datenbank,
 * Messwerte und Schlüssel gehören nicht in den Ordner, den man beim
 * Aktualisieren austauscht. Wer sich die neueste Fassung von GitHub holt –
 * per `git pull`, als Archiv oder als frischer Klon –, soll danach seinen
 * Haushalt vorfinden und nicht den Einrichtungsassistenten.
 *
 * Verwendet werden die üblichen Orte des jeweiligen Systems:
 * `%APPDATA%` unter Windows, sonst `$XDG_DATA_HOME` bzw. `~/.local/share`.
 */
export function defaultDataDir(): string {
  const home = os.homedir();

  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    if (appData) return path.join(appData, 'smarthome-hub');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'smarthome-hub');
  }

  const xdg = process.env['XDG_DATA_HOME'];
  if (xdg) return path.join(xdg, 'smarthome-hub');
  return path.join(home, '.local', 'share', 'smarthome-hub');
}

/**
 * Bestimmt den Datenordner und holt einen alten Bestand nach.
 *
 * Drei Fälle, in dieser Reihenfolge:
 *
 * 1. `DATA_DIR` ist gesetzt – dann gilt genau das. Wer den Ort selbst
 *    bestimmt hat (Docker-Volume, eigene Platte), soll nicht umgezogen werden.
 * 2. Im Projektordner liegt noch der alte `./data`-Bestand und am neuen Ort
 *    nichts. Dann wandert er einmalig um. Genau dieser Schritt ist der
 *    Unterschied zwischen „nach dem Update ist alles weg" und „nach dem
 *    Update ist alles da".
 * 3. Sonst der Ort aus `defaultDataDir()`.
 *
 * Schlägt der Umzug fehl – etwa über Dateisystemgrenzen hinweg –, bleibt der
 * alte Ort in Betrieb. Ein Hub, der wegen eines misslungenen Umzugs gar nicht
 * startet, wäre die schlechtere Antwort.
 */
export function resolveDataDir(cwd = process.cwd()): {
  dir: string;
  movedFrom: string | null;
  note: string | null;
} {
  const explicit = str('DATA_DIR', '');
  if (explicit) return { dir: path.resolve(cwd, explicit), movedFrom: null, note: null };

  const target = defaultDataDir();
  const legacy = path.resolve(cwd, 'data');

  const hasLegacy = existsSync(path.join(legacy, 'smarthome.json'));
  const hasTarget = existsSync(path.join(target, 'smarthome.json'));

  if (!hasLegacy || hasTarget) return { dir: target, movedFrom: null, note: null };

  try {
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(legacy, target);
    return {
      dir: target,
      movedFrom: legacy,
      note: `Der Datenordner ist nach ${target} umgezogen – dort überlebt er jede Aktualisierung.`,
    };
  } catch (err) {
    return {
      dir: legacy,
      movedFrom: null,
      note:
        `Der Datenordner konnte nicht nach ${target} umziehen (${(err as Error).message}). ` +
        'Der Hub läuft vorerst weiter aus dem Projektordner – bitte den Ordner von Hand ' +
        'verschieben oder DATA_DIR setzen, sonst geht er beim nächsten Neu-Herunterladen verloren.',
    };
  }
}

/**
 * Der Schlüssel, mit dem Zugangsdaten verschlüsselt werden.
 *
 * Er liegt **im Datenordner**, nicht in der `.env` neben dem Quelltext. Das
 * ist der zweite Teil derselben Sache: Ein Schlüssel, der beim Austauschen
 * des Projektordners verschwindet, macht sämtliche gespeicherten Zugangsdaten
 * unlesbar – Bridges müssten neu gekoppelt werden, obwohl die Datenbank noch
 * da ist.
 *
 * `SECRET_KEY` aus der Umgebung hat weiterhin Vorrang (Docker, systemd). Ist
 * er gesetzt und liegt noch keine Datei vor, wird er einmal dorthin
 * geschrieben – damit er auch dann noch da ist, wenn die `.env` einmal fehlt.
 *
 * Ehrlich dazugesagt: Der Schlüssel schützt die *Sicherungsdatei* und die
 * Datenbank für sich genommen, nicht gegen jemanden, der ohnehin Zugriff auf
 * den ganzen Datenordner hat. Für einen Hub im eigenen Haushalt ist das der
 * richtige Tausch – die Alternative wäre eine Passworteingabe bei jedem Start.
 */
export function loadOrCreateSecretKey(dataDir: string): {
  key: string;
  source: 'env' | 'file' | 'created';
} {
  const file = path.join(dataDir, 'secret.key');
  const fromEnv = str('SECRET_KEY', '');

  mkdirSync(dataDir, { recursive: true });

  if (fromEnv) {
    if (!existsSync(file)) writeFileSync(file, fromEnv, { encoding: 'utf8', mode: 0o600 });
    return { key: fromEnv, source: 'env' };
  }

  if (existsSync(file)) {
    const stored = readFileSync(file, 'utf8').trim();
    if (stored) return { key: stored, source: 'file' };
  }

  const created = randomBytes(32).toString('hex');
  writeFileSync(file, created, { encoding: 'utf8', mode: 0o600 });
  return { key: created, source: 'created' };
}

export function loadConfig(): AppConfig {
  const location = resolveDataDir();
  const dataDir = location.dir;
  const rawLevel = str('LOG_LEVEL', 'info') as LogLevel;
  const logLevel = LOG_LEVELS.includes(rawLevel) ? rawLevel : 'info';

  const authDisabled = bool('AUTH_DISABLED', false);
  /*
   * Kein `SECRET_KEY`? Dann legt der Hub selbst einen an – im Datenordner.
   * Früher verweigerte er hier den Start. Das war für einen Haushalts-Hub die
   * falsche Hürde: Wer ihn frisch herunterlädt, will ihn starten, nicht erst
   * eine Zufallszahl erzeugen und in eine Datei schreiben.
   */
  const secret = loadOrCreateSecretKey(dataDir);

  return {
    port: num('PORT', 8080),
    host: str('HOST', '0.0.0.0'),
    dataDir,
    databaseFile: path.join(dataDir, 'smarthome.json'),
    telemetryDir: path.join(dataDir, 'telemetry'),
    secretKey: secret.key,
    secretKeySource: secret.source,
    dataDirNote: location.note,
    authDisabled,
    pollIntervalSeconds: Math.max(5, num('POLL_INTERVAL_SECONDS', 15)),
    telemetryRetentionDays: Math.max(1, num('TELEMETRY_RETENTION_DAYS', 90)),
    telemetryMinIntervalSeconds: Math.max(0, num('TELEMETRY_MIN_INTERVAL_SECONDS', 60)),
    allowCloudDiscovery: bool('ALLOW_CLOUD_DISCOVERY', true),
    discoveryTimeoutMs: Math.max(500, num('DISCOVERY_TIMEOUT_MS', 5000)),
    hubUpdateCheckUrl: str('HUB_UPDATE_CHECK_URL', '') || null,
    hubRepoUrl: str('HUB_REPO_URL', DEFAULT_REPO_URL) || null,
    hubBranch: str('HUB_BRANCH', 'main'),
    logLevel,
  };
}
