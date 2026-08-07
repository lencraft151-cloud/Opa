import { badRequest, conflict } from '../core/errors.js';
import type { AccessToken, Household, SetupStep } from '../core/types.js';
import { SETUP_STEPS } from '../core/types.js';
import { sha256Hex } from '../util/crypto.js';
import { createId, createToken, nowIso } from '../util/id.js';
import type { Repositories } from '../storage/repositories.js';

export interface CreateHouseholdInput {
  name: string;
  timezone?: string;
  locale?: string;
}

/**
 * Der Hub verwaltet bewusst genau einen Haushalt: Er läuft typischerweise auf
 * einem Gerät in genau dieser Wohnung. Mehrere Haushalte würden Netzwerk-
 * Discovery und Rechteverwaltung unnötig verkomplizieren.
 */
export class HouseholdService {
  constructor(private readonly repos: Repositories) {}

  current(): Household | undefined {
    return this.repos.households.current();
  }

  require(): Household {
    return this.repos.households.require();
  }

  isSetupComplete(): boolean {
    return this.current()?.setupCompletedAt !== null && this.current() !== undefined;
  }

  async create(input: CreateHouseholdInput): Promise<{ household: Household; token: string }> {
    if (this.current()) {
      throw conflict(
        'Es existiert bereits ein Haushalt. Zum Neuanlegen muss der bestehende zuerst gelöscht werden.',
      );
    }
    const name = input.name.trim();
    if (!name) throw badRequest('Der Haushalt braucht einen Namen');

    const timezone = input.timezone?.trim() || 'Europe/Berlin';
    assertValidTimezone(timezone);

    const household: Household = {
      id: createId('hh'),
      name,
      timezone,
      locale: input.locale?.trim() || 'de-DE',
      setupStep: 'integrations',
      setupCompletedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.repos.households.insert(household);

    // Das erste Token wird genau einmal im Klartext ausgegeben.
    const { token } = await this.issueToken(household.id, 'Einrichtung');
    return { household, token };
  }

  async update(changes: Partial<Pick<Household, 'name' | 'timezone' | 'locale'>>): Promise<Household> {
    const household = this.require();
    if (changes.timezone) assertValidTimezone(changes.timezone);
    if (changes.name !== undefined && !changes.name.trim()) {
      throw badRequest('Der Name darf nicht leer sein');
    }
    return this.repos.households.patch(household.id, changes, 'Haushalt');
  }

  async setStep(step: SetupStep): Promise<Household> {
    if (!SETUP_STEPS.includes(step)) throw badRequest(`Unbekannter Einrichtungsschritt: ${step}`);
    const household = this.require();
    return this.repos.households.patch(household.id, { setupStep: step }, 'Haushalt');
  }

  async completeSetup(): Promise<Household> {
    const household = this.require();
    return this.repos.households.patch(
      household.id,
      { setupStep: 'done', setupCompletedAt: nowIso() },
      'Haushalt',
    );
  }

  // -------------------------------------------------------------------------
  // Zugriffstoken
  // -------------------------------------------------------------------------

  async issueToken(householdId: string, name: string): Promise<{ token: string; record: AccessToken }> {
    const token = createToken();
    const record: AccessToken = {
      id: createId('tok'),
      householdId,
      name: name.trim() || 'Zugriffstoken',
      tokenHash: sha256Hex(token),
      createdAt: nowIso(),
      lastUsedAt: null,
    };
    await this.repos.tokens.insert(record);
    return { token, record };
  }

  listTokens(): AccessToken[] {
    const household = this.require();
    return this.repos.tokens.listByHousehold(household.id);
  }

  async revokeToken(id: string): Promise<void> {
    const household = this.require();
    const remaining = this.repos.tokens.listByHousehold(household.id);
    if (remaining.length <= 1) {
      throw conflict('Das letzte Zugriffstoken kann nicht gelöscht werden – sonst sperrst du dich aus.');
    }
    const removed = await this.repos.tokens.remove(id);
    if (!removed) throw badRequest(`Token ${id} existiert nicht`);
  }
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('de-DE', { timeZone: timezone });
  } catch {
    throw badRequest(`Unbekannte Zeitzone: ${timezone}`);
  }
}
