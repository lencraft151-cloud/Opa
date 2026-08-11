import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { forbidden, unauthorized } from '../core/errors.js';
import type { User } from '../core/types.js';
import { sha256Hex } from '../util/crypto.js';
import type { Container } from '../container.js';

/**
 * Endpunkte, die immer ohne Anmeldung erreichbar sind.
 *
 * Die Pfade sind relativ zum Mountpunkt des API-Routers (`/api`), weil Express
 * `req.path` innerhalb eines gemounteten Routers ohne dessen Präfix liefert.
 */
const PUBLIC_PATHS = new Set(['/health', '/system/info', '/setup/state', '/auth/login']);

/**
 * Pfade, die eine Anmeldung auswerten, aber nicht verlangen.
 *
 * „Wer bin ich?" ist eine Frage, auf die „niemand" eine gültige Antwort ist.
 * Ein 401 wäre hier falsch – und stünde beim Start jedes Mal rot in der
 * Browserkonsole, obwohl gar nichts kaputt ist.
 */
const OPTIONAL_AUTH_PATHS = new Set(['/auth/me']);

/**
 * Wege zurück aus einem Haushalt ohne Zugang – siehe die Begründung unten in
 * `createAuthMiddleware`. Nur diese beiden, und nur solange es wirklich kein
 * einziges Konto gibt.
 */
const RECOVERY_PATHS = new Set(['/setup/household', '/auth/users']);

/** Name des Sitzungs-Cookies. */
export const SESSION_COOKIE = 'sh_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Angemeldeter Benutzer – gesetzt, wenn über eine Sitzung gekommen. */
      user?: User;
      /** ID der Sitzung, über die der Aufruf kam. */
      sessionId?: string;
      /** Token-ID, wenn ein Programm mit Zugriffstoken gekommen ist. */
      tokenId?: string;
    }
  }
}

/**
 * Anmeldung prüfen.
 *
 * Zwei Wege führen herein:
 *
 * - **Sitzung** – ein Mensch hat sich mit Name und Passwort angemeldet. Der
 *   Schlüssel liegt als HttpOnly-Cookie im Browser; JavaScript kommt nicht an
 *   ihn heran, und der Ereignisstrom (`EventSource` kann keine Header setzen)
 *   funktioniert damit ohne Umweg über die Adresszeile.
 * - **Zugriffstoken** – ein Skript oder ein anderes Programm. Es hat keinen
 *   Benutzer und damit auch keine Rolle; für die Benutzerverwaltung reicht es
 *   deshalb nicht.
 *
 * Solange noch kein Haushalt existiert, bleibt die API offen – sonst käme man
 * nicht durch die Ersteinrichtung.
 */
export function createAuthMiddleware(container: Container): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (container.config.authDisabled) return next();
    if (PUBLIC_PATHS.has(req.path)) return next();

    // Bootstrap: ohne Haushalt gibt es noch niemanden, der sich anmelden könnte.
    const household = container.households.current();
    if (!household) return next();

    /*
     * Ein Haushalt ohne einen einzigen Zugang ist keine fertige Einrichtung,
     * sondern ein Abbruch mittendrin – und ohne diese Ausnahme ein
     * Zustand, aus dem es kein Zurück gäbe: Die Anmeldepflicht greift, aber
     * es gibt kein Konto, mit dem man ihr genügen könnte.
     *
     * Geöffnet wird deshalb genau der Weg, der aus diesem Zustand
     * herausführt, und kein anderer. Zu schützen gibt es hier ohnehin
     * nichts: Wer den ersten Zugang anlegt, tut, was der Besitzer als
     * Nächstes getan hätte.
     */
    if (RECOVERY_PATHS.has(req.path) && container.repos.users.listByHousehold(household.id).length === 0) {
      return next();
    }

    const optional = OPTIONAL_AUTH_PATHS.has(req.path);

    const sessionToken = readCookie(req, SESSION_COOKIE) ?? bearer(req, 'ss_');
    if (sessionToken) {
      void container.users
        .verifySession(sessionToken)
        .then((found) => {
          if (!found) {
            if (optional) return next();
            return next(
              unauthorized(
                'Die Anmeldung ist abgelaufen.',
                'Melde dich noch einmal mit Benutzername und Passwort an.',
              ),
            );
          }
          req.user = found.user;
          req.sessionId = found.session.id;
          return next();
        })
        .catch(next);
      return;
    }

    const token = extractToken(req);
    if (!token) {
      if (optional) return next();
      return next(
        unauthorized(
          'Nicht angemeldet.',
          'Melde dich mit Benutzername und Passwort an. Programme senden stattdessen ' +
            'ein Zugriffstoken als "Authorization: Bearer <token>".',
        ),
      );
    }

    const record = container.repos.tokens.findByHash(sha256Hex(token));
    if (!record) {
      if (optional) return next();
      return next(
        unauthorized(
          'Das Zugriffstoken ist ungültig oder wurde widerrufen.',
          'In den Einstellungen lässt sich ein neues erstellen.',
        ),
      );
    }

    req.tokenId = record.id;
    void container.repos.tokens.touch(record.id);
    return next();
  };
}

