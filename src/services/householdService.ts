import { badRequest, conflict } from '../core/errors.js';
import type {
  AccessToken,
  Appearance,
  Household,
  PresenceSimulation,
  SetupStep,
} from '../core/types.js';
import { DEFAULT_APPEARANCE, DEFAULT_PRESENCE, SETUP_STEPS } from '../core/types.js';
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
> & { appearance?: Partial<Appearance>; presence?: Partial<PresenceSimulation> };

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

  /**
   * Legt den Haushalt an. Das Benutzerkonto entsteht getrennt davon im
   * Einrichtungsassistenten – der Haushalt weiß nichts über Anmeldungen.
   */
  async create(input: CreateHouseholdInput): Promise<Household> {
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
      presence: { ...DEFAULT_PRESENCE },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.repos.households.insert(household);
    return household;
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
    // Darstellung und Urlaubsmodus werden feldweise zusammengeführt: Wer nur
    // die Schriftgröße ändert, soll nicht seine Farben verlieren.
    const { appearance: _appearance, presence: _presence, ...rest } = changes;
    const patch: Partial<Household> = { ...rest };

    if (changes.appearance) {
      patch.appearance = normalizeAppearance({
        ...appearanceOf(household),
        ...changes.appearance,
      });
    }
    if (changes.presence) {
      patch.presence = normalizePresence({ ...presenceOf(household), ...changes.presence });
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

  /**
   * Token widerrufen. Seit der Anmeldung mit Name und Passwort ist das
   * gefahrlos: Man sperrt sich damit nicht mehr aus, sondern nimmt nur einem
   * Skript den Zugang.
   */
  async revokeToken(id: string): Promise<void> {
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

export function presenceOf(household: Household | undefined): PresenceSimulation {
  return normalizePresence({ ...DEFAULT_PRESENCE, ...(household?.presence ?? {}) });
}

/**
 * Grenzen für den Urlaubsmodus. Unter zehn Minuten wäre das Geflacker
 * auffälliger als eine dunkle Wohnung.
 */
export function normalizePresence(presence: PresenceSimulation): PresenceSimulation {
  return {
    enabled: presence.enabled === true,
    from: TIME.test(presence.from) ? presence.from : DEFAULT_PRESENCE.from,
    to: TIME.test(presence.to) ? presence.to : DEFAULT_PRESENCE.to,
    roomIds: Array.isArray(presence.roomIds) ? [...new Set(presence.roomIds)] : [],
    averageIntervalMinutes: Math.min(
      120,
      Math.max(10, Math.round(Number(presence.averageIntervalMinutes) || 25)),
    ),
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
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
    // Vorgabe ist an – wer sie nicht will, schaltet sie ab.
    livePreview: appearance.livePreview !== false,
  };
}

function assertValidTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('de-DE', { timeZone: timezone });
  } catch {
    throw badRequest(`Unbekannte Zeitzone: ${timezone}`);
  }
}
