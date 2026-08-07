import type { AppConfig } from './config.js';
import { createLogger } from './core/logger.js';
import { createAdapterRegistry, type AdapterRegistry } from './adapters/registry.js';
import { Database } from './storage/database.js';
import { TelemetryStore } from './storage/telemetryStore.js';
import { createRepositories, type Repositories } from './storage/repositories.js';
import { AutomationService } from './services/automationService.js';
import { DeviceService } from './services/deviceService.js';
import { HouseholdService } from './services/householdService.js';
import { IntegrationService } from './services/integrationService.js';
import { PollingService } from './services/pollingService.js';
import { RoomService } from './services/roomService.js';
import { SetupService } from './services/setupService.js';
import { TelemetryService } from './services/telemetryService.js';

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
  const setup = new SetupService(repos, households, rooms, devices);

  const startBackgroundServices = async (): Promise<void> => {
    const household = households.current();
    if (!household) {
      log.info('Noch kein Haushalt eingerichtet – Hintergrunddienste warten');
      return;
    }
    await polling.start(household.id);
    automations.start(household.id);
  };

  const shutdown = async (): Promise<void> => {
    automations.stop();
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
    startBackgroundServices,
    shutdown,
  };
}