/**
 * Verlangt einen angemeldeten Menschen (kein Zugriffstoken).
 * Für alles, was das eigene Konto betrifft.
 */
export function requireUser(req: Request): User {
  if (!req.user) {
    throw unauthorized(
      'Dafür ist eine Anmeldung mit Benutzername und Passwort nötig.',
      'Ein Zugriffstoken gehört einem Programm, nicht einer Person – für Konten reicht es nicht.',
    );
  }
  return req.user;
}

/** Verlangt Administratorrechte. */
export function requireAdmin(req: Request): User {
  const user = requireUser(req);
  if (user.role !== 'admin') {
    throw forbidden('Das dürfen nur Administratoren.');
  }
  return user;
}

/**
 * Ohne Anmeldepflicht (`AUTH_DISABLED=true`) gibt es keinen Benutzer. Damit
 * die Verwaltung dann trotzdem bedienbar bleibt, gilt in diesem Fall jeder
 * als Administrator – der Hub ist ohnehin bewusst offen gestellt.
 */
export function requireAdminUnlessOpen(req: Request, authDisabled: boolean): User | null {
  if (authDisabled && !req.user) return null;
  return requireAdmin(req);
}

function bearer(req: Request, prefix: string): string | null {
  const header = req.headers.authorization;
  if (!header?.toLowerCase().startsWith('bearer ')) return null;
  const value = header.slice(7).trim();
  return value.startsWith(prefix) ? value : null;
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null;
  }
  const headerToken = req.headers['x-access-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();

  // Für Programme, die keine Header setzen können.
  const queryToken = req.query['access_token'];
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();

  return null;
}

/**
 * Cookie lesen – ohne zusätzliche Abhängigkeit.
 * Der Header sieht so aus: `name=wert; anderer=wert`.
 */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    return value ? decodeURIComponent(value) : null;
  }
  return null;
}

/**
 * Setzt das Sitzungs-Cookie.
 *
 * `HttpOnly` hält JavaScript fern (auch fremdes, falls je eine Lücke
 * auftaucht), `SameSite=Lax` verhindert, dass eine fremde Seite im Namen des
 * Angemeldeten schaltet. `Secure` wird nur gesetzt, wenn die Verbindung
 * tatsächlich verschlüsselt ist – im Heimnetz läuft der Hub üblicherweise
 * über HTTP, und ein `Secure`-Cookie käme dort nie an.
 */
export function setSessionCookie(req: Request, res: Response, token: string, maxAgeMs: number): void {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req: Request, res: Response): void {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function isSecure(req: Request): boolean {
  if (req.protocol === 'https') return true;
  const forwarded = req.headers['x-forwarded-proto'];
  return typeof forwarded === 'string' && forwarded.split(',')[0]?.trim() === 'https';
}
