import { badRequest } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type {
  AutomationRule,
  Device,
  Household,
  Integration,
  Room,
  Scene,
} from '../core/types.js';
import type { Database } from '../storage/database.js';
import { nowIso } from '../util/id.js';
import { VERSION } from '../version.js';

const log = createLogger('backup');

export const BACKUP_FORMAT = 'smarthome-hub-backup';
export const BACKUP_VERSION = 1;

/**
 * Sicherung und Wiederherstellung.
 *
 * Was in die Datei kommt, ist eine bewusste Auswahl:
 *
 * - **Drin:** Haushalt samt Einstellungen, Räume, Geräte (Namen,
 *   Raumzuordnung, Richtigstellungen), Automationen, Szenen und die
 *   Integrationen mit Adresse und Typ.
 * - **Nicht drin:** Zugangsdaten zu Bridges, Passwörter, Sitzungen und
 *   Zugriffstoken.
 *
 * Der zweite Punkt ist der wichtige. Eine Sicherung liegt am Ende in einem
 * Download-Ordner, auf einem USB-Stick oder in einer Cloud – und damit an
 * einem Ort, den man nicht mehr überblickt. Eine Datei, aus der jemand das
 * Hue-Bridge-Konto und die Anmeldedaten aller Bewohner herausziehen kann,
 * gehört dort nicht hin.
 *
 * Der Preis: Nach dem Zurückspielen auf einen *anderen* Hub muss jede
 * Verbindung einmal erneut hergestellt werden. Das geht in den Einstellungen
 * unter „Erneut verbinden“ und dauert pro Bridge eine halbe Minute.
 *
 * Auf *demselben* Hub bleibt alles verbunden: Die bestehenden Zugangsdaten
 * werden beim Zurückspielen nicht angefasst.
 */
export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  hubVersion: string;
  household: Household;
  rooms: Room[];
  /**
   * Ohne `secretsEnc` – siehe Klassenkommentar. `hadSecrets` merkt sich nur,
   * *dass* es Zugangsdaten gab, nicht welche: Sonst ließe sich beim
   * Zurückspielen nicht unterscheiden, ob eine Verbindung neu herzustellen ist
   * oder ob sie – wie ein offener Shelly im eigenen Netz – nie ein Passwort
   * hatte.
   */
  integrations: Array<Omit<Integration, 'secretsEnc'> & { hadSecrets: boolean }>;
  devices: Device[];
  rules: AutomationRule[];
  scenes: Scene[];
}

export interface RestoreResult {
  rooms: number;
  devices: number;
  rules: number;
  scenes: number;
  integrations: number;
  /** Verbindungen, für die keine Zugangsdaten mehr vorliegen. */
  needRelink: string[];
}

export class BackupService {
  constructor(private readonly db: Database) {}

  /** Baut die Sicherungsdatei. */
  export(householdId: string): BackupFile {
    const data = this.db.read();
    const household = data.households.find((entry) => entry.id === householdId);
    if (!household) throw badRequest('Es gibt noch keinen Haushalt zum Sichern.');

    const mine = <T extends { householdId: string }>(items: readonly T[]): T[] =>
      items.filter((item) => item.householdId === householdId);

    return {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      createdAt: nowIso(),
      hubVersion: VERSION,
      household,
      rooms: mine(data.rooms),
      integrations: mine(data.integrations).map(({ secretsEnc, ...rest }) => ({
        ...rest,
        hadSecrets: secretsEnc !== null,
      })),
      devices: mine(data.devices),
      rules: mine(data.rules),
      scenes: mine(data.scenes),
    };
  }

