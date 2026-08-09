import type { AppConfig } from './config.js';
import { createLogger } from './core/logger.js';
import { createAdapterRegistry, type AdapterRegistry } from './adapters/registry.js';
import { Database } from './storage/database.js';
import { TelemetryStore } from './storage/telemetryStore.js';
import { createRepositories, type Repositories } from './storage/repositories.js';
import { AutomationService } from './services/automationService.js';
import { BackupService } from './services/backupService.js';
import { DeviceService } from './services/deviceService.js';
import { EnergyService } from './services/energyService.js';
import { HouseholdService } from './services/householdService.js';
import { HubUpdateService } from './services/hubUpdateService.js';
import { IntegrationService } from './services/integrationService.js';
import { PollingService } from './services/pollingService.js';
import { PresenceService } from './services/presenceService.js';
import { RoomService } from './services/roomService.js';
import { SceneService } from './services/sceneService.js';
import { SetupService } from './services/setupService.js';
import { TelemetryService } from './services/telemetryService.js';
import { UpdateService } from './services/updateService.js';
import { UserService } from './services/userService.js';
import { VERSION } from './version.js';

const log = createLogger('container');

export interface Container {
  config: AppConfig;
  db: Database;
  repos: Repositories;
  registry: AdapterRegistry;
  households: HouseholdService;
  rooms: RoomService;
  telemetry: TelemetryService;
  integrations: IntegrationService;
  devices: DeviceService;
  automations: AutomationService;
  polling: PollingService;
  setup: SetupService;
  energy: EnergyService;
  /** Sicherung und Wiederherstellung der Konfiguration. */
  backup: BackupService;
  /** Firmware der Geräte. */
  updates: UpdateService;
  /** Die Software des Hubs selbst. */
  hubUpdate: HubUpdateService;
  users: UserService;
  scenes: SceneService;
  presence: PresenceService;
  /** Startet Hintergrunddienste, sobald ein Haushalt existiert. */
  startBackgroundServices: () => Promise<void>;
  shutdown: () => Promise<void>;
}

/**
 * Baut alle Bausteine zusammen. Die Abhängigkeiten fließen nur in eine
 * Richtung (Storage → Services → HTTP), damit es keine Zyklen gibt.
 */
export async function createContainer(config: AppConfig): Promise<Container> {
  const db = new Database(config.databaseFile);
  await db.load();

  const telemetryStore = new TelemetryStore(config.telemetryDir, config.telemetryRetentionDays);
  await telemetryStore.init();

  const repos = createRepositories(db);
  const registry = createAdapterRegistry();

  const households = new HouseholdService(repos);
  const rooms = new RoomService(repos);
  const telemetry = new TelemetryService(telemetryStore, {
    minIntervalSeconds: config.telemetryMinIntervalSeconds,
    retentionDays: config.telemetryRetentionDays,
  });
  const integrations = new IntegrationService(repos, registry, rooms, telemetry, config);
  const devices = new DeviceService(repos, registry, integrations, telemetry);
  const automations = new AutomationService(repos, devices, households);
  const polling = new PollingService(repos, registry, integrations, devices, telemetry, config);
  const users = new UserService(repos);
  const setup = new SetupService(repos, households, rooms, devices, users);
  const energy = new EnergyService(repos, telemetry, households);
  const backup = new BackupService(db);
  const updates = new UpdateService(repos, registry, integrations, households);
  const hubUpdate = new HubUpdateService(VERSION, {
    checkUrl: config.hubUpdateCheckUrl,
    repoUrl: config.hubRepoUrl,
    branch: config.hubBranch,
    dataDir: config.dataDir,
  });
  const scenes = new SceneService(repos, devices);
  const presence = new PresenceService(repos, devices, households);

  const startBackgroundServices = async (): Promise<void> => {
    const household = households.current();
    if (!household) {
      log.info('Noch kein Haushalt eingerichtet – Hintergrunddienste warten');
      return;
    }
    await polling.start(household.id);
    automations.start(household.id);
    updates.start(household.id);
    presence.start(household.id);
  };

  const shutdown = async (): Promise<void> => {
    automations.stop();
    updates.stop();
    presence.stop();
    await polling.stop();
    await telemetry.flush();
    await db.flush();
    log.info('Alle Dienste beendet');
  };

  return {
    config,
    db,
    repos,
    registry,
    households,
    rooms,
    telemetry,
    integrations,
    devices,
    automations,
    polling,
    setup,
    energy,
    backup,
    updates,
    hubUpdate,
    users,
    scenes,
    presence,
    startBackgroundServices,
    shutdown,
  };
}
