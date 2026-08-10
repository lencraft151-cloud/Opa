import { badRequest } from '../core/errors.js';
import type { Household, Session, SetupStep } from '../core/types.js';
import type { Repositories } from '../storage/repositories.js';
import type { DeviceService } from './deviceService.js';
import type { HouseholdService, CreateHouseholdInput } from './householdService.js';
import type { RoomService } from './roomService.js';
import { normalizeUsername, type PublicUser, type UserService } from './userService.js';
import { assertUsablePassword } from '../util/password.js';

export interface SetupStepInfo {
  id: SetupStep;
  title: string;
  description: string;
  done: boolean;
  current: boolean;
}

export interface SetupState {
  hasHousehold: boolean;
  completed: boolean;
  currentStep: SetupStep;
  steps: SetupStepInfo[];
  household: Household | null;
  counts: {
    integrations: number;
    devices: number;
    rooms: number;
    unassignedDevices: number;
    temperatureSensors: number;
  };
  warnings: string[];
}

const STEP_DEFINITIONS: Array<{ id: SetupStep; title: string; description: string }> = [
  {
    id: 'household',
    title: 'Haushalt anlegen',
    description:
      'Name, Zeitzone und dein Zugang: Anmeldename und Passwort, mit denen du dich künftig anmeldest.',
  },
  {
    id: 'integrations',
    title: 'Geräte verbinden',
    description:
      'Hue Bridge koppeln (Knopf drücken) und Shelly-Geräte hinzufügen. Der Hub sucht automatisch im Netzwerk.',
  },
  {
    id: 'rooms',
    title: 'Räume anlegen',
    description: 'Wohnzimmer, Bad, Schlafzimmer … Räume gruppieren Geräte und Messwerte.',
  },
  {
    id: 'assign',
    title: 'Geräte zuordnen',
    description: 'Jedes Gerät einem Raum zuweisen. Hue-Räume werden automatisch übernommen.',
  },
  {
    id: 'groups',
    title: 'Nach Gruppen sortieren',
    description:
      'Alle Lichter, alle Rollläden, alle Heizungen auf einen Blick – und mit einem Griff ' +
      'einem Raum zuweisen oder ausblenden, was du nicht brauchst.',
  },
  {
    id: 'done',
    title: 'Fertig',
    description: 'Der Hub sammelt Messwerte und steuert alle Geräte an einem Ort.',
  },
];

/**
 * Führt durch die Ersteinrichtung. Der Zustand wird aus den vorhandenen Daten
 * abgeleitet, damit ein abgebrochener Assistent an der richtigen Stelle
 * weitermacht.
 */
export class SetupService {
  constructor(
    private readonly repos: Repositories,
    private readonly households: HouseholdService,
    private readonly rooms: RoomService,
    private readonly devices: DeviceService,
    private readonly users: UserService,
  ) {}

  state(): SetupState {
    const household = this.households.current() ?? null;

    if (!household) {
      return {
        hasHousehold: false,
        completed: false,
        currentStep: 'household',
        steps: STEP_DEFINITIONS.map((step) => ({
          ...step,
          done: false,
          current: step.id === 'household',
        })),
        household: null,
        counts: {
          integrations: 0,
          devices: 0,
          rooms: 0,
          unassignedDevices: 0,
          temperatureSensors: 0,
        },
        warnings: [],
      };
    }

    const integrations = this.repos.integrations.listByHousehold(household.id);
    const devices = this.repos.devices.listByHousehold(household.id);
    const rooms = this.repos.rooms.listByHousehold(household.id);
    const unassigned = devices.filter((device) => device.roomId === null);
    const temperatureSensors = devices.filter((device) =>
      device.capabilities.includes('sensor.temperature'),
    );

    const done: Record<SetupStep, boolean> = {
      household: true,
      integrations: integrations.length > 0,
      rooms: rooms.length > 0,
      assign: devices.length > 0 && unassigned.length === 0,
      /*
       * Dieser Schritt ist ein Angebot, keine Pflicht: Wer schon beim
       * Zuordnen fertig geworden ist, hat hier nichts mehr zu tun. Er gilt
       * deshalb als erledigt, sobald kein Gerät mehr ohne Raum ist.
       */
      groups: devices.length > 0 && unassigned.length === 0,
      done: household.setupCompletedAt !== null,
    };

    const warnings: string[] = [];
    if (integrations.length === 0) {
      warnings.push('Es ist noch keine Hue Bridge und kein Shelly verbunden.');
    }
    if (integrations.some((integration) => integration.status === 'error')) {
      warnings.push('Mindestens eine Integration meldet einen Fehler.');
    }
    if (unassigned.length > 0) {
      warnings.push(`${unassigned.length} Gerät(e) sind noch keinem Raum zugeordnet.`);
    }
    if (temperatureSensors.length === 0 && devices.length > 0) {
      warnings.push('Es wurde noch kein Temperatursensor gefunden.');
    }

    return {
      hasHousehold: true,
      completed: household.setupCompletedAt !== null,
      currentStep: household.setupStep,
      steps: STEP_DEFINITIONS.map((step) => ({
        ...step,
        done: done[step.id],
        current: step.id === household.setupStep,
      })),
      household,
      counts: {
        integrations: integrations.length,
        devices: devices.length,
        rooms: rooms.length,
        unassignedDevices: unassigned.length,
        temperatureSensors: temperatureSensors.length,
      },
      warnings,
    };
  }

