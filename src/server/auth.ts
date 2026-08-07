import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { unauthorized } from '../core/errors.js';
import { sha256Hex } from '../util/crypto.js';
import type { Container } from '../container.js';

/**
 * Endpunkte, die immer ohne Token erreichbar sind.
 *
 * Die Pfade sind relativ zum Mountpunkt des API-Routers (`/api`), weil Express
 * `req.path` innerhalb eines gemounteten Routers ohne dessen Präfix liefert.
 */
const PUBLIC_PATHS = new Set(['/health', '/system/info', '/setup/state']);

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Token-ID des authentifizierten Aufrufers. */
      tokenId?: string;
    }
  }
}

/**
 * Bearer-Token-Authentifizierung.
 *
 * Solange noch kein Haushalt existiert, bleibt die API offen – sonst käme man
 * nicht durch die Ersteinrichtung. Sobald der erste Haushalt (und damit das
 * erste Token) angelegt ist, greift die Prüfung.
 */
export function createAuthMiddleware(container: Container): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (container.config.authDisabled) return next();
    if (PUBLIC_PATHS.has(req.path)) return next();

    // Bootstrap: ohne Haushalt gibt es noch kein Token.
    if (!container.households.current()) return next();

    const token = extractToken(req);
    if (!token) {
      return next(
        unauthorized(
          'Es fehlt ein Zugriffstoken. Header "Authorization: Bearer <token>" mitsenden.',
        ),
      );
    }

    const record = container.repos.tokens.findByHash(sha256Hex(token));
    if (!record) return next(unauthorized('Das Zugriffstoken ist ungültig oder wurde widerrufen.'));

    req.tokenId = record.id;
    void container.repos.tokens.touch(record.id);
    return next();
  };
}

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim() || null;
  }
  const headerToken = req.headers['x-access-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();

  // Für den SSE-Stream: EventSource kann keine Header setzen.
  const queryToken = req.query['access_token'];
  if (typeof queryToken === 'string' && queryToken.trim()) return queryToken.trim();

  return null;
}
