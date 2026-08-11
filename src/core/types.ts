/**
 * Zentrale Domänen-Typen des Hubs.
 *
 * Bewusst ohne `enum`, damit die Dateien auch vom nativen Node-Type-Stripping
 * (`node --experimental-strip-types`) verarbeitet werden können.
 */

// ---------------------------------------------------------------------------
// Integrationen
// ---------------------------------------------------------------------------

export const INTEGRATION_TYPES = ['hue', 'shelly', 'homematic', 'fritzbox'] as const;
export type IntegrationType = (typeof INTEGRATION_TYPES)[number];

export const INTEGRATION_STATUS = ['pending', 'linked', 'error', 'disabled'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUS)[number];

/** Öffentlich sichtbare Konfiguration einer Hue Bridge. */
export interface HueIntegrationConfig {
  host: string;
  bridgeId: string;
  modelId?: string;
  apiVersion?: string;
  swVersion?: string;
  /**
   * Welche API diese Bridge versteht. Die alte runde Bridge (BSB001) kennt
   * nur `v1`; sie wird beim Verbinden erkannt und hier festgehalten.
   */
  protocol?: 'v1' | 'v2';
}

/** Öffentlich sichtbare Konfiguration eines Shelly-Geräts. */
export interface ShellyIntegrationConfig {
  host: string;
  /** 1 = Gen1 (REST), 2 = Gen2/3/4 (JSON-RPC) */
  generation: 1 | 2;
  deviceId: string;
  model?: string;
  firmware?: string;
  authRequired: boolean;
  /** Benutzername für Digest/Basic-Auth. Gen2 verwendet immer "admin". */
  username?: string;
}

/**
 * Homematic CCU bzw. RaspberryMatic. Angesprochen wird die JSON-RPC-
 * Schnittstelle unter `/api/homematic.cgi`, die auch alte CCU2 beherrschen.
 */
export interface HomematicIntegrationConfig {
  host: string;
  /** Anzeigename der Zentrale, wie sie sich selbst nennt. */
  serial?: string;
  version?: string;
  username: string;
}

/**
 * FRITZ!Box als Smart-Home-Zentrale. `username` darf leer sein – Boxen ohne
 * angelegte Benutzer kennen nur ein Kennwort.
 */
export interface FritzboxIntegrationConfig {
  host: string;
  username: string;
  model?: string;
  firmware?: string;
}

export type IntegrationConfig =
  | HueIntegrationConfig
  | ShellyIntegrationConfig
  | HomematicIntegrationConfig
  | FritzboxIntegrationConfig;

/** Verschlüsselt abgelegte Zugangsdaten einer Integration. */
export interface HueIntegrationSecrets {
  applicationKey: string;
  clientKey?: string;
}

export interface ShellyIntegrationSecrets {
  password?: string;
}

export interface HomematicIntegrationSecrets {
  password: string;
}

export interface FritzboxIntegrationSecrets {
  password: string;
}

export type IntegrationSecrets =
  | HueIntegrationSecrets
  | ShellyIntegrationSecrets
  | HomematicIntegrationSecrets
  | FritzboxIntegrationSecrets;

/** Ergebnis einer Firmware-Prüfung. */
export interface UpdateInfo {
  currentVersion: string | null;
  availableVersion: string | null;
  updateAvailable: boolean;
  /** Kann der Hub die Installation selbst anstoßen? */
  installable: boolean;
  checkedAt: string;
  /** Zeitpunkt der letzten vom Hub angestoßenen Installation. */
  lastInstallStartedAt?: string | null;
  note?: string;
}

export interface Integration {
  id: string;
  householdId: string;
  type: IntegrationType;
  name: string;
  status: IntegrationStatus;
  config: IntegrationConfig;
  /** AES-256-GCM verschlüsselte Secrets (siehe util/crypto.ts). */
  secretsEnc: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  /** Letzte Firmware-Prüfung; `null`, solange noch nicht geprüft wurde. */
  updateInfo: UpdateInfo | null;
  createdAt: string;
  updatedAt: string;
}

/** Integration ohne Secrets – das ist die Form, die über die API geht. */
export type PublicIntegration = Omit<Integration, 'secretsEnc'> & { hasSecrets: boolean };

