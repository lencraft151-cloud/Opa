import { badRequest, conflict } from '../core/errors.js';
import { events } from '../core/events.js';
import type { Room } from '../core/types.js';
import { createId, nowIso } from '../util/id.js';
import type { Repositories } from '../storage/repositories.js';

export interface CreateRoomInput {
  name: string;
  icon?: string;
  targetTemperatureC?: number | null;
  sortOrder?: number;
}

export class RoomService {
  constructor(private readonly repos: Repositories) {}

  list(householdId: string): Room[] {
    return this.repos.rooms.listByHousehold(householdId);
  }

  get(id: string): Room {
    return this.repos.rooms.get(id, 'Raum');
  }

  async create(householdId: string, input: CreateRoomInput): Promise<Room> {
    const name = input.name.trim();
    if (!name) throw badRequest('Der Raum braucht einen Namen');
    if (this.repos.rooms.findByName(householdId, name)) {
      throw conflict(`Es gibt bereits einen Raum "${name}"`);
    }

    const existing = this.repos.rooms.listByHousehold(householdId);
    const room: Room = {
      id: createId('room'),
      householdId,
      name,
      icon: input.icon?.trim() || 'room',
      targetTemperatureC: input.targetTemperatureC ?? null,
      sortOrder: input.sortOrder ?? existing.length,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.repos.rooms.insert(room);
    events.emit('room.updated', { room });
    return room;
  }

  /** Legt den Raum an, falls er noch nicht existiert (z. B. Hue-Räume). */
  async ensure(householdId: string, name: string): Promise<Room> {
    const existing = this.repos.rooms.findByName(householdId, name);
    if (existing) return existing;
    return this.create(householdId, { name });
  }

  async update(id: string, changes: Partial<CreateRoomInput>): Promise<Room> {
    const room = this.get(id);
    const patch: Partial<Room> = {};

    if (changes.name !== undefined) {
      const name = changes.name.trim();
      if (!name) throw badRequest('Der Name darf nicht leer sein');
      const clash = this.repos.rooms.findByName(room.householdId, name);
      if (clash && clash.id !== id) throw conflict(`Es gibt bereits einen Raum "${name}"`);
      patch.name = name;
    }
    if (changes.icon !== undefined) patch.icon = changes.icon.trim() || 'room';
    if (changes.targetTemperatureC !== undefined) {
      patch.targetTemperatureC = changes.targetTemperatureC;
    }
    if (changes.sortOrder !== undefined) patch.sortOrder = changes.sortOrder;

    const updated = await this.repos.rooms.patch(id, patch, 'Raum');
    events.emit('room.updated', { room: updated });
    return updated;
  }

  /** Löscht den Raum; enthaltene Geräte bleiben bestehen (ohne Raumzuordnung). */
  async remove(id: string): Promise<void> {
    this.get(id);
    await this.repos.devices.clearRoom(id);
    await this.repos.rooms.remove(id);
  }

  async reorder(householdId: string, orderedIds: string[]): Promise<Room[]> {
    for (const [index, id] of orderedIds.entries()) {
      const room = this.repos.rooms.find(id);
      if (!room || room.householdId !== householdId) {
        throw badRequest(`Raum ${id} gehört nicht zu diesem Haushalt`);
      }
      await this.repos.rooms.patch(id, { sortOrder: index }, 'Raum');
    }
    return this.list(householdId);
  }
}
