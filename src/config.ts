import { existsSync, readFileSync } from 'node:fs';
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
  logLevel: LogLevel;
}

export function loadConfig(): AppConfig {
  const dataDir = path.resolve(process.cwd(), str('DATA_DIR', './data'));
  const rawLevel = str('LOG_LEVEL', 'info') as LogLevel;
  const logLevel = LOG_LEVELS.includes(rawLevel) ? rawLevel : 'info';

  const authDisabled = bool('AUTH_DISABLED', false);
  const secretKey = str('SECRET_KEY', '');

  if (!secretKey && !authDisabled) {
    throw new Error(
      'SECRET_KEY ist nicht gesetzt. Ohne diesen Schlüssel können Zugangsdaten von Hue/Shelly ' +
        'nicht verschlüsselt gespeichert werden.\n' +
        'Erzeugen mit: node -e "console.log(crypto.randomBytes(32).toString(\'hex\'))"',
    );
  }

  return {
    port: num('PORT', 8080),
    host: str('HOST', '0.0.0.0'),
    dataDir,
    databaseFile: path.join(dataDir, 'smarthome.json'),
    telemetryDir: path.join(dataDir, 'telemetry'),
    // Ohne SECRET_KEY (nur bei AUTH_DISABLED) wird ein deterministischer
    // Entwicklungsschlüssel benutzt, damit der Hub überhaupt startet.
    secretKey: secretKey || 'insecure-development-key',
    authDisabled,
    pollIntervalSeconds: Math.max(5, num('POLL_INTERVAL_SECONDS', 15)),
    telemetryRetentionDays: Math.max(1, num('TELEMETRY_RETENTION_DAYS', 90)),
    telemetryMinIntervalSeconds: Math.max(0, num('TELEMETRY_MIN_INTERVAL_SECONDS', 60)),
    allowCloudDiscovery: bool('ALLOW_CLOUD_DISCOVERY', true),
    discoveryTimeoutMs: Math.max(500, num('DISCOVERY_TIMEOUT_MS', 5000)),
    hubUpdateCheckUrl: str('HUB_UPDATE_CHECK_URL', '') || null,
    logLevel,
  };
}