  /**
   * Spielt eine Sicherung zurück.
   *
   * Ersetzt Haushalt, Räume, Geräte, Automationen und Szenen vollständig.
   * Benutzer, Sitzungen und Zugriffstoken bleiben unangetastet – wer die
   * Wiederherstellung anstößt, soll danach nicht ausgesperrt sein.
   *
   * Damit das aufgeht, übernimmt der wiederhergestellte Haushalt die ID des
   * bestehenden: Alle Verweise in der Sicherung werden umgeschrieben. Sonst
   * hingen die Benutzerkonten an einem Haushalt, den es nicht mehr gibt.
   */
  async restore(raw: unknown): Promise<RestoreResult> {
    const backup = parseBackup(raw);

    return this.db.update((data) => {
      const existing = data.households[0];
      const householdId = existing?.id ?? backup.household.id;

      // Zugangsdaten der bestehenden Verbindungen retten: Wer auf demselben
      // Hub zurückspielt, soll nicht jede Bridge neu koppeln müssen.
      const secrets = new Map<string, string | null>();
      for (const integration of data.integrations) {
        secrets.set(secretKeyOf(integration.type, integration.config), integration.secretsEnc);
      }

      const rekey = <T extends { householdId: string }>(items: T[]): T[] =>
        items.map((item) => ({ ...item, householdId }));

      data.households = [{ ...backup.household, id: householdId, updatedAt: nowIso() }];
      data.rooms = rekey(backup.rooms);
      data.devices = rekey(backup.devices);
      data.rules = rekey(backup.rules);
      data.scenes = rekey(backup.scenes);

      const needRelink: string[] = [];
      data.integrations = rekey(backup.integrations).map(({ hadSecrets, ...integration }) => {
        const secretsEnc = secrets.get(secretKeyOf(integration.type, integration.config)) ?? null;
        // Eine Verbindung ohne Zugangsdaten ist nur dann kaputt, wenn sie
        // welche hatte. Ein Shelly im eigenen Netz kommt oft ohne aus – den
        // hier als „neu zu verbinden“ zu melden, wäre falscher Alarm.
        const broken = secretsEnc === null && hadSecrets;
        if (broken) needRelink.push(integration.name);
        return {
          ...integration,
          secretsEnc,
          // Ohne Zugangsdaten ist die Verbindung nicht hergestellt – das
          // ehrlich zu melden ist besser, als „verbunden“ zu behaupten und
          // beim ersten Schaltbefehl aufzufliegen.
          status: broken ? 'pending' : integration.status,
          lastError: broken
            ? 'Aus einer Sicherung wiederhergestellt. Sicherungen enthalten keine ' +
              'Zugangsdaten – bitte einmal „Erneut verbinden“ wählen.'
            : integration.lastError,
        };
      });

      log.info('Sicherung zurückgespielt', {
        rooms: data.rooms.length,
        devices: data.devices.length,
        needRelink: needRelink.length,
      });

      return {
        rooms: data.rooms.length,
        devices: data.devices.length,
        rules: data.rules.length,
        scenes: data.scenes.length,
        integrations: data.integrations.length,
        needRelink,
      };
    });
  }
}

/**
 * Zwei Verbindungen gelten als dieselbe, wenn Typ und Adresse übereinstimmen.
 *
 * Nicht über die ID: Wer auf einem frisch aufgesetzten Hub zurückspielt, hat
 * neue IDs, aber dieselbe Bridge unter derselben Adresse.
 */
function secretKeyOf(type: string, config: unknown): string {
  const host = (config as { host?: string } | null)?.host ?? '';
  return `${type}@${host.toLowerCase()}`;
}

/**
 * Prüft, ob die hochgeladene Datei eine Sicherung ist.
 *
 * Bewusst mit klaren Meldungen statt eines Schema-Fehlers: Wer die falsche
 * Datei erwischt, soll das lesen können, ohne zu wissen, was ein Schema ist.
 */
export function parseBackup(raw: unknown): BackupFile {
  if (typeof raw !== 'object' || raw === null) {
    throw badRequest(
      'Das ist keine Sicherungsdatei.',
      undefined,
      'Wähle die Datei, die der Hub unter „Sicherung“ heruntergeladen hat.',
    );
  }
  const file = raw as Partial<BackupFile>;

  if (file.format !== BACKUP_FORMAT) {
    throw badRequest(
      'Diese Datei stammt nicht von diesem Hub.',
      undefined,
      'Sicherungen dieses Hubs beginnen mit "format": "smarthome-hub-backup".',
    );
  }
  if (typeof file.version !== 'number' || file.version > BACKUP_VERSION) {
    throw badRequest(
      `Die Sicherung stammt aus einer neueren Fassung des Hubs (Format ${String(file.version)}).`,
      undefined,
      'Aktualisiere den Hub, bevor du sie zurückspielst.',
    );
  }
  if (typeof file.household !== 'object' || file.household === null) {
    throw badRequest('In der Sicherung fehlt der Haushalt.');
  }

  const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

  return {
    format: BACKUP_FORMAT,
    version: file.version,
    createdAt: typeof file.createdAt === 'string' ? file.createdAt : nowIso(),
    hubVersion: typeof file.hubVersion === 'string' ? file.hubVersion : 'unbekannt',
    household: file.household as Household,
    rooms: list<Room>(file.rooms),
    // `hadSecrets` fehlt in Sicherungen, die vor diesem Feld entstanden sind.
    // Dort ist „hatte Zugangsdaten“ die sichere Annahme: einmal zu viel
    // nachfragen ist besser als eine stumme, nicht funktionierende Verbindung.
    integrations: list<Omit<Integration, 'secretsEnc'> & { hadSecrets?: boolean }>(
      file.integrations,
    ).map((integration) => ({ ...integration, hadSecrets: integration.hadSecrets !== false })),
    devices: list<Device>(file.devices),
    rules: list<AutomationRule>(file.rules),
    scenes: list<Scene>(file.scenes),
  };
}
