import { AppError } from '../core/errors.js';
import type {
  Capability,
  DeviceCommand,
  DeviceState,
  Integration,
  IntegrationConfig,
  IntegrationSecrets,
  IntegrationType,
} from '../core/types.js';

/** Ein im Netzwerk gefundenes, noch nicht eingebundenes Gerät bzw. Bridge. */
export interface DiscoveredIntegration {
  type: IntegrationType;
  host: string;
  /** Herstellerseitige ID (Hue Bridge-ID bzw. Shelly-Geräte-ID). */
  externalId: string;
  name: string;
  model?: string;
  generation?: 1 | 2;
  /** true, wenn zum Verbinden der Link-Button gedrückt werden muss. */
  requiresLinkButton?: boolean;
  /** true, wenn das Gerät ein Passwort verlangt. */
  authRequired?: boolean;
  source: 'mdns' | 'cloud' | 'scan' | 'manual';
  /** Wird vom Service gesetzt: Ist das Gerät bereits eingebunden? */
  alreadyLinked?: boolean;
}

export interface LinkRequest {
  host: string;
  /** Anzeigename, den der Nutzer vergeben hat. */
  name?: string;
  username?: string;
  password?: string;
}

export interface LinkResult {
  name: string;
  externalId: string;
  config: IntegrationConfig;
  secrets: IntegrationSecrets | null;
}

/** Ein von einer Integration gemeldetes Gerät. */
export interface AdapterDevice {
  externalId: string;
  name: string;
  manufacturer?: string;
  model?: string;
  firmware?: string;
  capabilities: Capability[];
  state: DeviceState;
  reachable: boolean;
  /** Raumname, den die Integration selbst kennt (Hue-Räume). */
  suggestedRoom?: string;
}

/** Laufzeitkontext: Integration inklusive entschlüsselter Zugangsdaten. */
export interface IntegrationContext<
  C extends IntegrationConfig = IntegrationConfig,
  S extends IntegrationSecrets = IntegrationSecrets,
> {
  integration: Integration;
  config: C;
  secrets: S | null;
}

export interface DiscoverOptions {
  timeoutMs: number;
  allowCloud: boolean;
  /** Subnetz-Scan erlauben (langsamer, findet aber auch stumme Geräte). */
  allowScan: boolean;
}

export type StateUpdateHandler = (externalId: string, state: DeviceState) => void;

export interface IntegrationAdapter {
  readonly type: IntegrationType;
  readonly displayName: string;

  /** Sucht Geräte/Bridges im lokalen Netz. */
  discover(options: DiscoverOptions): Promise<DiscoveredIntegration[]>;

  /** Baut die Verbindung auf und liefert Konfiguration + Zugangsdaten. */
  link(request: LinkRequest): Promise<LinkResult>;

  /** Prüft, ob die gespeicherten Zugangsdaten noch funktionieren. */
  test(ctx: IntegrationContext): Promise<void>;

  /** Liefert alle Geräte der Integration inklusive aktuellem Zustand. */
  listDevices(ctx: IntegrationContext): Promise<AdapterDevice[]>;

  /** Liest nur die Zustände (günstiger als `listDevices`). */
  readStates(ctx: IntegrationContext): Promise<Map<string, DeviceState>>;

  /** Führt ein Kommando aus und liefert den daraus folgenden Zustand. */
  execute(
    ctx: IntegrationContext,
    externalId: string,
    command: DeviceCommand,
  ): Promise<DeviceState>;

  /** Optionaler Push-Kanal (Hue Eventstream). Gibt eine Stop-Funktion zurück. */
  subscribe?(ctx: IntegrationContext, onUpdate: StateUpdateHandler): Promise<() => void>;
}

/** Der Nutzer muss den Link-Button der Hue Bridge drücken. */
export class LinkButtonRequiredError extends AppError {
  constructor(message = 'Bitte den runden Knopf auf der Hue Bridge drücken und erneut versuchen.') {
    super(428, 'link_button_required', message);
    this.name = 'LinkButtonRequiredError';
  }
}

/** Das Gerät verlangt Zugangsdaten, die nicht (oder falsch) übergeben wurden. */
export class AuthenticationRequiredError extends AppError {
  constructor(message = 'Das Gerät verlangt Benutzername und Passwort.') {
    super(401, 'device_auth_required', message);
    this.name = 'AuthenticationRequiredError';
  }
}
