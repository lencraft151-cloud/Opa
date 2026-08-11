import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, isAppError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('http');

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: { code: 'not_found', message: `Route ${req.method} ${req.path} existiert nicht` },
  });
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (res.headersSent) return;

  if (isAppError(err)) {
    // Ein nicht erreichbares Gerät ist kein Fehler des Hubs – das wäre sonst
    // die häufigste ERROR-Zeile im Log.
    const isUpstream = err.code === 'upstream_error' || err.code === 'timeout';
    if (err.status >= 500 && !isUpstream) {
      log.error(err.message, { path: req.path, code: err.code, details: err.details });
    } else if (isUpstream) {
      log.warn(err.message, { path: req.path, code: err.code });
    } else {
      log.debug(err.message, { path: req.path, code: err.code });
    }
    res.status(err.status).json({ error: err.toJSON() });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'bad_request',
        message: describeIssues(err),
        hint: 'Korrigiere die unten genannten Felder und sende die Anfrage erneut.',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.') || '(root)',
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({
      error: {
        code: 'bad_request',
        message: 'Der gesendete Inhalt ist kein gültiges JSON.',
        hint: 'Prüfe Anführungszeichen und Kommas – häufig fehlt eine schließende Klammer.',
      },
    });
    return;
  }

  const error = err as Error;
  log.error('Unerwarteter Fehler', { path: req.path, error: error.message, stack: error.stack });
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Im Hub ist ein unerwarteter Fehler aufgetreten.',
      hint: 'Das Server-Log enthält die Einzelheiten. Bitte melde den Vorgang mit Zeitstempel.',
    },
  });
};

/** Baut aus Zod-Fehlern einen Satz, den man auch ohne Details versteht. */
function describeIssues(error: ZodError): string {
  const fields = [
    ...new Set(error.issues.map((issue) => issue.path.join('.')).filter((path) => path.length > 0)),
  ];
  if (fields.length === 0) return 'Die übergebenen Daten sind ungültig.';
  if (fields.length === 1) return `Das Feld "${fields[0]}" ist ungültig.`;
  return `Diese Felder sind ungültig: ${fields.join(', ')}.`;
}

/** Wandelt beliebige Fehler in AppError um (für Aufrufe außerhalb von Express). */
export function toAppError(err: unknown): AppError {
  if (isAppError(err)) return err;
  return new AppError(500, 'internal_error', (err as Error)?.message ?? 'Unbekannter Fehler');
}
