import { badRequest, conflict, forbidden, notFound, unauthorized } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type { Session, User, UserRole } from '../core/types.js';
import { sha256Hex } from '../util/crypto.js';
import { createId, createToken, nowIso } from '../util/id.js';
import { assertUsablePassword, hashPassword, verifyPassword } from '../util/password.js';
import type { Repositories } from '../storage/repositories.js';

const log = createLogger('users');

/** Wie lange eine Anmeldung gilt, wenn sie regelmäßig genutzt wird. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Ab so vielen Fehlversuchen wird das Konto kurz gesperrt. */
const MAX_FAILED_ATTEMPTS = 5;
/** So lange bleibt es dann gesperrt. */
const LOCK_MS = 15 * 60 * 1000;

/** Ein Benutzer, wie ihn die API ausgibt – ohne alles Geheime. */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface CreateUserInput {
  username: string;
  password: string;
  displayName?: string;
  role?: UserRole;
}

/**
 * Benutzer und Anmeldung.
 *
 * Ein Zugriffstoken war für Menschen der falsche Schlüssel: Es wird einmal
 * angezeigt, ist nicht zu merken und lässt sich nicht ändern. Angemeldet wird
 * sich deshalb mit Name und Passwort; das Ergebnis ist eine Sitzung, die im
 * Browser als Cookie liegt und sich jederzeit beenden lässt.
 *
 * Zugriffstoken gibt es weiterhin – aber nur noch für das, wofür sie taugen:
 * Skripte und andere Programme.
 */
export class UserService {
  constructor(private readonly repos: Repositories) {}

  // -------------------------------------------------------------------------
  // Benutzer
  // -------------------------------------------------------------------------

  list(householdId: string): PublicUser[] {
    return this.repos.users
      .listByHousehold(householdId)
      .sort((a, b) => a.username.localeCompare(b.username, 'de'))
      .map(toPublic);
  }

  count(householdId: string): number {
    return this.repos.users.listByHousehold(householdId).length;
  }

  get(id: string): User {
    return this.repos.users.get(id, 'Benutzer');
  }

  async create(householdId: string, input: CreateUserInput): Promise<PublicUser> {
    const username = normalizeUsername(input.username);
    assertUsablePassword(input.password, username);

    if (this.repos.users.findByUsername(householdId, username)) {
      throw conflict(
        `Den Anmeldenamen „${username}" gibt es schon.`,
        undefined,
        'Wähle einen anderen Namen – zwei Konten mit demselben Namen könnte niemand auseinanderhalten.',
      );
    }

    // Der erste Benutzer ist immer Administrator, sonst könnte niemand mehr
    // Benutzer anlegen.
    const isFirst = this.count(householdId) === 0;
    const user: User = {
      id: createId('usr'),
      householdId,
      username,
      displayName: input.displayName?.trim() || capitalize(username),
      role: isFirst ? 'admin' : (input.role ?? 'member'),
      passwordHash: await hashPassword(input.password),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastLoginAt: null,
      failedAttempts: 0,
      lockedUntil: null,
    };

    await this.repos.users.insert(user);
    log.info('Benutzer angelegt', { username, role: user.role });
    return toPublic(user);
  }

  async update(
    id: string,
    changes: { displayName?: string; role?: UserRole },
  ): Promise<PublicUser> {
    const user = this.get(id);
    const patch: Partial<User> = {};

    if (changes.displayName !== undefined) {
      const name = changes.displayName.trim();
      if (!name) throw badRequest('Der Anzeigename darf nicht leer sein.');
      patch.displayName = name;
    }

    if (changes.role !== undefined && changes.role !== user.role) {
      // Ohne Administrator käme niemand mehr an die Benutzerverwaltung.
      if (user.role === 'admin') this.assertAnotherAdminExists(user);
      patch.role = changes.role;
    }

    return toPublic(await this.repos.users.patch(id, patch, 'Benutzer'));
  }

  async remove(id: string, actingUserId: string): Promise<void> {
    const user = this.get(id);
    if (user.id === actingUserId) {
      throw conflict(
        'Das eigene Konto lässt sich nicht löschen.',
        undefined,
        'Ein anderer Administrator kann es entfernen.',
      );
    }
    if (user.role === 'admin') this.assertAnotherAdminExists(user);

    await this.repos.sessions.removeByUser(id);
    await this.repos.users.remove(id);
    log.info('Benutzer entfernt', { username: user.username });
  }

