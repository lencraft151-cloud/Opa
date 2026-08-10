import { badRequest, errorMessage } from '../core/errors.js';
import { events } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import type {
  Capability,
  Device,
  DeviceCommand,
  DeviceState,
  RuleTarget,
} from '../core/types.js';
import { CAPABILITIES } from '../core/types.js';
import { nowIso } from '../util/id.js';
import type { AdapterRegistry } from '../adapters/registry.js';
import { effectiveDevice, type Repositories } from '../storage/repositories.js';
import type { IntegrationService } from './integrationService.js';
import type { TelemetryService } from './telemetryService.js';

const log = createLogger('devices');

export interface DeviceFilter {
  roomId?: string | null;
  integrationId?: string;
  capability?: Capability;
  includeHidden?: boolean;
  search?: string;
}

export interface DeviceUpdate {
  name?: string;
  roomId?: string | null;
  hidden?: boolean;
  favorite?: boolean;
  /**
   * Richtiggestellte Fähigkeiten. `null` nimmt die Korrektur zurück und
   * glaubt wieder dem Gerät.
   */
  capabilityOverride?: Capability[] | null;
}

export interface CommandResult {
  deviceId: string;
  ok: boolean;
  state?: DeviceState;
  error?: string;
}

export class DeviceService {
  constructor(
    private readonly repos: Repositories,
    private readonly registry: AdapterRegistry,
    private readonly integrations: IntegrationService,
    private readonly telemetry: TelemetryService,
  ) {}

