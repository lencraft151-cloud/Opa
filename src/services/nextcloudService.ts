import { badRequest, errorSummary, isAppError, upstreamError } from '../core/errors.js';
import { events } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import type { NextcloudAccount, NextcloudNotification, PublicNextcloudAccount } from '../core/types.js';
import { NextcloudRepository, type Repositories } from '../storage/repositories.js';
import { decryptJson, encryptJson } from '../util/crypto.js';
import { request } from '../util/http.js';
import { createId, nowIso } from '../util/id.js';

const log = createLogger('nextcloud');

/** Wie oft standardmäßig nachgesehen wird. */
export const DEFAULT_POLL_SECONDS = 30;
export const MIN_POLL_SECONDS = 10;
export const MAX_POLL_SECONDS = 3600;

/** Wie viele Meldungen die Oberfläche höchstens bekommt. */
const MAX_LIST = 50;

const OCS_HEADERS = {
  'ocs-apirequest': 'true',
  accept: 'application/json',
};

export interface NextcloudSecrets {
  appPassword: string;
}

export interface ConnectInput {
  baseUrl: string;
  username: string;
  appPassword: string;
  pollIntervalSeconds?: number;
}

export interface NextcloudStatus {
  account: PublicNextcloudAccount | null;
  /** Zuletzt abgerufene, noch offene Benachrichtigungen. */
  notifications: NextcloudNotification[];
  /** Läuft der Abruf gerade? */
  polling: boolean;
}

/**
 * Nextcloud-Anbindung.
 *
 * Der Hub hängt ohnehin den ganzen Tag an der Wand und ist die Stelle, auf
 * die man im Vorbeigehen schaut. Eine neue Talk-Nachricht oder eine geteilte
 * Datei dort als Popup zu sehen, spart den Griff zum Telefon.
 *
 * Angesprochen wird die OCS-Schnittstelle der App „Benachrichtigungen“:
 *
 *     GET /ocs/v2.php/apps/notifications/api/v2/notifications
 *
 * Angemeldet wird sich mit einem **App-Passwort** (Nextcloud: Einstellungen →
 * Sicherheit → „Neues App-Passwort erstellen“). Das ist kein Umweg, sondern
 * der einzige Weg, der auch mit Zwei-Faktor-Anmeldung funktioniert – und es
 * lässt sich einzeln widerrufen, ohne dass jemand sein Konto-Passwort ändern
 * muss.
 */
export class NextcloudService {
  private timer: NodeJS.Timeout | null = null;
  private householdId: string | null = null;
  private busy = false;
  /** Der letzte abgerufene Stand – die Oberfläche liest ihn, statt selbst zu fragen. */
  private cached: NextcloudNotification[] = [];

  constructor(
    private readonly repos: Repositories,
    private readonly secretKey: string,
  ) {}

  // -------------------------------------------------------------------------
  // Konto
  // -------------------------------------------------------------------------

  status(householdId: string): NextcloudStatus {
    const account = this.repos.nextcloud.findByHousehold(householdId);
    return {
      account: account ? NextcloudRepository.toPublic(account) : null,
      notifications: account ? this.cached : [],
      polling: this.timer !== null,
    };
  }

