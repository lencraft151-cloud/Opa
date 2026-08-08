import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../core/logger.js';
import type {
  AccessToken,
  AutomationRule,
  Device,
  Household,
  Integration,
  Room,
  Scene,
  Session,
  User,
} from '../core/types.js';
import { DEFAULT_APPEARANCE, DEFAULT_PRESENCE } from '../core/types.js';

const log = createLogger('db');

export const SCHEMA_VERSION = 1;

export interface DatabaseShape {
  version: number;
  households: Household[];
  rooms: Room[];
  integrations: Integration[];
  devices: Device[];
  rules: AutomationRule[];
  tokens: AccessToken[];
  users: User[];
  sessions: Session[];
  scenes: Scene[];
}

function emptyDatabase(): DatabaseShape {
  return {
    version: SCHEMA_VERSION,
    households: [],
    rooms: [],
    integrations: [],
    devices: [],
    rules: [],
    tokens: [],
    users: [],
    sessions: [],
    scenes: [],
  };
}

/**
 * Schlanker JSON-Store mit atomarem Schreiben (tmp-Datei + rename) und
 * serialisierten Schreibzugriffen. Bewusst ohne native Abhängigkeit wie
 * better-sqlite3 – für einen Haushalts-Hub mit einigen hundert Geräten
 * völlig ausreichend und überall lauffähig.
 */
export class Database {
  private data: DatabaseShape = emptyDatabase();
  private writeQueue: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private dirty = false;

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<DatabaseShape>;
      this.data = { ...emptyDatabase(), ...parsed, version: parsed.version ?? SCHEMA_VERSION };
      this.data = migrate(this.data);
      log.info('Datenbank geladen', {
        file: this.file,
        households: this.data.households.length,
        devices: this.data.devices.length,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        this.data = emptyDatabase();
        await this.persist();
        log.info('Neue Datenbank angelegt', { file: this.file });
      } else {
        throw new Error(
          `Datenbank ${this.file} konnte nicht gelesen werden: ${(err as Error).message}`,
        );
      }
    }
    this.loaded = true;
  }

  /** Lesender Zugriff auf den aktuellen Stand (nicht mutieren!). */
  read(): Readonly<DatabaseShape> {
    if (!this.loaded) throw new Error('Datenbank wurde noch nicht geladen');
    return this.data;
  }

  /**
   * Führt eine Mutation aus und schreibt anschließend auf die Platte.
   * Aufrufe werden serialisiert, damit sich parallele Schreibvorgänge nicht
   * gegenseitig überschreiben.
   */
  async update<T>(mutator: (data: DatabaseShape) => T | Promise<T>): Promise<T> {
    if (!this.loaded) throw new Error('Datenbank wurde noch nicht geladen');
    const task = this.writeQueue.then(async () => {
      const result = await mutator(this.data);
      await this.persist();
      return result;
    });
    // Kette am Leben halten, auch wenn ein Aufruf fehlschlägt.
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  /** Mutation ohne sofortiges Schreiben – für hochfrequente Zustandsupdates. */
  async updateDeferred<T>(mutator: (data: DatabaseShape) => T): Promise<T> {
    if (!this.loaded) throw new Error('Datenbank wurde noch nicht geladen');
    const task = this.writeQueue.then(() => {
      const result = mutator(this.data);
      this.dirty = true;
      return result;
    });
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  /** Schreibt ausstehende Änderungen aus `updateDeferred`. */
  async flush(): Promise<void> {
    if (!this.dirty) return;
    await this.update(() => {
      this.dirty = false;
    });
  }

  private async persist(): Promise<void> {
    const tmp = `${this.file}.${process.pid}.tmp`;
    const payload = JSON.stringify(this.data, null, 2);
    await writeFile(tmp, payload, 'utf8');
    await rename(tmp, this.file);
    this.dirty = false;
  }
}

/** Ergänzt Felder, die es beim letzten Speichern noch nicht gab. */
function migrate(data: DatabaseShape): DatabaseShape {
  if (data.version > SCHEMA_VERSION) {
    throw new Error(
      `Die Datenbank stammt aus einer neueren Version (${data.version} > ${SCHEMA_VERSION}).`,
    );
  }

  // Die Darstellung kam später dazu. Ohne diesen Schritt hätte ein
  // bestehender Haushalt keine Schriftgröße und keine Akzentfarbe.
  for (const household of data.households) {
    household.appearance = { ...DEFAULT_APPEARANCE, ...(household.appearance ?? {}) };
    household.presence = { ...DEFAULT_PRESENCE, ...(household.presence ?? {}) };
  }

  // Benutzer, Sitzungen und Szenen kamen später dazu. Ein Datenstand ohne
  // sie ist gültig – ohne diese Zeilen wäre er nur nicht benutzbar.
  data.users ??= [];
  data.sessions ??= [];
  data.scenes ??= [];

  data.version = SCHEMA_VERSION;
  return data;
}
