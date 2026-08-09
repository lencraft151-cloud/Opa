import { notFound } from '../core/errors.js';
import type {
  AccessToken,
  AutomationRule,
  Device,
  Household,
  Integration,
  PublicIntegration,
  Room,
  Scene,
  Session,
  User,
} from '../core/types.js';
import { nowIso } from '../util/id.js';
import type { Database, DatabaseShape } from './database.js';

type Collection = keyof Omit<DatabaseShape, 'version'>;

/** Gemeinsame CRUD-Logik für alle Sammlungen. */
abstract class BaseRepository<T extends { id: string }> {
  protected constructor(
    protected readonly db: Database,
    protected readonly collection: Collection,
  ) {}

  protected all(): T[] {
    return this.db.read()[this.collection] as unknown as T[];
  }

  list(): T[] {
    return [...this.all()];
  }

  find(id: string): T | undefined {
    return this.all().find((item) => item.id === id);
  }

  get(id: string, label = 'Eintrag'): T {
    const found = this.find(id);
    if (!found) throw notFound(`${label} ${id}`);
    return found;
  }

  async insert(item: T): Promise<T> {
    await this.db.update((data) => {
      (data[this.collection] as unknown as T[]).push(item);
    });
    return item;
  }

  async patch(id: string, changes: Partial<T>, label = 'Eintrag'): Promise<T> {
    return this.db.update((data) => {
      const items = data[this.collection] as unknown as T[];
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) throw notFound(`${label} ${id}`);
      const updated = { ...(items[index] as T), ...changes, id } as T;
      if ('updatedAt' in (updated as object)) {
        (updated as unknown as { updatedAt: string }).updatedAt = nowIso();
      }
      items[index] = updated;
      return updated;
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.db.update((data) => {
      const items = data[this.collection] as unknown as T[];
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return false;
      items.splice(index, 1);
      return true;
    });
  }
}

export class HouseholdRepository extends BaseRepository<Household> {
  constructor(db: Database) {
    super(db, 'households');
  }

  /** Der Hub verwaltet aktuell genau einen Haushalt. */
  current(): Household | undefined {
    return this.all()[0];
  }

  require(): Household {
    const household = this.current();
    if (!household) {
      throw notFound('Haushalt (bitte zuerst die Einrichtung unter /api/setup abschließen)');
    }
    return household;
  }
}

export class RoomRepository extends BaseRepository<Room> {
  constructor(db: Database) {
    super(db, 'rooms');
  }