  /**
   * Verbindet – oder legt die bestehende Verbindung neu an.
   *
   * Zuerst wird geprüft, ob Adresse und Zugangsdaten stimmen. Ein Konto, das
   * beim ersten Abruf scheitert, wäre nur eine rote Zeile in den
   * Einstellungen, die niemand erklären kann.
   */
  async connect(householdId: string, input: ConnectInput): Promise<PublicNextcloudAccount> {
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const username = input.username.trim();
    const appPassword = input.appPassword.trim();
    if (!username) throw badRequest('Ohne Benutzernamen geht es nicht.');
    if (!appPassword) {
      throw badRequest(
        'Es fehlt das App-Passwort.',
        undefined,
        'In Nextcloud unter Einstellungen → Sicherheit ganz unten ein neues App-Passwort erstellen.',
      );
    }

    const identity = await fetchIdentity(baseUrl, username, appPassword);
    // Der erste Abruf zählt nur, er meldet nichts: Wer den Hub anschließt,
    // will nicht dreißig alte Benachrichtigungen auf einmal aufpoppen sehen.
    const initial = await fetchNotifications(baseUrl, username, appPassword);

    const existing = this.repos.nextcloud.findByHousehold(householdId);
    const pollIntervalSeconds = clampInterval(
      input.pollIntervalSeconds ?? existing?.pollIntervalSeconds ?? DEFAULT_POLL_SECONDS,
    );

    const changes = {
      baseUrl,
      username,
      displayName: identity.displayName,
      serverVersion: identity.serverVersion,
      enabled: true,
      pollIntervalSeconds,
      secretsEnc: encryptJson({ appPassword } satisfies NextcloudSecrets, this.secretKey),
      lastSeenAt: nowIso(),
      lastError: null,
      lastNotificationId: highestId(initial),
    };

    const account = existing
      ? await this.repos.nextcloud.patch(existing.id, changes, 'Nextcloud-Konto')
      : await this.repos.nextcloud.insert({
          id: createId('ncl'),
          householdId,
          createdAt: nowIso(),
          updatedAt: nowIso(),
          ...changes,
        });

    this.cached = initial.slice(0, MAX_LIST);
    log.info('Nextcloud verbunden', {
      host: new URL(baseUrl).host,
      user: username,
      offen: initial.length,
    });

    // Nach einer Änderung sofort im neuen Takt weiterlaufen.
    if (this.householdId) this.restartTimer(account.pollIntervalSeconds);

    return NextcloudRepository.toPublic(account);
  }

  /** Ändert Takt und Ein/Aus, ohne die Zugangsdaten anzufassen. */
  async update(
    householdId: string,
    changes: { enabled?: boolean; pollIntervalSeconds?: number },
  ): Promise<PublicNextcloudAccount> {
    const account = this.require(householdId);
    const patch: Partial<NextcloudAccount> = {};
    if (changes.enabled !== undefined) patch.enabled = changes.enabled;
    if (changes.pollIntervalSeconds !== undefined) {
      patch.pollIntervalSeconds = clampInterval(changes.pollIntervalSeconds);
    }
    const updated = await this.repos.nextcloud.patch(account.id, patch, 'Nextcloud-Konto');
    if (this.householdId) this.restartTimer(updated.pollIntervalSeconds);
    return NextcloudRepository.toPublic(updated);
  }

  /** Trennt die Verbindung und löscht das gespeicherte App-Passwort. */
  async disconnect(householdId: string): Promise<void> {
    const account = this.repos.nextcloud.findByHousehold(householdId);
    if (!account) return;
    await this.repos.nextcloud.remove(account.id);
    this.cached = [];
    log.info('Nextcloud getrennt');
  }

  // -------------------------------------------------------------------------
  // Benachrichtigungen
  // -------------------------------------------------------------------------

  /** Holt den aktuellen Stand und meldet neue Benachrichtigungen. */
  async refresh(householdId: string): Promise<NextcloudNotification[]> {
    const account = this.require(householdId);
    const password = this.passwordOf(account);

    let list: NextcloudNotification[];
    try {
      list = await fetchNotifications(account.baseUrl, account.username, password);
    } catch (err) {
      await this.repos.nextcloud.patch(
        account.id,
        { lastError: errorSummary(err) },
        'Nextcloud-Konto',
      );
      throw err;
    }

    const { fresh, nextId } = freshNotifications(list, account.lastNotificationId);
    this.cached = list.slice(0, MAX_LIST);

    await this.repos.nextcloud.patch(
      account.id,
      { lastSeenAt: nowIso(), lastError: null, lastNotificationId: nextId },
      'Nextcloud-Konto',
    );

    for (const notification of fresh) {
      events.emit('notification', {
        householdId,
        message: describeNotification(notification),
        hint: notification.message || undefined,
        link: notification.link ?? undefined,
        level: 'info',
        source: 'nextcloud',
      });
    }
    if (fresh.length > 0) {
      log.info('Neue Benachrichtigungen', { anzahl: fresh.length });
    }

    return this.cached;
  }