  /**
   * Legt Haushalt und erstes Benutzerkonto in einem Schritt an.
   *
   * Beides gehört zusammen: Ein Haushalt ohne Konto wäre für niemanden
   * erreichbar, und ein Konto ohne Haushalt hätte nichts zu verwalten. Der
   * erste Benutzer ist immer Administrator.
   */
  async createHousehold(
    input: CreateHouseholdInput & { username: string; password: string; displayName?: string },
  ): Promise<{
    household: Household;
    user: PublicUser;
    sessionToken: string;
    session: Session;
    state: SetupState;
  }> {
    /*
     * Zuerst prüfen, dann anlegen.
     *
     * Andersherum ging es schief, und zwar endgültig: Der Haushalt entstand,
     * das Passwort wurde danach abgelehnt („enthält den Anmeldenamen"), und
     * zurück blieb ein Haushalt ohne einen einzigen Zugang. Ab da griff die
     * Anmeldepflicht – aber es gab niemanden, der sich hätte anmelden können.
     * Der Hub war zugesperrt, und der Schlüssel lag drinnen.
     */
    const username = normalizeUsername(input.username);
    assertUsablePassword(input.password, username);

    /*
     * Ein Haushalt ohne Zugang ist keine abgeschlossene Einrichtung, sondern
     * ein Abbruch. Der nächste Versuch übernimmt ihn, statt an „es existiert
     * bereits ein Haushalt" zu scheitern – sonst bliebe ein so entstandener
     * Stand für immer unbenutzbar.
     */
    const existing = this.households.current();
    const adopt = existing !== undefined && this.users.count(existing.id) === 0;
    const household = adopt ? await this.households.update(input) : await this.households.create(input);

    let user: PublicUser;
    try {
      user = await this.users.create(household.id, {
        username,
        password: input.password,
        displayName: input.displayName,
        role: 'admin',
      });
    } catch (err) {
      // Gürtel und Hosenträger: Sollte das Anlegen doch scheitern, bleibt
      // kein halber Haushalt zurück, den niemand mehr betreten kann.
      if (!adopt) await this.households.remove(household.id);
      throw err;
    }

    // Direkt angemeldet weitermachen – ein zweites Formular an dieser Stelle
    // wäre nur eine Hürde.
    const login = await this.users.login(household.id, username, input.password);

    return {
      household,
      user,
      sessionToken: login.token,
      session: login.session,
      state: this.state(),
    };
  }

  async goToStep(step: SetupStep): Promise<SetupState> {
    await this.households.setStep(step);
    return this.state();
  }

  /** Legt mehrere Räume auf einmal an (Schritt „Räume“). */
  async createRooms(names: string[]): Promise<SetupState> {
    const household = this.households.require();
    for (const name of names) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      await this.rooms.ensure(household.id, trimmed);
    }
    return this.state();
  }

  /** Weist mehrere Geräte in einem Rutsch Räumen zu (Schritt „Zuordnen“). */
  async assignDevices(
    assignments: Array<{ deviceId: string; roomId: string | null }>,
  ): Promise<SetupState> {
    if (assignments.length === 0) throw badRequest('Es wurden keine Zuordnungen übergeben');
    for (const assignment of assignments) {
      await this.devices.update(assignment.deviceId, { roomId: assignment.roomId });
    }
    return this.state();
  }

  async complete(): Promise<SetupState> {
    const household = this.households.require();
    const integrations = this.repos.integrations.listByHousehold(household.id);
    if (integrations.length === 0) {
      throw badRequest(
        'Vor dem Abschluss muss mindestens eine Hue Bridge oder ein Shelly verbunden sein.',
      );
    }
    await this.households.completeSetup();
    return this.state();
  }

  /** Vorschläge für typische Räume – erspart Tipparbeit im Assistenten. */
  suggestedRooms(): string[] {
    return [
      'Wohnzimmer',
      'Küche',
      'Schlafzimmer',
      'Bad',
      'Flur',
      'Arbeitszimmer',
      'Kinderzimmer',
      'Keller',
      'Garten',
    ];
  }
}