  /**
   * Passwort ändern. Das alte muss stimmen – sonst könnte ein offen gelassener
   * Browser genutzt werden, um jemanden dauerhaft auszusperren.
   */
  async changePassword(
    id: string,
    currentPassword: string,
    newPassword: string,
    keepSessionId?: string,
  ): Promise<void> {
    const user = this.get(id);
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw unauthorized(
        'Das bisherige Passwort stimmt nicht.',
        'Tippe es noch einmal – oder lass es von einem Administrator zurücksetzen.',
      );
    }
    assertUsablePassword(newPassword, user.username);

    await this.repos.users.patch(
      id,
      { passwordHash: await hashPassword(newPassword), failedAttempts: 0, lockedUntil: null },
      'Benutzer',
    );

    // Alle anderen Sitzungen beenden: Wer das Passwort ändert, will
    // üblicherweise genau das erreichen.
    await this.repos.sessions.removeByUser(id, keepSessionId);
    log.info('Passwort geändert', { username: user.username });
  }

  /** Administrator setzt das Passwort eines anderen Kontos zurück. */
  async resetPassword(id: string, newPassword: string): Promise<void> {
    const user = this.get(id);
    assertUsablePassword(newPassword, user.username);
    await this.repos.users.patch(
      id,
      { passwordHash: await hashPassword(newPassword), failedAttempts: 0, lockedUntil: null },
      'Benutzer',
    );
    await this.repos.sessions.removeByUser(id);
    log.info('Passwort zurückgesetzt', { username: user.username });
  }

  // -------------------------------------------------------------------------
  // Anmeldung
  // -------------------------------------------------------------------------

  /**
   * Meldet einen Benutzer an.
   *
   * Ob der Name oder das Passwort falsch war, bleibt bewusst offen – sonst
   * ließe sich mit der Anmeldemaske herausfinden, welche Konten es gibt.
   */
  async login(
    householdId: string,
    username: string,
    password: string,
    device?: string,
  ): Promise<{ user: PublicUser; token: string; session: Session }> {
    const user = this.repos.users.findByUsername(householdId, normalizeUsername(username));

    if (!user) {
      // Trotzdem rechnen, damit ein unbekannter Name nicht spürbar schneller
      // beantwortet wird als ein falsches Passwort.
      await verifyPassword(password, DUMMY_HASH);
      throw unauthorized(
        'Name oder Passwort stimmt nicht.',
        'Achte auf Groß- und Kleinschreibung des Passworts.',
      );
    }

    if (user.lockedUntil && new Date(user.lockedUntil).getTime() > Date.now()) {
      const minutes = Math.max(
        1,
        Math.ceil((new Date(user.lockedUntil).getTime() - Date.now()) / 60_000),
      );
      throw unauthorized(
        `Zu viele Fehlversuche. Das Konto ist noch ${minutes} Minuten gesperrt.`,
        'Die Sperre läuft von selbst ab – oder ein Administrator setzt das Passwort zurück.',
      );
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      const failed = user.failedAttempts + 1;
      const locked = failed >= MAX_FAILED_ATTEMPTS;
      await this.repos.users.patch(
        user.id,
        {
          failedAttempts: locked ? 0 : failed,
          lockedUntil: locked ? new Date(Date.now() + LOCK_MS).toISOString() : null,
        },
        'Benutzer',
      );
      log.warn('Fehlgeschlagene Anmeldung', { username: user.username, failed, locked });

      throw unauthorized(
        'Name oder Passwort stimmt nicht.',
        locked
          ? `Nach ${MAX_FAILED_ATTEMPTS} Fehlversuchen ist das Konto 15 Minuten gesperrt.`
          : `Noch ${MAX_FAILED_ATTEMPTS - failed} Versuche, dann wird das Konto kurz gesperrt.`,
      );
    }

    await this.repos.users.patch(
      user.id,
      { failedAttempts: 0, lockedUntil: null, lastLoginAt: nowIso() },
      'Benutzer',
    );

    const token = createToken('ss');
    const session: Session = {
      id: createId('ses'),
      householdId,
      userId: user.id,
      tokenHash: sha256Hex(token),
      createdAt: nowIso(),
      lastUsedAt: nowIso(),
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      device: device ? describeDevice(device) : null,
    };
    await this.repos.sessions.insert(session);
    await this.pruneExpired();

    log.info('Angemeldet', { username: user.username });
    return { user: toPublic({ ...user, lastLoginAt: session.createdAt }), token, session };
  }

  /**
   * Prüft einen Sitzungsschlüssel. Gibt `null` zurück, statt zu werfen – der
   * Aufrufer entscheidet, ob daraus ein 401 wird.
   */
  async verifySession(token: string): Promise<{ session: Session; user: User } | null> {
    const session = this.repos.sessions.findByHash(sha256Hex(token));
    if (!session) return null;

    if (new Date(session.expiresAt).getTime() <= Date.now()) {
      await this.repos.sessions.remove(session.id);
      return null;
    }

    const user = this.repos.users.find(session.userId);
    if (!user) {
      await this.repos.sessions.remove(session.id);
      return null;
    }

    // Gleitende Verlängerung: Wer den Hub regelmäßig nutzt, wird nicht
    // grundlos abgemeldet. Nur einmal pro Stunde schreiben, sonst würde jede
    // Anfrage die Datenbank anfassen.
    const lastUsed = new Date(session.lastUsedAt).getTime();
    if (Date.now() - lastUsed > 60 * 60 * 1000) {
      await this.repos.sessions.touch(session.id, new Date(Date.now() + SESSION_TTL_MS).toISOString());
    }

    return { session, user };
  }

  listSessions(userId: string): Array<Omit<Session, 'tokenHash'>> {
    return this.repos.sessions
      .listByUser(userId)
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt))
      .map(({ tokenHash: _tokenHash, ...rest }) => rest);
  }

  async endSession(id: string, userId: string): Promise<void> {
    const session = this.repos.sessions.find(id);
    if (!session) throw notFound('Sitzung');
    if (session.userId !== userId) {
      throw forbidden('Fremde Sitzungen lassen sich nicht beenden.');
    }
    await this.repos.sessions.remove(id);
  }

  async endAllSessions(userId: string, keepSessionId?: string): Promise<number> {
    return this.repos.sessions.removeByUser(userId, keepSessionId);
  }

  /** Abgelaufene Sitzungen aufräumen – passiert beiläufig beim Anmelden. */
  async pruneExpired(): Promise<number> {
    return this.repos.sessions.removeExpired(nowIso());
  }

  // -------------------------------------------------------------------------

  private assertAnotherAdminExists(user: User): void {
    const admins = this.repos.users
      .listByHousehold(user.householdId)
      .filter((other) => other.role === 'admin' && other.id !== user.id);
    if (admins.length === 0) {
      throw conflict(
        'Das ist der letzte Administrator.',
        undefined,
        'Mach zuerst jemand anderen zum Administrator – sonst käme niemand mehr an die Verwaltung.',
      );
    }
  }
}