  /** Markiert eine Benachrichtigung in Nextcloud als erledigt. */
  async dismiss(householdId: string, notificationId: number): Promise<void> {
    const account = this.require(householdId);
    await ocsRequest(
      `${account.baseUrl}/ocs/v2.php/apps/notifications/api/v2/notifications/${notificationId}`,
      account.username,
      this.passwordOf(account),
      { method: 'DELETE' },
    );
    this.cached = this.cached.filter((entry) => entry.id !== notificationId);
  }

  /** Markiert alle Benachrichtigungen als erledigt. */
  async dismissAll(householdId: string): Promise<void> {
    const account = this.require(householdId);
    await ocsRequest(
      `${account.baseUrl}/ocs/v2.php/apps/notifications/api/v2/notifications`,
      account.username,
      this.passwordOf(account),
      { method: 'DELETE' },
    );
    this.cached = [];
  }

  // -------------------------------------------------------------------------
  // Hintergrundabruf
  // -------------------------------------------------------------------------

  start(householdId: string): void {
    this.householdId = householdId;
    const account = this.repos.nextcloud.findByHousehold(householdId);
    if (!account) return;
    this.restartTimer(account.pollIntervalSeconds);
    // Nicht auf den ersten Takt warten – wer den Hub neu startet, will den
    // Stand sofort sehen.
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.householdId = null;
  }

  private restartTimer(seconds: number): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), clampInterval(seconds) * 1000);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.householdId || this.busy) return;
    const account = this.repos.nextcloud.findByHousehold(this.householdId);
    if (!account || !account.enabled) return;

    this.busy = true;
    try {
      await this.refresh(this.householdId);
    } catch (err) {
      // Eine Nextcloud, die gerade nicht erreichbar ist, darf den Hub nicht
      // mit Fehler-Popups zumüllen – der Fehler steht in den Einstellungen.
      log.debug('Abruf fehlgeschlagen', { error: errorSummary(err) });
    } finally {
      this.busy = false;
    }
  }

  // -------------------------------------------------------------------------

  private require(householdId: string): NextcloudAccount {
    const account = this.repos.nextcloud.findByHousehold(householdId);
    if (!account) {
      throw badRequest(
        'Es ist keine Nextcloud verbunden.',
        undefined,
        'Unter Einstellungen → Nextcloud Adresse, Benutzername und App-Passwort eintragen.',
      );
    }
    return account;
  }

  private passwordOf(account: NextcloudAccount): string {
    if (!account.secretsEnc) {
      throw badRequest(
        'Für diese Nextcloud liegt kein App-Passwort vor.',
        undefined,
        'Bitte die Verbindung einmal neu herstellen.',
      );
    }
    return decryptJson<NextcloudSecrets>(account.secretsEnc, this.secretKey).appPassword;
  }
}

// ---------------------------------------------------------------------------
// Reine Hilfsfunktionen (ohne Netz – deshalb einzeln prüfbar)
// ---------------------------------------------------------------------------

/**
 * Bringt die eingegebene Adresse in eine feste Form.
 *
 * Menschen tippen `cloud.example.de`, `https://cloud.example.de/` oder gleich
 * `https://cloud.example.de/index.php/apps/files`. Alles drei meint dieselbe
 * Instanz.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw badRequest('Es fehlt die Adresse der Nextcloud.');

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw badRequest(
      `„${raw}" ist keine gültige Adresse.`,
      undefined,
      'Beispiel: https://cloud.example.de',
    );
  }

  // Der Pfad einer Nextcloud kann in einem Unterverzeichnis liegen
  // (`/nextcloud`). Alles ab `index.php` oder `/apps/` gehört nicht dazu.
  let path = url.pathname.replace(/\/+$/, '');
  const cut = path.search(/\/(index\.php|apps|settings|ocs)(\/|$)/);
  if (cut >= 0) path = path.slice(0, cut);

  return `${url.protocol}//${url.host}${path}`;
}

interface OcsEnvelope<T> {
  ocs?: {
    meta?: { status?: string; statuscode?: number; message?: string };
    data?: T;
  };
}

/** Packt die OCS-Hülle aus und macht aus einem Fehlercode eine klare Meldung. */
export function parseOcs<T>(body: string, source: string): T {
  let parsed: OcsEnvelope<T>;
  try {
    parsed = JSON.parse(body) as OcsEnvelope<T>;
  } catch {
    throw upstreamError(
      `${source} hat keine JSON-Antwort geliefert.`,
      { body: body.slice(0, 200) },
      'Unter dieser Adresse antwortet vermutlich keine Nextcloud. Zeigt der Browser dort die Anmeldeseite?',
    );
  }

  const meta = parsed.ocs?.meta;
  if (!parsed.ocs || meta === undefined) {
    throw upstreamError(
      `${source} hat geantwortet, aber nicht wie eine Nextcloud.`,
      { body: body.slice(0, 200) },
      'Bitte die Adresse prüfen – gemeint ist die Startseite der Nextcloud, nicht eine einzelne App.',
    );
  }
  const code = meta.statuscode ?? 0;
  if (code >= 300) {
    throw upstreamError(
      `Nextcloud meldet: ${meta.message ?? `Fehler ${code}`}`,
      { statuscode: code },
    );
  }
  return (parsed.ocs.data ?? ({} as T)) as T;
}

