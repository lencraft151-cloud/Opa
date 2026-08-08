import { badRequest, conflict, errorMessage, notFound } from '../core/errors.js';
import { events } from '../core/events.js';
import { createLogger } from '../core/logger.js';
import type { Device, DeviceCommand, Scene, SceneEntry } from '../core/types.js';
import { createId, nowIso } from '../util/id.js';
import type { Repositories } from '../storage/repositories.js';
import type { DeviceService } from './deviceService.js';

const log = createLogger('scenes');

export interface CreateSceneInput {
  name: string;
  emoji?: string;
  roomId?: string | null;
  /** Geräte, deren aktueller Zustand gesichert wird. */
  deviceIds?: string[];
  /** Alternativ: bereits fertige Einträge (z. B. aus einer Bearbeitung). */
  entries?: SceneEntry[];
}

export interface ApplyResult {
  sceneId: string;
  name: string;
  applied: number;
  failed: number;
  results: Array<{ deviceId: string; ok: boolean; error?: string }>;
}

/**
 * Szenen.
 *
 * Der Kniff ist die Aufnahme: Statt den Nutzer Kommandos zusammenklicken zu
 * lassen, stellt er sein Zuhause so ein, wie er es haben will, und der Hub
 * liest den Zustand aus. Aus „Lampe ist an, 20 %, warmweiß" werden die drei
 * Kommandos, die genau das wiederherstellen.
 */
export class SceneService {
  constructor(
    private readonly repos: Repositories,
    private readonly devices: DeviceService,
  ) {}

  list(householdId: string): Scene[] {
    return this.repos.scenes.listByHousehold(householdId);
  }

  get(id: string): Scene {
    return this.repos.scenes.get(id, 'Szene');
  }

  async create(householdId: string, input: CreateSceneInput): Promise<Scene> {
    const name = input.name.trim();
    if (!name) throw badRequest('Die Szene braucht einen Namen.');
    if (this.repos.scenes.findByName(householdId, name)) {
      throw conflict(
        `Eine Szene namens „${name}" gibt es schon.`,
        undefined,
        'Wähle einen anderen Namen oder überschreibe die bestehende Szene.',
      );
    }

    const entries = input.entries ?? this.capture(householdId, input.deviceIds ?? []);
    if (entries.length === 0) {
      throw badRequest(
        'Die Szene enthält kein einziges Gerät.',
        undefined,
        'Wähle mindestens ein Gerät aus, dessen Zustand gesichert werden soll.',
      );
    }

    if (input.roomId) this.assertRoom(householdId, input.roomId);

    const scene: Scene = {
      id: createId('scn'),
      householdId,
      name,
      emoji: input.emoji?.trim() || '✨',
      roomId: input.roomId ?? null,
      entries,
      sortOrder: this.list(householdId).length,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastAppliedAt: null,
    };

    await this.repos.scenes.insert(scene);
    log.info('Szene gesichert', { name, devices: entries.length });
    return scene;
  }

  async update(
    id: string,
    changes: { name?: string; emoji?: string; roomId?: string | null; entries?: SceneEntry[] },
  ): Promise<Scene> {
    const scene = this.get(id);
    const patch: Partial<Scene> = {};

    if (changes.name !== undefined) {
      const name = changes.name.trim();
      if (!name) throw badRequest('Die Szene braucht einen Namen.');
      const existing = this.repos.scenes.findByName(scene.householdId, name);
      if (existing && existing.id !== id) {
        throw conflict(`Eine Szene namens „${name}" gibt es schon.`);
      }
      patch.name = name;
    }
    if (changes.emoji !== undefined) patch.emoji = changes.emoji.trim() || '✨';
    if (changes.roomId !== undefined) {
      if (changes.roomId) this.assertRoom(scene.householdId, changes.roomId);
      patch.roomId = changes.roomId;
    }
    if (changes.entries !== undefined) {
      if (changes.entries.length === 0) throw badRequest('Die Szene enthält kein einziges Gerät.');
      patch.entries = changes.entries;
    }

    return this.repos.scenes.patch(id, patch, 'Szene');
  }

  /** Nimmt die aktuellen Zustände neu auf – „so wie es jetzt ist". */
  async restamp(id: string): Promise<Scene> {
    const scene = this.get(id);
    const entries = this.capture(
      scene.householdId,
      scene.entries.map((entry) => entry.deviceId),
    );
    if (entries.length === 0) {
      throw badRequest(
        'Keines der Geräte dieser Szene ist noch da.',
        undefined,
        'Lege die Szene neu an, oder wähle andere Geräte aus.',
      );
    }
    return this.repos.scenes.patch(id, { entries }, 'Szene');
  }

  async remove(id: string): Promise<void> {
    const scene = this.get(id);
    await this.repos.scenes.remove(id);
    log.info('Szene gelöscht', { name: scene.name });
  }

