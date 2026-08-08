import { badRequest, conflict } from '../core/errors.js';
import type { Appearance, AccessToken, Household, SetupStep } from '../core/types.js';
import { DEFAULT_APPEARANCE, SETUP_STEPS } from '../core/types.js';
import { sha256Hex } from '../util/crypto.js';
import { createId, createToken, nowIso } from '../util/id.js';
import type { Repositories } from '../storage/repositories.js';

export interface CreateHouseholdInput {
  name: string;
  timezone?: string;
  locale?: string;
  pricePerKwh?: number;
  currency?: string;
  basePricePerMonth?: number;
}

/** In den Einstellungen änderbare Felder. */
export type HouseholdUpdate = Partial<
  Pick<
    Household,
    | 'name'
    | 'timezone'
    | 'locale'
    | 'pricePerKwh'
    | 'currency'
    | 'basePricePerMonth'
    | 'autoUpdate'
    | 'autoUpdateFrom'
    | 'autoUpdateTo'
  >
> & { appearance?: Partial<Appearance> };

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
      // Voreinstellung: grober Durchschnittspreis in Deutschland. Lässt sich
      // in den Einstellungen auf den eigenen Tarif ändern.
      pricePerKwh: input.pricePerKwh ?? 0.35,
      currency: input.currency?.trim() || 'EUR',
      basePricePerMonth: input.basePricePerMonth ?? 0,
      autoUpdate: false,
      autoUpdateFrom: '03:00',
      autoUpdateTo: '05:00',
      appearance: { ...DEFAULT_APPEARANCE },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.repos.households.insert(household);

    // Das erste Token wird genau einmal im Klartext ausgegeben.
    const { token } = await this.issueToken(household.id, 'Einrichtung');
    return { household, token };
  }

  async update(changes: HouseholdUpdate): Promise<Household> {
    const household = this.require();
    if (changes.timezone) assertValidTimezone(changes.timezone);
    if (changes.name !== undefined && !changes.name.trim()) {
      throw badRequest('Der Name darf nicht leer sein');
    }
    if (changes.pricePerKwh !== undefined && changes.pricePerKwh < 0) {
      throw badRequest(
        'Der Strompreis darf nicht negativ sein.',
        undefined,
        'Trage den Arbeitspreis deines Tarifs ein, z. B. 0.35 für 35 Cent pro kWh.',
      );
    }
    if (
      changes.autoUpdateFrom !== undefined &&
      changes.autoUpdateTo !== undefined &&
      changes.autoUpdateFrom === changes.autoUpdateTo
    ) {
      throw badRequest(
        'Das Update-Zeitfenster ist leer.',
        undefined,
        'Start- und Endzeit müssen sich unterscheiden, z. B. 03:00 bis 05:00.',
      );
    }
    // Die Darstellung wird feldweise zusammengeführt: Wer nur die Schriftgröße
    // ändert, soll nicht seine Farben verlieren.
    const patch: Partial<Household> = { ...changes, appearance: undefined };
    delete patch.appearance;
    if (changes.appearance) {
      patch.appearance = normalizeAppearance({
        ...appearanceOf(household),
        ...changes.appearance,
      });
    }
    return this.repos.households.patch(household.id, patch, 'Haushalt');
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

/**
 * Haushalte aus älteren Datenständen kennen die Darstellung noch nicht.
 * Statt überall auf `undefined` zu prüfen, gibt es hier immer einen Wert.
 */
export function appearanceOf(household: Household | undefined): Appearance {
  return normalizeAppearance({ ...DEFAULT_APPEARANCE, ...(household?.appearance ?? {}) });
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Grenzen einhalten: Eine Schrift jenseits der 200 % sprengt jedes Layout,
 * und eine Farbe, die keine ist, würde als ungültiges CSS still verpuffen.
 */
export function normalizeAppearance(appearance: Appearance): Appearance {
  // Alles, was keine Farbe ist, wird zur mitgelieferten Farbe – lieber die
  // Voreinstellung als ein unsichtbarer Knopf.
  const color = (value: string | null): string | null =>
    typeof value === 'string' && HEX_COLOR.test(value) ? value.toLowerCase() : null;

  return {
    fontScale: Math.min(1.6, Math.max(0.85, Number(appearance.fontScale) || 1)),
    accentColor: color(appearance.accentColor),
    accentColorAlt: color(appearance.accentColorAlt),
    theme: appearance.theme === 'dark' || appearance.theme === 'light' ? appearance.theme : 'auto',
    reduceMotion: appearance.reduceMotion === true,
  };
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('de-DE', { timeZone: timezone });
  } catch {
    throw badRequest(`Unbekannte Zeitzone: ${timezone}`);
  }
}