// ---------------------------------------------------------------------------
// Haushalt / Räume
// ---------------------------------------------------------------------------

/**
 * Die Schritte der Ersteinrichtung.
 *
 * `groups` kam später dazu und steht bewusst *nach* dem Zuordnen: Wer dreißig
 * Geräte einzeln in Räume sortiert hat, will danach nicht noch einmal dreißig
 * Zeilen anfassen. Der Schritt fasst sie zu Gattungen zusammen – alle Lichter,
 * alle Rollläden, alle Heizungen – und lässt eine ganze Gattung auf einmal
 * einem Raum zuweisen oder ausblenden.
 */
export const SETUP_STEPS = [
  'household',
  'integrations',
  'rooms',
  'assign',
  'groups',
  'done',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export interface Household {
  id: string;
  name: string;
  timezone: string;
  /** Land/Region, nur informativ (z. B. für Anzeigeformate). */
  locale: string;
  setupStep: SetupStep;
  setupCompletedAt: string | null;
  /** Strompreis in Währungseinheiten je kWh – Basis der Kostenrechnung. */
  pricePerKwh: number;
  currency: string;
  /** Grundgebühr pro Monat, fließt in die Hochrechnung ein. */
  basePricePerMonth: number;
  /**
   * Wie oft der Hub die Geräte abfragt, in Sekunden.
   *
   * Steht am Haushalt und nicht nur in der Umgebung, weil es die eine
   * Einstellung ist, die man wirklich nachjustieren will: Wer den Rollladen
   * von Hand bewegt, will das schneller auf dem Bildschirm sehen; wer eine
   * Bridge mit dreißig Lampen hat, will sie nicht alle fünf Sekunden fragen.
   */
  pollIntervalSeconds: number;
  /**
   * Adresse der FRITZ!Box-Oberfläche, z. B. `http://fritz.box`.
   *
   * Der Notausgang für den Fall, dass die Anmeldung über die
   * Smart-Home-Schnittstelle partout nicht will: Der Hub zeigt dann die
   * Oberfläche der Box selbst an, statt so zu tun, als gäbe es keinen Weg.
   * Leer heißt: nicht anzeigen.
   */
  fritzboxUrl: string;
  /** Firmware-Updates automatisch installieren. */
  autoUpdate: boolean;
  /** Zeitfenster für automatische Updates, lokale Zeit `HH:MM`. */
  autoUpdateFrom: string;
  autoUpdateTo: string;
  /**
   * Darstellung. Absichtlich am Haushalt und nicht im Browser gespeichert:
   * Wer die Schrift größer stellt, will das auf dem Tablet in der Küche
   * genauso wie auf dem Handy.
   */
  appearance: Appearance;
  /** Anwesenheitssimulation für die Urlaubszeit. */
  presence: PresenceSimulation;
  createdAt: string;
  updatedAt: string;
}

/**
 * Urlaubsmodus.
 *
 * Eine Wohnung, in der abends nie ein Licht angeht, fällt auf. Im gewählten
 * Zeitfenster schaltet der Hub deshalb in unregelmäßigen Abständen Lichter an
 * und aus – unregelmäßig ist der Punkt, ein Muster wäre schlimmer als nichts.
 */
export interface PresenceSimulation {
  enabled: boolean;
  /** Zeitfenster in lokaler Zeit, `HH:MM`. */
  from: string;
  to: string;
  /** Räume, in denen geschaltet wird. Leer = überall, wo Licht ist. */
  roomIds: string[];
  /** Mittlerer Abstand zwischen zwei Schaltvorgängen in Minuten. */
  averageIntervalMinutes: number;
}

export const DEFAULT_PRESENCE: PresenceSimulation = {
  enabled: false,
  from: '17:30',
  to: '22:45',
  roomIds: [],
  averageIntervalMinutes: 25,
};

/** Anzeigeeinstellungen der Oberfläche. */
export interface Appearance {
  /** Skalierung der Grundschriftgröße, 1 = Normalgröße. */
  fontScale: number;
  /**
   * Akzentfarbe als `#rrggbb`. `null` bedeutet „mitgelieferte Farbe“ – die
   * ist auf hellen und dunklen Hintergrund getrennt abgestimmt, eine feste
   * Farbe kann das nicht leisten.
   */
  accentColor: string | null;
  /** Zweite Akzentfarbe für Verläufe. Ebenfalls `null` = mitgeliefert. */
  accentColorAlt: string | null;
  /** `auto` folgt der Systemeinstellung. */
  theme: ThemePreference;
  /** Bewegung reduzieren – für empfindliche Augen und schwache Geräte. */
  reduceMotion: boolean;
  /**
   * Lichtvorschau: Die Gerätekarte zeigt beim Verstellen, wie die Lampe
   * aussehen wird – Farbe und Helligkeit als Schein hinter der Karte.
   * Abschaltbar, denn auf einem schwachen Tablet kostet das Rechenzeit.
   */
  livePreview: boolean;
  /**
   * Sollen Meldungen aus Automationen und Lichteffekten als Popup erscheinen?
   *
   * Wer viele Regeln hat – vor allem wiederholende – bekommt sonst den halben
   * Tag Einblendungen zu sehen, die nichts erfordern. Aus heißt nur „nicht
   * einblenden": Im Verlauf steht weiterhin jede Auslösung, und Meldungen von
   * Fehlern, Updates oder aus der Nextcloud kommen unabhängig davon.
   */
  automationNotifications: boolean;
}

export const THEME_PREFERENCES = ['auto', 'dark', 'light'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

export const DEFAULT_APPEARANCE: Appearance = {
  fontScale: 1,
  accentColor: null,
  accentColorAlt: null,
  theme: 'auto',
  reduceMotion: false,
  livePreview: true,
  automationNotifications: true,
};

export interface Room {
  id: string;
  householdId: string;
  name: string;
  /** Freier Bezeichner für die UI, z. B. "living", "bedroom". */
  icon: string;
  /** Optionale Solltemperatur; wird von Automationen genutzt. */
  targetTemperatureC: number | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Geräte
// ---------------------------------------------------------------------------

export const CAPABILITIES = [
  'switch',
  'dimmer',
  'color',
  'color_temperature',
  'cover',
  /** Jalousie mit verstellbaren Lamellen. */
  'cover.tilt',
  /** Heizung mit einstellbarer Solltemperatur (Thermostat, Heizkörperventil). */
  'thermostat',
  'sensor.temperature',
  'sensor.humidity',
  'sensor.motion',
  'sensor.illuminance',
  'sensor.power',
  'sensor.energy',
  'sensor.battery',
  'button',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** Messgrößen, die als Zeitreihe archiviert werden. */
export const METRICS = [
  'temperatureC',
  'humidity',
  'illuminanceLux',
  'powerW',
  'energyWh',
  'batteryPercent',
  'brightness',
  'targetTemperatureC',
  'valvePosition',
] as const;
export type Metric = (typeof METRICS)[number];

export const COVER_STATES = ['open', 'closed', 'opening', 'closing', 'stopped'] as const;
export type CoverState = (typeof COVER_STATES)[number];

export interface DeviceState {
  on?: boolean;
  /** 0..100 */
  brightness?: number;
  /** Farbtemperatur in Kelvin */
  colorTemperatureK?: number;
  /** Farbton 0..360 */
  hue?: number;
  /** Sättigung 0..100 */
  saturation?: number;
  /** Rollladen-/Jalousie-Position 0 (zu) .. 100 (offen) */
  position?: number;
  /** Lamellenstellung 0..100 (nur bei Jalousien) */
  tilt?: number;
  /** Fahrzustand des Rollladens – für Animation und Stop-Knopf in der UI. */
  coverState?: CoverState;
  /** Solltemperatur einer Heizung in °C. */
  targetTemperatureC?: number;
  /** Ventilstellung eines Heizkörperthermostats in Prozent. */
  valvePosition?: number;
  temperatureC?: number;
  humidity?: number;
  motion?: boolean;
  illuminanceLux?: number;
  powerW?: number;
  energyWh?: number;
  batteryPercent?: number;
  updatedAt?: string;
}

export interface Device {
  id: string;
  householdId: string;
  integrationId: string;
  roomId: string | null;
  /** ID innerhalb der Integration (Hue-Resource-ID bzw. Shelly-Komponente). */
  externalId: string;
  vendor: IntegrationType;
  name: string;
  manufacturer: string | null;
  model: string | null;
  firmware: string | null;
  capabilities: Capability[];
  /**
   * Vom Nutzer richtiggestellte Fähigkeiten.
   *
   * Der Hub erkennt Geräte anhand ihres Typs und, wenn der unbekannt ist,
   * anhand ihrer Werte. Beides kann danebenliegen – bei einem Rollladen, der
   * sich wie ein Dimmer meldet, etwa. Dann sagt der Nutzer, was es ist, und
   * das steht hier. `null` heißt: dem Gerät glauben.
   */
  capabilityOverride: Capability[] | null;
  state: DeviceState;
  reachable: boolean;
  /** Vom Nutzer ausgeblendete Geräte tauchen im Dashboard nicht auf. */
  hidden: boolean;
  /**
   * Angeheftet – steht in der Geräteliste ganz oben.
   *
   * Der Grund ist die Rechnung, die jeder Haushalt aufmacht: Von dreißig
   * Geräten bedient man täglich vier. Die sollen nicht jedes Mal gesucht
   * werden müssen.
   */
  favorite: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Kommandos
// ---------------------------------------------------------------------------

export type DeviceCommand =
  | { type: 'setPower'; on: boolean }
  | { type: 'toggle' }
  | { type: 'setBrightness'; brightness: number }
  | { type: 'setColorTemperature'; kelvin: number }
  | { type: 'setColor'; hue: number; saturation: number }
  | { type: 'setPosition'; position: number }
  | { type: 'openCover' }
  | { type: 'closeCover' }
  | { type: 'stopCover' }
  | { type: 'setTilt'; tilt: number }
  | { type: 'setTargetTemperature'; targetTemperatureC: number }
  | { type: 'identify' };

// ---------------------------------------------------------------------------
// Automationen
// ---------------------------------------------------------------------------

export type ComparisonOperator = '<' | '<=' | '>' | '>=' | '==' | '!=';

export type RuleTrigger =
  | {
      type: 'sensor';
      deviceId: string;
      metric: Metric;
      operator: ComparisonOperator;
      value: number;
      /** Bedingung muss so lange ununterbrochen erfüllt sein. */
      forSeconds?: number;
    }
  | { type: 'deviceState'; deviceId: string; property: 'on' | 'motion'; equals: boolean }
  | { type: 'schedule'; at: string; days: number[] }
  /**
   * Wiederholend: alle `everyMinutes` Minuten, optional nur innerhalb eines
   * Zeitfensters und an bestimmten Wochentagen.
   */
  | {
      type: 'interval';
      /** Abstand in Minuten – oder `everySeconds` für kürzere Takte. */
      everyMinutes?: number;
      /**
       * Abstand in Sekunden, ab 5.
       *
       * Für Regeln wie „alle 20 Sekunden das Licht kurz an". In Minuten
       * ließe sich das gar nicht ausdrücken.
       */
      everySeconds?: number;
      from?: string;
      to?: string;
      days?: number[];
    };

export type RuleCondition =
  | { type: 'timeRange'; from: string; to: string }
  | { type: 'deviceState'; deviceId: string; property: 'on' | 'motion'; equals: boolean }
  | { type: 'sensor'; deviceId: string; metric: Metric; operator: ComparisonOperator; value: number };

export interface RuleTarget {
  deviceIds?: string[];
  roomIds?: string[];
  /** Alle Geräte des Haushalts mit passender Capability. */
  allWithCapability?: Capability;
}

export type RuleAction =
  | {
      type: 'command';
      target: RuleTarget;
      command: DeviceCommand;
      /**
       * Nach so vielen Sekunden wird das Kommando zurückgenommen.
       *
       * Damit lassen sich Regeln bauen, die von selbst wieder aufhören:
       * „alle 20 Minuten das Licht für 10 Sekunden an". Ohne das bräuchte man
       * zwei Regeln, von denen die zweite den ersten Zustand raten müsste.
       */
      forSeconds?: number;
    }
  | { type: 'webhook'; url: string; method?: 'GET' | 'POST'; body?: unknown }
  | { type: 'notify'; message: string }
  /**
   * Startet einen Lichteffekt – Disco, Farbwechsel, Gruselmodus.
   *
   * Kein gewöhnliches Kommando, weil ein Effekt kein Zustand ist, sondern ein
   * Vorgang: Er läuft weiter, bis die Zeit um ist oder jemand ihn beendet.
   */
  | { type: 'effect'; effect: LightEffect; target?: RuleTarget; minutes?: number }
  | { type: 'stopEffect'; effect?: LightEffect };

export interface AutomationRule {
  id: string;
  householdId: string;
  name: string;
  enabled: boolean;
  trigger: RuleTrigger;
  conditions: RuleCondition[];
  actions: RuleAction[];
  cooldownSeconds: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Zugriffstoken
// ---------------------------------------------------------------------------

export interface AccessToken {
  id: string;
  householdId: string;
  name: string;
  /** SHA-256 des Tokens – das Klartext-Token wird nur einmal ausgegeben. */
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string | null;
}

// ---------------------------------------------------------------------------
// Benutzer und Anmeldung
// ---------------------------------------------------------------------------

export const USER_ROLES = ['admin', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * Ein Mensch, der sich anmeldet.
 *
 * `admin` darf Benutzer verwalten, Integrationen entfernen und Einstellungen
 * ändern; `member` bedient das Zuhause. Der erste Benutzer entsteht beim
 * Einrichten und ist immer Administrator.
 */
export interface User {
  id: string;
  householdId: string;
  /** Anmeldename, klein geschrieben und eindeutig. */
  username: string;
  /** Wie der Name in der Oberfläche steht. */
  displayName: string;
  role: UserRole;
  /** scrypt-Ableitung inklusive Parametern und Salz – nie das Passwort selbst. */
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
  /** Fehlversuche seit der letzten erfolgreichen Anmeldung. */
  failedAttempts: number;
  /** Gesperrt bis – schützt gegen Durchprobieren. */
  lockedUntil: string | null;
}

// ---------------------------------------------------------------------------
// Szenen
// ---------------------------------------------------------------------------

/**
 * Eine gespeicherte Zusammenstellung von Gerätezuständen.
 *
 * „Fernsehabend" ist leichter zu erklären als „Deckenlicht 20 %, Stehlampe
 * warmweiß, Rollladen zu". Beim Sichern liest der Hub die aktuellen Zustände
 * aus und leitet daraus die Kommandos ab, die sie wiederherstellen.
 */
export interface Scene {
  id: string;
  householdId: string;
  name: string;
  emoji: string;
  /** Optional auf einen Raum bezogen – dann steht sie auch dort. */
  roomId: string | null;
  entries: SceneEntry[];
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  lastAppliedAt: string | null;
}

export interface SceneEntry {
  deviceId: string;
  /** Was ausgeführt wird, um diesen Zustand herzustellen. */
  commands: DeviceCommand[];
}

// ---------------------------------------------------------------------------
// Nextcloud
// ---------------------------------------------------------------------------

/**
 * Verbindung zu einer Nextcloud.
 *
 * Kein Gerät und deshalb keine Integration im Sinne von `Integration`: Es
 * gibt nichts zu schalten und nichts zu messen. Der Hub holt hier nur die
 * Benachrichtigungen ab und zeigt sie an – Talk-Nachrichten, geteilte
 * Dateien, Kalendererinnerungen.
 */
export interface NextcloudAccount {
  id: string;
  householdId: string;
  /** Basisadresse der Instanz, ohne abschließenden Schrägstrich. */
  baseUrl: string;
  username: string;
  /** Anzeigename, wie ihn die Instanz meldet. */
  displayName: string | null;
  serverVersion: string | null;
  enabled: boolean;
  /** Abfragetakt in Sekunden. */
  pollIntervalSeconds: number;
  /**
   * App-Passwort, verschlüsselt (siehe util/crypto.ts).
   *
   * Bewusst kein Anmeldepasswort: Nextcloud vergibt in den Einstellungen
   * unter „Sicherheit" Gerätepasswörter, die sich einzeln widerrufen lassen
   * und die auch bei aktiver Zwei-Faktor-Anmeldung funktionieren.
   */
  secretsEnc: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  /**
   * Höchste bereits gemeldete Benachrichtigungs-ID.
   *
   * Verhindert, dass nach einem Neustart des Hubs alle offenen
   * Benachrichtigungen erneut als Popup erscheinen.
   */
  lastNotificationId: number;
  createdAt: string;
  updatedAt: string;
}

/** Konto ohne Zugangsdaten – so geht es über die API. */
export type PublicNextcloudAccount = Omit<NextcloudAccount, 'secretsEnc'> & {
  hasSecrets: boolean;
};

/** Eine einzelne Benachrichtigung aus Nextcloud. */
export interface NextcloudNotification {
  id: number;
  /** Herkunfts-App, z. B. `spreed` (Talk) oder `files_sharing`. */
  app: string;
  subject: string;
  message: string;
  /** Absolute Adresse zum Öffnen in der Nextcloud, sofern vorhanden. */
  link: string | null;
  /** Zeitpunkt laut Nextcloud. */
  datetime: string;
}

// ---------------------------------------------------------------------------
// Musik: Sonos und Spotify
// ---------------------------------------------------------------------------

/**
 * Was man mit einer Wiedergabe machen kann – bei Sonos wie bei Spotify.
 *
 * Bewusst getrennt von `DeviceCommand`: Ein Lautsprecher ist kein Schalter mit
 * Extras. „Weiter" hat bei einer Lampe keine Bedeutung, und `setPower` hat bei
 * einem Lautsprecher keine.
 */
export type MediaCommand =
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'previous' }
  | { type: 'setVolume'; volume: number }
  | { type: 'setMute'; muted: boolean };

/**
 * Ein Sonos-Lautsprecher im eigenen Netz.
 *
 * Kein Gerät im Sinne von `Device`: Sonos spricht UPnP statt einer der
 * Hersteller-APIs, kennt keine der Fähigkeiten des Gerätemodells und hat
 * dafür Dinge, die dort nichts zu suchen haben – einen Titel, eine
 * Abspielposition, eine Gruppe.
 */
export interface SonosPlayer {
  id: string;
  householdId: string;
  /** IP oder Hostname. Der Steuerport ist bei Sonos immer 1400. */
  host: string;
  /** `RINCON_…` – die Kennung, die auch einen Adresswechsel übersteht. */
  uuid: string;
  /** Der Raumname aus der Sonos-App („Küche"). */
  roomName: string;
  model: string | null;
  softwareVersion: string | null;
  /** Zuordnung zu einem Raum des Hubs – rein für die Anzeige. */
  roomId: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Verlauf
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ['device', 'automation', 'scene', 'integration', 'system'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/**
 * Ein Eintrag im Verlauf: was ist wann passiert.
 *
 * Bewusst getrennt von den Messwerten. Eine Temperaturkurve beantwortet
 * „wie warm war es?"; der Verlauf beantwortet „was ist geschehen?" – wer
 * hat geschaltet, welche Automation lief, wann war ein Gerät weg. Das
 * eine ist eine Zahlenreihe, das andere eine Erzählung, und beides in
 * dieselbe Form zu pressen hätte beiden geschadet.
 *
 * Was hier *nicht* hineingehört: jede gemessene Zahl. Ein Sensor, der alle
 * fünfzehn Sekunden 21,4 °C meldet, erzeugt keinen Eintrag – sonst wäre der
 * Verlauf nach einer Stunde unlesbar und die Datenbank aufgebläht.
 */
export interface ActivityEntry {
  id: string;
  householdId: string;
  /** Zeitpunkt in ISO-Form. */
  at: string;
  kind: ActivityKind;
  /** Ein Satz, der ohne weiteren Zusammenhang verständlich ist. */
  message: string;
  level: 'info' | 'warn' | 'error';
  /** Für Filter und den Sprung zum Gerät. */
  deviceId: string | null;
  roomId: string | null;
  /** Zusatz für die Suche – Gerätename, Raumname, Herstellername. */
  detail: string | null;
}

/**
 * Die Lichteffekte. Steht hier und nicht nur im Dienst, weil auch
 * Automationsregeln sie benennen – und die liegen in der Datenbank.
 */
export const LIGHT_EFFECT_IDS = ['disco', 'farbwechsel', 'gruselig', 'kerze', 'gewitter'] as const;
export type LightEffect = (typeof LIGHT_EFFECT_IDS)[number];

export const TRANSPORT_STATES = ['playing', 'paused', 'stopped', 'transitioning'] as const;
export type TransportState = (typeof TRANSPORT_STATES)[number];

/** Was ein Lautsprecher gerade tut. */
export interface SonosPlayerState {
  playerId: string;
  reachable: boolean;
  transport: TransportState | null;
  volume: number | null;
  muted: boolean;
  title: string | null;
  artist: string | null;
  album: string | null;
  artworkUrl: string | null;
  durationSeconds: number | null;
  positionSeconds: number | null;
  /**
   * Kennung des Gruppenkoordinators. Steht hier eine fremde UUID, hängt
   * dieser Lautsprecher in der Gruppe eines anderen – Play/Pause gehen dann
   * an diesen anderen, sonst antwortet Sonos mit Fehler 701.
   */
  coordinatorUuid: string | null;
  /** Raumnamen aller Mitglieder der Gruppe, inklusive des eigenen. */
  groupMembers: string[];
  error: string | null;
}

/**
 * Verbindung zu Spotify.
 *
 * Angemeldet wird sich mit **Authorization Code + PKCE**: Dabei braucht der
 * Hub nur die Client-ID, kein Client-Geheimnis. Ein Geheimnis, das auf jedem
 * Hub im Klartext derselben Anwendung liegt, ist keines.
 */
export interface SpotifyAccount {
  id: string;
  householdId: string;
  clientId: string;
  /** Muss im Spotify-Dashboard genau so eingetragen sein. */
  redirectUri: string;
  displayName: string | null;
  /** `premium` oder `free` – Steuern geht nur mit Premium. */
  product: string | null;
  scopes: string[];
  /** Zugriffs- und Erneuerungstoken, verschlüsselt. */
  secretsEnc: string | null;
  lastSeenAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PublicSpotifyAccount = Omit<SpotifyAccount, 'secretsEnc'> & {
  /** Liegt eine abgeschlossene Anmeldung vor? */
  connected: boolean;
};

/** Was gerade bei Spotify läuft. */
export interface SpotifyPlayback {
  playing: boolean;
  title: string | null;
  artist: string | null;
  album: string | null;
  artworkUrl: string | null;
  durationSeconds: number | null;
  positionSeconds: number | null;
  /** Gerät, auf dem gespielt wird – Handy, Rechner, Sonos … */
  deviceName: string | null;
  deviceId: string | null;
  volume: number | null;
  shuffle: boolean;
  /**
   * Kennung des laufenden Titels und der Quelle, aus der er kommt
   * (Album, Playlist, Künstler).
   *
   * Gebraucht für die eingebettete Spotify-Oberfläche: Sie wird über eine
   * Adresse der Form `open.spotify.com/embed/<art>/<kennung>` angesprochen,
   * und ohne diese beiden Angaben wüsste sie nicht, was sie zeigen soll.
   */
  trackId: string | null;
  contextId: string | null;
  /** `album`, `playlist`, `artist` – die Art der Quelle. */
  contextType: string | null;
}

/** Ein bei Spotify angemeldetes Abspielgerät. */
export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  active: boolean;
  volume: number | null;
}

/** Eine angemeldete Sitzung, üblicherweise ein Browser. */
export interface Session {
  id: string;
  householdId: string;
  userId: string;
  /** SHA-256 des Sitzungsschlüssels. */
  tokenHash: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** Grobe Gerätekennung aus dem User-Agent, für die Sitzungsliste. */
  device: string | null;
}

// ---------------------------------------------------------------------------
// Telemetrie
// ---------------------------------------------------------------------------

export interface TelemetrySample {
  /** ISO-Zeitstempel */
  t: string;
  deviceId: string;
  metric: Metric;
  value: number;
}

export interface TelemetryQuery {
  deviceId?: string;
  metric?: Metric;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface TelemetryAggregate {
  deviceId: string;
  metric: Metric;
  count: number;
  min: number;
  max: number;
  avg: number;
  first: TelemetrySample;
  last: TelemetrySample;
}