/** Wandelt die Rohdaten in unsere Form; unbrauchbare Einträge fallen weg. */
export function toNotifications(data: unknown, baseUrl?: string): NextcloudNotification[] {
  if (!Array.isArray(data)) return [];
  const result: NextcloudNotification[] = [];
  for (const raw of data) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const id = Number(entry['notification_id']);
    if (!Number.isFinite(id)) continue;
    result.push({
      id,
      app: text(entry['app']) || 'nextcloud',
      subject: text(entry['subject']) || text(entry['subjectRich']),
      message: text(entry['message']) || text(entry['messageRich']),
      link: safeLink(text(entry['link']), baseUrl),
      datetime: text(entry['datetime']) || nowIso(),
    });
  }
  return result.sort((a, b) => b.id - a.id);
}

/**
 * Macht aus dem gemeldeten Verweis eine absolute http(s)-Adresse – oder gar
 * keine.
 *
 * Zwei Gründe: Ältere Nextcloud-Versionen liefern relative Pfade
 * (`/call/abc123`), die im Browser des Hubs ins Leere zeigen würden. Und
 * alles, was kein `http`/`https` ist, landet hier gar nicht erst in der
 * Oberfläche – ein Verweis aus fremder Feder gehört nicht ungeprüft in ein
 * `href`.
 */
