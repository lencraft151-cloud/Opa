import { EventEmitter } from 'node:events';
import type { Device, Integration, Room, TelemetrySample } from './types.js';

export interface HubEventMap {
  'device.added': { device: Device };
  'device.updated': { device: Device; changed: string[] };
  'device.removed': { deviceId: string; householdId: string };
  'integration.updated': { integration: Integration };
  'room.updated': { room: Room };
  'telemetry.sample': { sample: TelemetrySample };
  'automation.triggered': { ruleId: string; ruleName: string; householdId: string };
  'notification': { householdId: string; message: string; level: 'info' | 'warn' | 'error' };
}

export type HubEventName = keyof HubEventMap;

/**
 * Typisierter Event-Bus. Wird sowohl vom Polling-Service (Zustandsänderungen)
 * als auch von der SSE-Route (`GET /api/events`) genutzt.
 */
export class HubEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Ein Hub mit vielen Geräten kann durchaus viele Listener haben.
    this.emitter.setMaxListeners(200);
  }

  emit<K extends HubEventName>(name: K, payload: HubEventMap[K]): void {
    this.emitter.emit(name, payload);
    this.emitter.emit('*', { name, payload });
  }

  on<K extends HubEventName>(name: K, handler: (payload: HubEventMap[K]) => void): () => void {
    this.emitter.on(name, handler as (...args: unknown[]) => void);
    return () => this.emitter.off(name, handler as (...args: unknown[]) => void);
  }

  /** Abonniert alle Events – nützlich für den SSE-Stream. */
  onAny(handler: (event: { name: HubEventName; payload: unknown }) => void): () => void {
    this.emitter.on('*', handler as (...args: unknown[]) => void);
    return () => this.emitter.off('*', handler as (...args: unknown[]) => void);
  }
}

export const events = new HubEventBus();