  listByHousehold(householdId: string): Room[] {
    return this.all()
      .filter((room) => room.householdId === householdId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  findByName(householdId: string, name: string): Room | undefined {
    const needle = name.trim().toLowerCase();
    return this.all().find(
      (room) => room.householdId === householdId && room.name.toLowerCase() === needle,
    );
  }
}

export class IntegrationRepository extends BaseRepository<Integration> {
  constructor(db: Database) {
    super(db, 'integrations');
  }

  listByHousehold(householdId: string): Integration[] {
    return this.all().filter((item) => item.householdId === householdId);
  }

  findByHost(householdId: string, host: string): Integration | undefined {
    return this.all().find(
      (item) =>
        item.householdId === householdId &&
        (item.config as { host?: string }).host?.toLowerCase() === host.toLowerCase(),
    );
  }

  /** Entfernt die verschlüsselten Secrets für die API-Ausgabe. */
  static toPublic(integration: Integration): PublicIntegration {
    const { secretsEnc, ...rest } = integration;
    return { ...rest, hasSecrets: secretsEnc !== null };
  }
}

/**
 * Hat der Nutzer die Fähigkeiten eines Geräts richtiggestellt, gilt seine
 * Angabe – überall. Deshalb geschieht das hier, am Übergang aus der
 * Datenbank, und nicht in jedem Aufrufer einzeln.
 *
 * Gespeichert bleiben beide: `capabilities` ist, was das Gerät meldet,
 * `capabilityOverride`, was der Mensch sagt. Ein Firmware-Update kann so
 * neue Fähigkeiten mitbringen, ohne die Richtigstellung zu überschreiben.
 */
export function effectiveDevice(device: Device): Device {
  if (!device.capabilityOverride || device.capabilityOverride.length === 0) return device;
  return { ...device, capabilities: [...device.capabilityOverride] };
}

export class DeviceRepository extends BaseRepository<Device> {
  constructor(db: Database) {
    super(db, 'devices');
  }

  override list(): Device[] {
    return this.all().map(effectiveDevice);
  }

  override find(id: string): Device | undefined {
    const device = this.all().find((entry) => entry.id === id);
    return device ? effectiveDevice(device) : undefined;
  }

  /** Der ungeschönte Datensatz – für die Bearbeitung der Richtigstellung. */
  raw(id: string): Device | undefined {
    return this.all().find((entry) => entry.id === id);
  }

  listByHousehold(householdId: string): Device[] {
    return this.all()
      .filter((device) => device.householdId === householdId)
      .map(effectiveDevice);
  }

  listByIntegration(integrationId: string): Device[] {
    return this.all()
      .filter((device) => device.integrationId === integrationId)
      .map(effectiveDevice);
  }

  listByRoom(roomId: string): Device[] {
    return this.all()
      .filter((device) => device.roomId === roomId)
      .map(effectiveDevice);
  }

  findByExternalId(integrationId: string, externalId: string): Device | undefined {
    const device = this.all().find(
      (entry) => entry.integrationId === integrationId && entry.externalId === externalId,
    );
    return device ? effectiveDevice(device) : undefined;
  }

  /** Schreibt Zustandsänderungen gepuffert (hochfrequent durch Polling). */
  async patchState(id: string, state: Device['state'], reachable: boolean): Promise<Device | undefined> {
    return this.db.updateDeferred((data) => {
      const device = data.devices.find((item) => item.id === id);
      if (!device) return undefined;
      device.state = { ...device.state, ...state, updatedAt: nowIso() };
      device.reachable = reachable;
      device.lastSeenAt = reachable ? nowIso() : device.lastSeenAt;
      device.updatedAt = nowIso();
      return effectiveDevice(device);
    });
  }

  async removeByIntegration(integrationId: string): Promise<number> {
    return this.db.update((data) => {
      const before = data.devices.length;
      data.devices = data.devices.filter((device) => device.integrationId !== integrationId);
      return before - data.devices.length;
    });
  }

  async clearRoom(roomId: string): Promise<void> {
    await this.db.update((data) => {
      for (const device of data.devices) {
        if (device.roomId === roomId) device.roomId = null;
      }
    });
  }
}

export class RuleRepository extends BaseRepository<AutomationRule> {
  constructor(db: Database) {
    super(db, 'rules');
  }

  listByHousehold(householdId: string): AutomationRule[] {
    return this.all().filter((rule) => rule.householdId === householdId);
  }

  listEnabled(householdId: string): AutomationRule[] {
    return this.listByHousehold(householdId).filter((rule) => rule.enabled);
  }
}

export class TokenRepository extends BaseRepository<AccessToken> {
  constructor(db: Database) {
    super(db, 'tokens');
  }

  findByHash(hash: string): AccessToken | undefined {
    return this.all().find((token) => token.tokenHash === hash);
  }

  listByHousehold(householdId: string): AccessToken[] {
    return this.all().filter((token) => token.householdId === householdId);
  }

  async touch(id: string): Promise<void> {
    await this.db.updateDeferred((data) => {
      const token = data.tokens.find((item) => item.id === id);
      if (token) token.lastUsedAt = nowIso();
    });
  }
}

export class UserRepository extends BaseRepository<User> {
  constructor(db: Database) {
    super(db, 'users');
  }

  listByHousehold(householdId: string): User[] {
    return this.all().filter((user) => user.householdId === householdId);
  }

  findByUsername(householdId: string, username: string): User | undefined {
    return this.all().find(
      (user) => user.householdId === householdId && user.username === username,
    );
  }
}

export class SessionRepository extends BaseRepository<Session> {
  constructor(db: Database) {
    super(db, 'sessions');
  }

  findByHash(hash: string): Session | undefined {
    return this.all().find((session) => session.tokenHash === hash);
  }

  listByUser(userId: string): Session[] {
    return this.all().filter((session) => session.userId === userId);
  }

  /** Verlängert eine Sitzung; läuft gepuffert, weil es oft passiert. */
  async touch(id: string, expiresAt: string): Promise<void> {
    await this.db.updateDeferred((data) => {
      const session = data.sessions.find((item) => item.id === id);
      if (!session) return;
      session.lastUsedAt = nowIso();
      session.expiresAt = expiresAt;
    });
  }

  /** Beendet alle Sitzungen eines Benutzers, optional bis auf eine. */
  async removeByUser(userId: string, keepId?: string): Promise<number> {
    return this.db.update((data) => {
      const before = data.sessions.length;
      data.sessions = data.sessions.filter(
        (session) => session.userId !== userId || session.id === keepId,
      );
      return before - data.sessions.length;
    });
  }

  async removeExpired(now: string): Promise<number> {
    return this.db.update((data) => {
      const before = data.sessions.length;
      data.sessions = data.sessions.filter((session) => session.expiresAt > now);
      return before - data.sessions.length;
    });
  }
}

export class SceneRepository extends BaseRepository<Scene> {
  constructor(db: Database) {
    super(db, 'scenes');
  }

  listByHousehold(householdId: string): Scene[] {
    return this.all()
      .filter((scene) => scene.householdId === householdId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'de'));
  }

  findByName(householdId: string, name: string): Scene | undefined {
    const needle = name.trim().toLowerCase();
    return this.all().find(
      (scene) => scene.householdId === householdId && scene.name.toLowerCase() === needle,
    );
  }

  /** Entfernt ein Gerät aus allen Szenen – etwa nach dem Löschen. */
  async removeDevice(deviceId: string): Promise<void> {
    await this.db.update((data) => {
      for (const scene of data.scenes) {
        scene.entries = scene.entries.filter((entry) => entry.deviceId !== deviceId);
      }
    });
  }
}

export interface Repositories {
  households: HouseholdRepository;
  rooms: RoomRepository;
  integrations: IntegrationRepository;
  devices: DeviceRepository;
  rules: RuleRepository;
  tokens: TokenRepository;
  users: UserRepository;
  sessions: SessionRepository;
  scenes: SceneRepository;
}

export function createRepositories(db: Database): Repositories {
  return {
    households: new HouseholdRepository(db),
    rooms: new RoomRepository(db),
    integrations: new IntegrationRepository(db),
    devices: new DeviceRepository(db),
    rules: new RuleRepository(db),
    tokens: new TokenRepository(db),
    users: new UserRepository(db),
    sessions: new SessionRepository(db),
    scenes: new SceneRepository(db),
  };
}
