import { randomBytes, randomUUID } from 'node:crypto';

/** Kurze, URL-sichere ID mit Präfix, z. B. `dev_9f3a1c...`. */
export function createId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString('base64url')}`;
}

export function createUuid(): string {
  return randomUUID();
}

/** Zufälliges Zugriffstoken für die API. */
export function createToken(): string {
  return `sh_${randomBytes(32).toString('base64url')}`;
}

/** Deterministische, stabile ID aus Integrations-ID und externer Geräte-ID. */
export function externalKey(integrationId: string, externalId: string): string {
  return `${integrationId}::${externalId}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
