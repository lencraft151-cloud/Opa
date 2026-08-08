import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { badRequest } from '../core/errors.js';

/** Fängt Fehler aus async-Handlern ab und reicht sie an den Errorhandler weiter. */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/** Validiert `req.body` und liefert das typisierte Ergebnis. */
export function parseBody<T extends ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    throw badRequest(
      summarize(result.error, 'Die gesendeten Daten sind unvollständig oder falsch.'),
      formatIssues(result.error),
      'Die Liste unter "details" nennt jedes beanstandete Feld einzeln.',
    );
  }
  return result.data;
}

/** Validiert `req.query`. */
export function parseQuery<T extends ZodTypeAny>(schema: T, req: Request): z.infer<T> {
  const result = schema.safeParse(req.query);
  if (!result.success) {
    throw badRequest(
      summarize(result.error, 'Die Abfrageparameter sind ungültig.'),
      formatIssues(result.error),
      'Prüfe Schreibweise und erlaubte Werte der Parameter in der URL.',
    );
  }
  return result.data;
}

function formatIssues(error: z.ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
}

/** Nennt die betroffenen Felder direkt in der Hauptmeldung. */
function summarize(error: z.ZodError, fallback: string): string {
  const fields = [
    ...new Set(error.issues.map((issue) => issue.path.join('.')).filter(Boolean)),
  ];
  if (fields.length === 0) return fallback;
  if (fields.length === 1) return `Das Feld "${fields[0]}" ist ungültig.`;
  return `Diese Felder sind ungültig: ${fields.join(', ')}.`;
}

/** Query-Parameter, die als Wahrheitswert gemeint sind ("1", "true", "yes"). */
export const booleanQuery = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    if (value === undefined) return undefined;
    return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  });

export const numberQuery = (min: number, max: number) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      const parsed = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Wert muss zwischen ${min} und ${max} liegen` });
        return z.NEVER;
      }
      return parsed;
    });
