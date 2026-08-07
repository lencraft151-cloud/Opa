/** Anwendungsfehler mit HTTP-Status und maschinenlesbarem Code. */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown): AppError =>
  new AppError(400, 'bad_request', message, details);

export const unauthorized = (message = 'Nicht authentifiziert'): AppError =>
  new AppError(401, 'unauthorized', message);

export const forbidden = (message = 'Zugriff verweigert'): AppError =>
  new AppError(403, 'forbidden', message);

export const notFound = (what: string): AppError =>
  new AppError(404, 'not_found', `${what} wurde nicht gefunden`);

export const conflict = (message: string, details?: unknown): AppError =>
  new AppError(409, 'conflict', message, details);

/** Ein Gerät/eine Bridge hat nicht wie erwartet geantwortet. */
export const upstreamError = (message: string, details?: unknown): AppError =>
  new AppError(502, 'upstream_error', message, details);

export const timeout = (message: string): AppError => new AppError(504, 'timeout', message);

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