  /**
   * Stellt eine Szene her.
   *
   * Ein Gerät, das gerade nicht antwortet, hält die anderen nicht auf: Die
   * Szene ist teilweise angekommen, und die Antwort sagt genau, welcher Teil.
   */
  async apply(id: string): Promise<ApplyResult> {
    const scene = this.get(id);
    const results: ApplyResult['results'] = [];

    for (const entry of scene.entries) {
      const device = this.repos.devices.find(entry.deviceId);
      if (!device) {
        results.push({ deviceId: entry.deviceId, ok: false, error: 'Gerät existiert nicht mehr' });
        continue;
      }
      try {
        for (const command of entry.commands) {
          await this.devices.execute(entry.deviceId, command);
        }
        results.push({ deviceId: entry.deviceId, ok: true });
      } catch (err) {
        results.push({ deviceId: entry.deviceId, ok: false, error: errorMessage(err) });
      }
    }

    await this.repos.scenes.patch(id, { lastAppliedAt: nowIso() }, 'Szene');

    const applied = results.filter((result) => result.ok).length;
    const failed = results.length - applied;

    events.emit('scene.applied', {
      householdId: scene.householdId,
      sceneId: scene.id,
      name: scene.name,
      applied,
      failed,
    });
    log.info('Szene hergestellt', { name: scene.name, applied, failed });

    return { sceneId: scene.id, name: scene.name, applied, failed, results };
  }

  // -------------------------------------------------------------------------

  /**
   * Liest den aktuellen Zustand der Geräte und leitet die Kommandos ab, die
   * ihn wiederherstellen.
   *
   * Ausgeschaltete Geräte bekommen nur `setPower: false` – Helligkeit und
   * Farbe einer dunklen Lampe mitzuschreiben würde sie beim Herstellen der
   * Szene kurz aufblitzen lassen.
   */
  capture(householdId: string, deviceIds: string[]): SceneEntry[] {
    const entries: SceneEntry[] = [];

    for (const deviceId of deviceIds) {
      const device = this.repos.devices.find(deviceId);
      if (!device || device.householdId !== householdId) {
        throw badRequest(
          `Das Gerät ${deviceId} gehört nicht zu diesem Haushalt.`,
          undefined,
          'Lade die Seite neu – die Geräteliste hat sich vermutlich geändert.',
        );
      }
      const commands = commandsForState(device);
      if (commands.length > 0) entries.push({ deviceId, commands });
    }

    return entries;
  }

  private assertRoom(householdId: string, roomId: string): void {
    const room = this.repos.rooms.find(roomId);
    if (!room || room.householdId !== householdId) throw notFound(`Raum ${roomId}`);
  }
}

/**
 * Aus einem Gerätezustand die Kommandos ableiten, die ihn herstellen.
 *
 * Die Reihenfolge zählt: Erst Farbe und Helligkeit setzen, dann schalten.
 * Umgekehrt sähe man beim Herstellen der Szene erst die alte Farbe.
 */
export function commandsForState(device: Device): DeviceCommand[] {
  const state = device.state ?? {};
  const has = (capability: string): boolean => device.capabilities.includes(capability as never);
  const commands: DeviceCommand[] = [];

  if (has('cover') && typeof state.position === 'number') {
    commands.push({ type: 'setPosition', position: Math.round(state.position) });
    if (has('cover.tilt') && typeof state.tilt === 'number') {
      commands.push({ type: 'setTilt', tilt: Math.round(state.tilt) });
    }
    return commands;
  }

  if (has('thermostat') && typeof state.targetTemperatureC === 'number') {
    commands.push({
      type: 'setTargetTemperature',
      targetTemperatureC: round(state.targetTemperatureC, 1),
    });
    return commands;
  }

  const isOn = state.on === true;

  if (isOn) {
    if (has('color') && typeof state.hue === 'number' && typeof state.saturation === 'number') {
      commands.push({
        type: 'setColor',
        hue: round(state.hue, 1),
        saturation: round(state.saturation, 1),
      });
    } else if (has('color_temperature') && typeof state.colorTemperatureK === 'number') {
      commands.push({
        type: 'setColorTemperature',
        kelvin: Math.round(state.colorTemperatureK),
      });
    }
    if (has('dimmer') && typeof state.brightness === 'number') {
      commands.push({ type: 'setBrightness', brightness: round(state.brightness, 1) });
    }
  }

  // Der Schaltbefehl kommt zuletzt und nur, wenn ihn das Gerät versteht.
  if (has('switch')) {
    // Beim Einschalten hat `setBrightness` bereits eingeschaltet; ein
    // zusätzliches `setPower` schadet aber nicht und macht die Szene
    // unabhängig davon, ob das Gerät dimmbar ist.
    commands.push({ type: 'setPower', on: isOn });
  }

  return commands;
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