function safeLink(raw: string, baseUrl?: string): string | null {
  if (!raw) return null;
  try {
    const url = baseUrl ? new URL(raw, `${baseUrl}/`) : new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Welche Meldungen sind seit dem letzten Abruf dazugekommen?
 *
 * Der Sonderfall ist die zweite Hälfte: Sind *alle* IDs kleiner als der
 * gemerkte Stand, wurde die Nextcloud offenbar neu aufgesetzt oder die
 * Benachrichtigungs-App zurückgesetzt. Dann ist nichts davon neu – der Hub
 * merkt sich stillschweigend den neuen Stand, statt alte Meldungen als
 * frische Popups auszuspucken.
 */
export function freshNotifications(
  list: readonly NextcloudNotification[],
  lastId: number,
): { fresh: NextcloudNotification[]; nextId: number } {
  const highest = highestId(list);
  if (list.length === 0) return { fresh: [], nextId: lastId };
  if (highest < lastId) return { fresh: [], nextId: highest };

  const fresh = list.filter((entry) => entry.id > lastId).sort((a, b) => a.id - b.id);
  return { fresh, nextId: Math.max(lastId, highest) };
}

/** Anzeigename der Herkunfts-App, soweit bekannt. */
const APP_NAMES: Record<string, string> = {
  spreed: 'Talk',
  files: 'Dateien',
  files_sharing: 'Freigabe',
  dav: 'Kalender',
  calendar: 'Kalender',
  deck: 'Deck',
  updatenotification: 'Nextcloud',
  twofactor_nextcloud_notification: 'Anmeldung',
};

/** Eine Zeile, wie sie im Popup steht. */
export function describeNotification(notification: NextcloudNotification): string {
  const app = APP_NAMES[notification.app] ?? notification.app;
  const subject = notification.subject.trim() || 'Neue Benachrichtigung';
  return `${app}: ${subject}`;
}

export function highestId(list: readonly NextcloudNotification[]): number {
  return list.reduce((max, entry) => (entry.id > max ? entry.id : max), 0);
}

export function clampInterval(seconds: number): number {
  if (!Number.isFinite(seconds)) return DEFAULT_POLL_SECONDS;
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(seconds)));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ---------------------------------------------------------------------------
// Netzzugriff
// ---------------------------------------------------------------------------

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

async function ocsRequest<T>(
  url: string,
  username: string,
  password: string,
  options: { method?: string } = {},
): Promise<T> {
  const res = await request(url, {
    method: options.method ?? 'GET',
    headers: { ...OCS_HEADERS, authorization: basicAuth(username, password) },
    query: { format: 'json' },
    timeoutMs: 10_000,
  });

  if (res.status === 401 || res.status === 403) {
    /*
     * Bewusst 400 und nicht 401: Ein 401 aus der Hub-API bedeutet für die
     * Oberfläche „deine Sitzung ist abgelaufen“ und wirft den Nutzer zur
     * Anmeldemaske. Abgelehnt hat hier aber die Nextcloud, nicht der Hub.
     */
    throw badRequest(
      'Nextcloud hat die Anmeldung abgelehnt.',
      { status: res.status },
      'Benutzername prüfen und ein frisches App-Passwort erzeugen: Einstellungen → Sicherheit → „Neues App-Passwort erstellen". ' +
        'Das normale Kontopasswort funktioniert bei aktiver Zwei-Faktor-Anmeldung nicht.',
    );
  }
  if (res.status === 404) {
    throw upstreamError(
      'Diese Nextcloud kennt die Benachrichtigungen nicht.',
      { status: 404 },
      'Die App „Benachrichtigungen" ist dort nicht aktiviert – sie liegt im App-Store unter „Aktiviert“ bzw. lässt sich vom Administrator einschalten.',
    );
  }
  if (res.status >= 400) {
    throw upstreamError(`Nextcloud hat mit HTTP ${res.status} geantwortet.`, {
      status: res.status,
      body: res.body.slice(0, 300),
    });
  }

  // Eine leere Antwort ist bei DELETE der Normalfall.
  if (!res.body.trim()) return {} as T;
  return parseOcs<T>(res.body, new URL(url).host);
}

interface UserData {
  id?: string;
  'display-name'?: string;
  displayname?: string;
}

interface CapabilitiesData {
  version?: { string?: string };
}

/** Prüft die Zugangsdaten und holt Anzeigename und Serverversion. */
async function fetchIdentity(
  baseUrl: string,
  username: string,
  password: string,
): Promise<{ displayName: string | null; serverVersion: string | null }> {
  const user = await ocsRequest<UserData>(`${baseUrl}/ocs/v2.php/cloud/user`, username, password);

  let serverVersion: string | null = null;
  try {
    const caps = await ocsRequest<CapabilitiesData>(
      `${baseUrl}/ocs/v2.php/cloud/capabilities`,
      username,
      password,
    );
    serverVersion = caps.version?.string ?? null;
  } catch (err) {
    // Die Version ist Beiwerk. Wer sie nicht herausrückt, ist trotzdem
    // benutzbar – nur die Fehlermeldung wäre irreführend.
    log.debug('Version nicht ermittelbar', { error: errorSummary(err) });
  }

  return {
    displayName: user['display-name'] ?? user.displayname ?? null,
    serverVersion,
  };
}

async function fetchNotifications(
  baseUrl: string,
  username: string,
  password: string,
): Promise<NextcloudNotification[]> {
  try {
    const data = await ocsRequest<unknown>(
      `${baseUrl}/ocs/v2.php/apps/notifications/api/v2/notifications`,
      username,
      password,
    );
    return toNotifications(data, baseUrl);
  } catch (err) {
    // Fehler mit eigener Erklärung bleiben, wie sie sind.
    if (isAppError(err)) throw err;
    throw upstreamError(
      `Die Benachrichtigungen konnten nicht abgerufen werden: ${errorSummary(err)}`,
    );
  }
}