/**
 * Vergleichswert für unbekannte Namen. Der Inhalt spielt keine Rolle; er
 * sorgt nur dafür, dass auch dann gerechnet wird.
 */
const DUMMY_HASH =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

export function toPublic(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
}

/**
 * Anmeldenamen sind klein geschrieben und ohne Leerzeichen – „Anna" und
 * „anna" wären sonst zwei Konten, die niemand auseinanderhalten kann.
 */
export function normalizeUsername(raw: string): string {
  const username = raw.trim().toLowerCase();
  if (username.length < 3) {
    throw badRequest(
      'Der Anmeldename braucht mindestens drei Zeichen.',
      undefined,
      'Zum Beispiel der Vorname.',
    );
  }
  if (username.length > 32) {
    throw badRequest('Der Anmeldename ist zu lang – höchstens 32 Zeichen.');
  }
  if (!/^[a-z0-9._-]+$/.test(username)) {
    throw badRequest(
      'Im Anmeldenamen sind nur Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich erlaubt.',
      undefined,
      'Umlaute und Leerzeichen führen je nach Tastatur zu Tippfehlern beim Anmelden.',
    );
  }
  return username;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Aus dem User-Agent eine Zeile machen, an der man das eigene Gerät
 * wiedererkennt. Genauer muss es nicht sein – es geht nur darum, eine fremde
 * Sitzung in der Liste zu erkennen.
 */
export function describeDevice(userAgent: string): string {
  const system = /iPhone|iPad/i.test(userAgent)
    ? 'iPhone/iPad'
    : /Android/i.test(userAgent)
      ? 'Android'
      : /Mac OS X|Macintosh/i.test(userAgent)
        ? 'Mac'
        : /Windows/i.test(userAgent)
          ? 'Windows'
          : /Linux/i.test(userAgent)
            ? 'Linux'
            : 'unbekanntes Gerät';

  const browser = /Edg\//i.test(userAgent)
    ? 'Edge'
    : /OPR\//i.test(userAgent)
      ? 'Opera'
      : /Firefox\//i.test(userAgent)
        ? 'Firefox'
        : /Chrome\//i.test(userAgent)
          ? 'Chrome'
          : /Safari\//i.test(userAgent)
            ? 'Safari'
            : 'Browser';

  return `${browser} auf ${system}`;
}
