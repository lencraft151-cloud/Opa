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
import { NextcloudService } from './services/nextcloudService.js';
import { PollingService } from './services/pollingService.js';
import { PresenceService } from './services/presenceService.js';
import { RoomService } from './services/roomService.js';
import { SceneService } from './services/sceneService.js';
import { SetupService } from './services/setupService.js';
import { SonosService } from './services/sonosService.js';
import { ActivityService } from './services/activityService.js';
import { EffectService } from './services/effectService.js';
import { SpotifyService } from './services/spotifyService.js';
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
  /** Benachrichtigungen aus der eigenen Nextcloud. */
  nextcloud: NextcloudService;
  /** Lautsprecher im eigenen Netz. */
  sonos: SonosService;
  /** Wiedergabe bei Spotify. */
  spotify: SpotifyService;
  activity: ActivityService;
  effects: EffectService;
  presence: PresenceService;
  /** Startet Hintergrunddienste, sobald ein Haushalt existiert. */
  startBackgroundServices: () => Promise<void>;
  /** Hält sie an – nach dem Löschen des Haushalts. Der Prozess läuft weiter. */
  stopBackgroundServices: () => Promise<void>;
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
  /*
   * Sonos wird vor den Integrationen gebaut, weil es bei deren Netzwerksuche
   * mitsucht: Wer „Netzwerk durchsuchen" drückt, will alles finden, was da
   * ist – auch die Lautsprecher.
   */
  const sonos = new SonosService(repos);
  const integrations = new IntegrationService(repos, registry, rooms, telemetry, config, [sonos]);
  const devices = new DeviceService(repos, registry, integrations, telemetry);
  const automations = new AutomationService(repos, devices, households);
  const polling = new PollingService(repos, registry, integrations, devices, telemetry, config);
  const users = new UserService(repos);
  const setup = new SetupService(repos, households, rooms, devices, users);
  const energy = new EnergyService(repos, telemetry, households);
  const backup = new BackupService(db, telemetryStore);
  const updates = new UpdateService(repos, registry, integrations, households);
  const hubUpdate = new HubUpdateService(VERSION, {
    checkUrl: config.hubUpdateCheckUrl,
    repoUrl: config.hubRepoUrl,
    branch: config.hubBranch,
    dataDir: config.dataDir,
  });
  const scenes = new SceneService(repos, devices);
  const presence = new PresenceService(repos, devices, households);
  const nextcloud = new NextcloudService(repos, config.secretKey);
  const spotify = new SpotifyService(repos, config.secretKey);
  const activity = new ActivityService(repos);
  const effects = new EffectService(repos, devices);
  // Regeln dürfen Effekte starten – siehe `useEffects`.
  automations.useEffects(effects);
  // Und der Verlauf soll das Blinken eines Effekts nicht mitschreiben.
  activity.useEffects(effects);

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
    nextcloud.start(household.id);
    hubUpdate.start(household.id);
    activity.start(household.id);
  };

  /**
   * Hintergrunddienste anhalten, ohne den Prozess zu beenden.
   *
   * Unterschied zu `shutdown`: Hier wird nichts mehr weggeschrieben. Nach dem
   * Löschen eines Haushalts wäre ein `flush` genau falsch – er brächte
   * gepufferte Messwerte eines Haushalts zurück, den es nicht mehr gibt.
   */
  const stopBackgroundServices = async (): Promise<void> => {
    automations.stop();
    hubUpdate.stop();
    activity.stop();
    await effects.shutdown();
    updates.stop();
    presence.stop();
    nextcloud.stop();
    await polling.stop();
    log.info('Hintergrunddienste angehalten');
  };

  const shutdown = async (): Promise<void> => {
    automations.stop();
    hubUpdate.stop();
    activity.stop();
    await activity.flush();
    await effects.shutdown();
    updates.stop();
    presence.stop();
    nextcloud.stop();
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
    nextcloud,
    sonos,
    spotify,
    activity,
    effects,
    startBackgroundServices,
    stopBackgroundServices,
    shutdown,
  };
}
