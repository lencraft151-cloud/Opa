import { badRequest } from '../core/errors.js';
import type { IntegrationType } from '../core/types.js';
import { HueAdapter } from './hue/adapter.js';
import { ShellyAdapter } from './shelly/adapter.js';
import type { IntegrationAdapter } from './types.js';

/** Verwaltet alle verfügbaren Integrationen (Hue, Shelly, …). */
export class AdapterRegistry {
  private readonly adapters = new Map<IntegrationType, IntegrationAdapter>();

  register(adapter: IntegrationAdapter): void {
    this.adapters.set(adapter.type, adapter);
  }

  get(type: IntegrationType): IntegrationAdapter {
    const adapter = this.adapters.get(type);
    if (!adapter) throw badRequest(`Unbekannter Integrationstyp: ${type}`);
    return adapter;
  }

  has(type: string): type is IntegrationType {
    return this.adapters.has(type as IntegrationType);
  }

  list(): IntegrationAdapter[] {
    return [...this.adapters.values()];
  }
}

/** Registry mit allen mitgelieferten Adaptern. */
export function createAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new HueAdapter());
  registry.register(new ShellyAdapter());
  return registry;
}