  list(householdId: string, filter: DeviceFilter = {}): Device[] {
    let devices = this.repos.devices.listByHousehold(householdId);

    if (!filter.includeHidden) devices = devices.filter((device) => !device.hidden);
    if (filter.roomId !== undefined) devices = devices.filter((d) => d.roomId === filter.roomId);
    if (filter.integrationId) {
      devices = devices.filter((d) => d.integrationId === filter.integrationId);
    }
    if (filter.capability) {
      devices = devices.filter((d) => d.capabilities.includes(filter.capability as Capability));
    }
    if (filter.search) {
      const needle = filter.search.toLowerCase();
      devices = devices.filter(
        (d) =>
          d.name.toLowerCase().includes(needle) ||
          (d.model ?? '').toLowerCase().includes(needle) ||
          d.vendor.includes(needle),
      );
    }

    return devices.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  get(id: string): Device {
    return this.repos.devices.get(id, 'Gerät');
  }

  async update(id: string, changes: DeviceUpdate): Promise<Device> {
    const device = this.get(id);
    const patch: Partial<Device> = {};

    if (changes.name !== undefined) {
      const name = changes.name.trim();
      if (!name) throw badRequest('Der Gerätename darf nicht leer sein');
      patch.name = name;
    }
    if (changes.roomId !== undefined) {
      if (changes.roomId === null) {
        patch.roomId = null;
      } else {
        const room = this.repos.rooms.get(changes.roomId, 'Raum');
        if (room.householdId !== device.householdId) {
          throw badRequest('Der Raum gehört zu einem anderen Haushalt');
        }
        patch.roomId = room.id;
      }
    }
    if (changes.hidden !== undefined) patch.hidden = changes.hidden;
    if (changes.favorite !== undefined) patch.favorite = changes.favorite;

    if (changes.capabilityOverride !== undefined) {
      patch.capabilityOverride = normalizeOverride(changes.capabilityOverride, device);
    }

    /*
     * `patch` liefert den gespeicherten Datensatz zurück, in dem `capabilities`
     * noch das ist, was das Gerät meldet. Nach außen zählt aber die
     * Richtigstellung – sonst zeigte die Antwort auf genau die Änderung, die
     * eben vorgenommen wurde, noch den alten Stand.
     */
    const updated = effectiveDevice(await this.repos.devices.patch(id, patch, 'Gerät'));
    events.emit('device.updated', { device: updated, changed: Object.keys(patch) });
    return updated;
  }

  async remove(id: string): Promise<void> {
    const device = this.get(id);
    await this.repos.devices.remove(id);
    this.telemetry.forgetDevice(id);
    events.emit('device.removed', { deviceId: id, householdId: device.householdId });
  }

  // -------------------------------------------------------------------------
  // Steuerung
  // -------------------------------------------------------------------------

  async execute(deviceId: string, command: DeviceCommand): Promise<Device> {
    const device = this.get(deviceId);
    assertSupported(device, command);

    const adapter = this.registry.get(device.vendor);
    const ctx = this.integrations.contextForDevice(device);
    const state = await adapter.execute(ctx, device.externalId, command);

    log.debug('Kommando ausgeführt', { device: device.name, command: command.type });
    return this.applyState(device.id, state, true);
  }

  /** Führt ein Kommando auf mehreren Geräten aus (Raum, Capability, Liste). */
  async executeMany(
    householdId: string,
    target: RuleTarget,
    command: DeviceCommand,
  ): Promise<CommandResult[]> {
    const devices = this.resolveTargets(householdId, target);
    const results: CommandResult[] = [];

    for (const device of devices) {
      if (!supports(device, command)) continue;
      try {
        const updated = await this.execute(device.id, command);
        results.push({ deviceId: device.id, ok: true, state: updated.state });
      } catch (err) {
        results.push({ deviceId: device.id, ok: false, error: errorMessage(err) });
      }
    }
    return results;
  }

  resolveTargets(householdId: string, target: RuleTarget): Device[] {
    const all = this.repos.devices.listByHousehold(householdId);
    const selected = new Map<string, Device>();

    for (const id of target.deviceIds ?? []) {
      const device = all.find((item) => item.id === id);
      if (device) selected.set(device.id, device);
    }
    for (const roomId of target.roomIds ?? []) {
      for (const device of all.filter((item) => item.roomId === roomId)) {
        selected.set(device.id, device);
      }
    }
    if (target.allWithCapability) {
      for (const device of all.filter((item) =>
        item.capabilities.includes(target.allWithCapability as Capability),
      )) {
        selected.set(device.id, device);
      }
    }
    return [...selected.values()];
  }

  // -------------------------------------------------------------------------
  // Zustandsübernahme (Polling & Push)
  // -------------------------------------------------------------------------

  /**
   * Übernimmt einen von der Integration gemeldeten Zustand: speichert ihn,
   * archiviert Messwerte und meldet echte Änderungen als Event.
   */
  async applyState(deviceId: string, state: DeviceState, reachable: boolean): Promise<Device> {
    const before = this.get(deviceId);
    const changed = changedKeys(before.state, state);

    const device = await this.repos.devices.patchState(deviceId, state, reachable);
    if (!device) return before;

    this.telemetry.record(device, device.state);

    /*
     * Der Wechsel der Erreichbarkeit gehört in die Liste der Änderungen.
     * Bisher löste er zwar das Ereignis aus, stand aber nicht darin – wer
     * mithört, konnte „ist weg" nicht von „hat einen neuen Messwert"
     * unterscheiden.
     */
    const reachabilityChanged = before.reachable !== reachable;
    if (changed.length > 0 || reachabilityChanged) {
      events.emit('device.updated', {
        device,
        changed: reachabilityChanged ? [...changed, 'reachable'] : changed,
      });
    }
    return device;
  }

  /** Markiert alle Geräte einer Integration als nicht erreichbar. */
  async markIntegrationUnreachable(integrationId: string): Promise<void> {
    for (const device of this.repos.devices.listByIntegration(integrationId)) {
      if (!device.reachable) continue;
      await this.repos.devices.patchState(device.id, { updatedAt: nowIso() }, false);
      events.emit('device.updated', { device: { ...device, reachable: false }, changed: ['reachable'] });
    }
  }

  // -------------------------------------------------------------------------
  // Übersicht
  // -------------------------------------------------------------------------

  summary(householdId: string): {
    total: number;
    reachable: number;
    lightsOn: number;
    temperature: { deviceId: string; name: string; roomId: string | null; value: number }[];
    averageTemperatureC: number | null;
    totalPowerW: number;
  } {
    const devices = this.repos.devices.listByHousehold(householdId).filter((d) => !d.hidden);
    const temperature = devices
      .filter((device) => typeof device.state.temperatureC === 'number')
      .map((device) => ({
        deviceId: device.id,
        name: device.name,
        roomId: device.roomId,
        value: device.state.temperatureC as number,
      }));

    const totalPowerW = devices.reduce(
      (sum, device) => sum + (typeof device.state.powerW === 'number' ? device.state.powerW : 0),
      0,
    );

    return {
      total: devices.length,
      reachable: devices.filter((device) => device.reachable).length,
      lightsOn: devices.filter(
        (device) => device.capabilities.includes('switch') && device.state.on === true,
      ).length,
      temperature,
      averageTemperatureC:
        temperature.length > 0
          ? Math.round((temperature.reduce((s, t) => s + t.value, 0) / temperature.length) * 10) / 10
          : null,
      totalPowerW: Math.round(totalPowerW * 100) / 100,
    };
  }
}

const REQUIRED_CAPABILITY: Record<DeviceCommand['type'], Capability | null> = {
  setPower: 'switch',
  toggle: 'switch',
  setBrightness: 'dimmer',
  setColorTemperature: 'color_temperature',
  setColor: 'color',
  setPosition: 'cover',
  openCover: 'cover',
  closeCover: 'cover',
  stopCover: 'cover',
  setTilt: 'cover.tilt',
  setTargetTemperature: 'thermostat',
  identify: null,
};

/** Verständliche Bezeichnungen für Fehlermeldungen. */
const CAPABILITY_LABEL: Record<Capability, string> = {
  switch: 'schaltbar',
  dimmer: 'dimmbar',
  color: 'farbfähig',
  color_temperature: 'Farbtemperatur einstellbar',
  cover: 'Rollladen',
  'cover.tilt': 'Jalousie mit Lamellen',
  thermostat: 'Heizung mit Solltemperatur',
  'sensor.temperature': 'Temperatursensor',
  'sensor.humidity': 'Feuchtesensor',
  'sensor.motion': 'Bewegungsmelder',
  'sensor.illuminance': 'Helligkeitssensor',
  'sensor.power': 'Leistungsmessung',
  'sensor.energy': 'Energiezähler',
  'sensor.battery': 'Batterieanzeige',
  button: 'Taster',
};

/**
 * Prüft eine Richtigstellung.
 *
 * Der Hub hindert niemanden daran, einem Gerät eine Fähigkeit zuzusprechen,
 * die es womöglich nicht hat – bei einem Rollladen, der sich als Dimmer
 * meldet, ist genau das der Sinn der Sache. Eine leere Liste ist aber keine
 * Angabe, sondern ein Versehen: Sie würde das Gerät unbedienbar machen.
 */
export function normalizeOverride(
  override: Capability[] | null,
  device: Device,
): Capability[] | null {
  if (override === null) return null;

  const unique = [...new Set(override)].filter((capability) =>
    CAPABILITIES.includes(capability),
  );
  if (unique.length === 0) {
    throw badRequest(
      'Ohne eine einzige Fähigkeit ließe sich das Gerät nicht mehr bedienen.',
      undefined,
      `Wähle mindestens eine aus – oder setze auf "wie gemeldet" zurück (${device.capabilities.join(', ') || 'keine'}).`,
    );
  }
  return unique;
}

export function supports(device: Device, command: DeviceCommand): boolean {
  const required = REQUIRED_CAPABILITY[command.type];
  return required === null || device.capabilities.includes(required);
}

function assertSupported(device: Device, command: DeviceCommand): void {
  if (supports(device, command)) return;
  const required = REQUIRED_CAPABILITY[command.type] as Capability;
  const own =
    device.capabilities.map((capability) => CAPABILITY_LABEL[capability]).join(', ') || 'keine';

  throw badRequest(
    `"${device.name}" kann das nicht: dafür wäre "${CAPABILITY_LABEL[required]}" nötig.`,
    { required, capabilities: device.capabilities },
    required === 'cover.tilt'
      ? 'Nur Jalousien mit verstellbaren Lamellen unterstützen das; ein normaler Rollladen kennt nur die Position.'
      : `Dieses Gerät ist: ${own}.`,
  );
}

/** Ermittelt die tatsächlich geänderten Zustandsfelder. */
export function changedKeys(before: DeviceState, next: DeviceState): string[] {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    if (key === 'updatedAt') continue;
    if (before[key as keyof DeviceState] !== value) changed.push(key);
  }
  return changed;
}
