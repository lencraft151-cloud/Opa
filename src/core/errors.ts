/**
 * Anwendungsfehler mit HTTP-Status, maschinenlesbarem Code und – wichtig für
 * die Oberfläche – einem konkreten Hinweis, was der Nutzer tun kann.
 *
 * Die Faustregel im Projekt: `message` sagt, *was* nicht geht, `hint` sagt,
 * *was jetzt zu tun ist*. Fehler ohne Hinweis sind erlaubt, aber die Ausnahme.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  readonly hint: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    hint?: string,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }

  /** Serialisierbare Form für die HTTP-Antwort. */
  toJSON(): {
    code: string;
    message: string;
    hint?: string;
    details?: unknown;
  } {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export const badRequest = (message: string, details?: unknown, hint?: string): AppError =>
  new AppError(400, 'bad_request', message, details, hint);

export const unauthorized = (
  message = 'Nicht authentifiziert',
  hint = 'Sende das Zugriffstoken als Header "Authorization: Bearer <token>". ' +
    'Ein neues Token gibt es in den Einstellungen.',
): AppError => new AppError(401, 'unauthorized', message, undefined, hint);

export const forbidden = (message = 'Zugriff verweigert'): AppError =>
  new AppError(403, 'forbidden', message);

export const notFound = (what: string, hint?: string): AppError =>
  new AppError(404, 'not_found', `${what} wurde nicht gefunden`, undefined, hint);

export const conflict = (message: string, details?: unknown, hint?: string): AppError =>
  new AppError(409, 'conflict', message, details, hint);

/** Ein Gerät/eine Bridge hat nicht wie erwartet geantwortet. */
export const upstreamError = (message: string, details?: unknown, hint?: string): AppError =>
  new AppError(502, 'upstream_error', message, details, hint);

export const timeout = (message: string, hint?: string): AppError =>
  new AppError(504, 'timeout', message, undefined, hint);

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** Reduziert einen beliebigen Wert auf eine lesbare Fehlermeldung. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Meldung inklusive Handlungshinweis – für Logs und die Integrationsliste. */
export function errorSummary(err: unknown): string {
  if (isAppError(err) && err.hint) return `${err.message} – ${err.hint}`;
  return errorMessage(err);
}

/**
 * Übersetzt einen Node-Netzwerkfehler in eine Meldung, mit der ein Nutzer
 * etwas anfangen kann. Ohne diese Übersetzung stünde in der Oberfläche
 * „ECONNREFUSED 192.168.1.42:80“.
 */
export function describeNetworkError(code: string | undefined, host: string): AppError {
  switch (code) {
    case 'ECONNREFUSED':
      return upstreamError(
        `${host} nimmt keine Verbindung an.`,
        { code },
        'Das Gerät ist erreichbar, antwortet aber nicht auf dem HTTP-Port. ' +
          'Meist hilft ein Neustart des Geräts; bei Shelly kann auch der ' +
          'AP-Modus aktiv sein.',
      );
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return upstreamError(
        `${host} ist im Netzwerk nicht erreichbar.`,
        { code },
        'Prüfe, ob Hub und Gerät im selben Netz hängen. In Docker braucht der ' +
          'Hub "--network host", sonst sieht er das Heimnetz nicht.',
      );
    case 'ENOTFOUND':
      return upstreamError(
        `Der Name "${host}" lässt sich nicht auflösen.`,
        { code },
        'Trage statt des Hostnamens die feste IP-Adresse des Geräts ein.',
      );
    case 'ETIMEDOUT':
    case 'UND_ERR_CONNECT_TIMEOUT':
      return timeout(
        `${host} antwortet nicht.`,
        'Das Gerät schläft (Batteriesensoren wie der Shelly H&T) oder ist aus. ' +
          'Bei Batteriegeräten kurz die Taste am Gerät drücken und erneut versuchen.',
      );
    case 'ECONNRESET':
      return upstreamError(
        `${host} hat die Verbindung abgebrochen.`,
        { code },
        'Meist eine überlastete Bridge – der Hub versucht es beim nächsten Durchlauf erneut.',
      );
    case 'EPROTO':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return upstreamError(
        `Die verschlüsselte Verbindung zu ${host} ist fehlgeschlagen.`,
        { code },
        'Prüfe, ob unter dieser Adresse wirklich eine Hue Bridge erreichbar ist.',
      );
    default:
      return upstreamError(`Die Verbindung zu ${host} ist fehlgeschlagen.`, { code });
  }
}
