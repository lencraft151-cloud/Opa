import { createHash, randomBytes } from 'node:crypto';
import { badRequest, errorSummary, upstreamError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';
import type {
  MediaCommand,
  PublicSpotifyAccount,
  SpotifyAccount,
  SpotifyDevice,
  SpotifyPlayback,
} from '../core/types.js';
import type { Repositories } from '../storage/repositories.js';
import { decryptJson, encryptJson } from '../util/crypto.js';
import { request } from '../util/http.js';
import { createId, nowIso } from '../util/id.js';

const log = createLogger('spotify');

/**
 * Wozu der Hub Zugriff braucht – und keinen Deut mehr.
 *
 * Kein `playlist-modify`, kein `user-library-modify`, kein
 * `user-read-email`: Der Hub zeigt an, was läuft, und steuert die Wiedergabe.
 * Etwas an der Musiksammlung zu ändern gehört nicht dazu.
 */
export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
];

const ACCOUNTS_BASE = 'https://accounts.spotify.com';
const API_BASE = 'https://api.spotify.com/v1';

/** Wie lange ein begonnener Anmeldevorgang gültig bleibt. */
const PENDING_TTL_MS = 10 * 60 * 1000;

export interface SpotifySecrets {
  accessToken: string;
  refreshToken: string;
  /** Ablaufzeitpunkt des Zugriffstokens als ISO-Zeitstempel. */
  expiresAt: string;
}

export interface SpotifyStatus {
  account: PublicSpotifyAccount | null;
  playback: SpotifyPlayback | null;
  devices: SpotifyDevice[];
  /** Warum gerade nichts geht – z. B. „kein Premium". */
  note: string | null;
}

interface PendingAuth {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  startedAt: number;
}

export interface SpotifyEndpoints {
  accountsBase?: string;
  apiBase?: string;
}

/**
 * Spotify.
 *
 * Angemeldet wird sich mit **Authorization Code + PKCE**. Der Umweg über den
 * Browser ist unvermeidbar – Spotify lässt keine Anmeldung mit Name und
 * Passwort durch fremde Programme zu, aus gutem Grund.
 *
 * PKCE statt des klassischen Ablaufs mit Client-Geheimnis: Ein Geheimnis, das
 * bei jedem Nutzer derselben Anwendung auf der Platte liegt, ist keines. So
 * braucht der Hub nur die Client-ID, die ohnehin in jeder Adresszeile steht.
 *
 * Steuern (Play, Pause, Lautstärke) setzt bei Spotify **Premium** voraus. Das
 * ist deren Regel, keine des Hubs; er sagt es nur deutlich, statt einen
 * 403-Fehler durchzureichen.
 */
export class SpotifyService {
  private pending: PendingAuth | null = null;
  private readonly accountsBase: string;
  private readonly apiBase: string;

  constructor(
    private readonly repos: Repositories,
    private readonly secretKey: string,
    endpoints: SpotifyEndpoints = {},
  ) {
    this.accountsBase = endpoints.accountsBase ?? ACCOUNTS_BASE;
    this.apiBase = endpoints.apiBase ?? API_BASE;
  }

  // -------------------------------------------------------------------------
  // Anmeldung
  // -------------------------------------------------------------------------

  /**
   * Beginnt die Anmeldung und gibt die Adresse zurück, die der Nutzer
   * aufrufen muss.
   */
  async begin(
    householdId: string,
    input: { clientId: string; redirectUri: string },
  ): Promise<{ authorizeUrl: string }> {
    const clientId = input.clientId.trim();
    const redirectUri = input.redirectUri.trim();
    if (!clientId) {
      throw badRequest(
        'Es fehlt die Client-ID.',
        undefined,
        'Sie steht im Spotify-Dashboard (developer.spotify.com) bei deiner App.',
      );
    }
    if (!/^https?:\/\//i.test(redirectUri)) {
      throw badRequest(
        'Die Rückleitungsadresse muss mit http:// oder https:// beginnen.',
        undefined,
        'Sie muss im Spotify-Dashboard unter „Redirect URIs" **genau so** eingetragen sein.',
      );
    }

    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(16).toString('base64url');
    this.pending = { state, verifier, clientId, redirectUri, startedAt: Date.now() };

    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const url = new URL(`${this.accountsBase}/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', SPOTIFY_SCOPES.join(' '));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('state', state);

    // Das Konto entsteht schon hier, damit die Oberfläche nach dem Umweg über
    // Spotify weiß, worauf sie wartet.
    await this.saveAccount(householdId, { clientId, redirectUri });

    return { authorizeUrl: url.toString() };
  }

  /** Schließt die Anmeldung ab: Code gegen Token tauschen. */
  async complete(
    householdId: string,
    input: { code: string; state: string },
  ): Promise<PublicSpotifyAccount> {
    const pending = this.pending;
    if (!pending) {
      throw badRequest(
        'Zu dieser Rückmeldung gibt es keine begonnene Anmeldung.',
        undefined,
        'Das passiert, wenn der Hub zwischendurch neu gestartet wurde. Bitte noch einmal auf „Mit Spotify verbinden" klicken.',
      );
    }
    if (Date.now() - pending.startedAt > PENDING_TTL_MS) {
      this.pending = null;
      throw badRequest('Die Anmeldung hat zu lange gedauert. Bitte noch einmal beginnen.');
    }
    /*
     * Der `state` ist der Schutz gegen untergeschobene Rückmeldungen: Ohne
     * ihn könnte eine fremde Seite den Hub mit ihrem eigenen Code an ein
     * fremdes Spotify-Konto binden.
     */
    if (input.state !== pending.state) {
      throw badRequest('Die Rückmeldung gehört nicht zu dieser Anmeldung.');
    }

    const token = await this.tokenRequest({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: pending.redirectUri,
      client_id: pending.clientId,
      code_verifier: pending.verifier,
    });
    this.pending = null;

    const account = await this.saveAccount(householdId, {
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      secrets: token,
      lastError: null,
    });

    // Anzeigename und Tarif sind reine Anzeige – daran soll die Anmeldung
    // nicht scheitern.
    try {
      const me = await this.apiJson<{ display_name?: string; product?: string }>(
        householdId,
        'GET',
        '/me',
      );
      return this.toPublic(
        await this.repos.spotify.patch(
          account.id,
          {
            displayName: me?.display_name ?? null,
            product: me?.product ?? null,
            lastSeenAt: nowIso(),
          },
          'Spotify-Konto',
        ),
      );
    } catch (err) {
      log.debug('Profil nicht abrufbar', { error: errorSummary(err) });
      return this.toPublic(account);
    }
  }

  async disconnect(householdId: string): Promise<void> {
    const account = this.repos.spotify.findByHousehold(householdId);
    this.pending = null;
    if (!account) return;
    await this.repos.spotify.remove(account.id);
    log.info('Spotify getrennt');
  }

  // -------------------------------------------------------------------------
  // Wiedergabe
  // -------------------------------------------------------------------------

  async status(householdId: string): Promise<SpotifyStatus> {
    const account = this.repos.spotify.findByHousehold(householdId);
    if (!account) return { account: null, playback: null, devices: [], note: null };
    if (!account.secretsEnc) {
      return { account: this.toPublic(account), playback: null, devices: [], note: null };
    }

    try {
      const [playback, devices] = await Promise.all([
        this.playback(householdId),
        this.devices(householdId),
      ]);
      await this.repos.spotify.patch(
        account.id,
        { lastSeenAt: nowIso(), lastError: null },
        'Spotify-Konto',
      );
      return {
        account: this.toPublic(this.repos.spotify.get(account.id)),
        playback,
        devices,
        note: this.premiumNote(account),
      };
    } catch (err) {
      const message = errorSummary(err);
      await this.repos.spotify.patch(account.id, { lastError: message }, 'Spotify-Konto');
      return {
        account: this.toPublic(this.repos.spotify.get(account.id)),
        playback: null,
        devices: [],
        note: message,
      };
    }
  }

  /** Was gerade läuft – `null`, wenn Spotify nirgends spielt. */
  async playback(householdId: string): Promise<SpotifyPlayback | null> {
    const raw = await this.apiJson<RawPlayback>(householdId, 'GET', '/me/player');
    return raw ? toPlayback(raw) : null;
  }

  async devices(householdId: string): Promise<SpotifyDevice[]> {
    const raw = await this.apiJson<{ devices?: RawDevice[] }>(
      householdId,
      'GET',
      '/me/player/devices',
    );
    return (raw?.devices ?? []).map(toDevice);
  }

  async execute(householdId: string, command: MediaCommand): Promise<SpotifyPlayback | null> {
    switch (command.type) {
      case 'play':
        await this.apiJson(householdId, 'PUT', '/me/player/play');
        break;
      case 'pause':
        await this.apiJson(householdId, 'PUT', '/me/player/pause');
        break;
      case 'next':
        await this.apiJson(householdId, 'POST', '/me/player/next');
        break;
      case 'previous':
        await this.apiJson(householdId, 'POST', '/me/player/previous');
        break;
      case 'setVolume': {
        const volume = Math.min(100, Math.max(0, Math.round(command.volume)));
        await this.apiJson(householdId, 'PUT', `/me/player/volume?volume_percent=${volume}`);
        break;
      }
      case 'setMute':
        // Spotify kennt keine Stummschaltung – Lautstärke 0 ist das Nächste.
        await this.apiJson(
          householdId,
          'PUT',
          `/me/player/volume?volume_percent=${command.muted ? 0 : 30}`,
        );
        break;
    }
    return this.playback(householdId);
  }

  /** Wiedergabe auf ein anderes Gerät umziehen. */
  async transfer(householdId: string, deviceId: string, play = true): Promise<void> {
    await this.apiJson(householdId, 'PUT', '/me/player', { device_ids: [deviceId], play });
  }

  // -------------------------------------------------------------------------
  // Token
  // -------------------------------------------------------------------------

  /**
   * Gibt ein gültiges Zugriffstoken zurück und erneuert es bei Bedarf.
   *
   * Erneuert wird eine Minute vor Ablauf: Ein Token, das während der Anfrage
   * abläuft, wäre ein Fehler, den niemand nachvollziehen kann.
   */
  private async accessToken(householdId: string): Promise<string> {
    const account = this.requireAccount(householdId);
    if (!account.secretsEnc) {
      throw badRequest(
        'Die Anmeldung bei Spotify ist noch nicht abgeschlossen.',
        undefined,
        'Unter „Dienste → Spotify" auf „Mit Spotify verbinden" klicken.',
      );
    }

    const secrets = decryptJson<SpotifySecrets>(account.secretsEnc, this.secretKey);
    if (Date.parse(secrets.expiresAt) - Date.now() > 60_000) return secrets.accessToken;

    const refreshed = await this.tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: secrets.refreshToken,
      client_id: account.clientId,
    });
    /*
     * Spotify schickt beim Erneuern nicht immer ein neues Erneuerungstoken.
     * Fehlt es, gilt das alte weiter – es zu überschreiben wäre der sichere
     * Weg in eine Anmeldung, die sich nach einer Stunde selbst beendet.
     */
    const merged: SpotifySecrets = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken || secrets.refreshToken,
      expiresAt: refreshed.expiresAt,
    };
    await this.repos.spotify.patch(
      account.id,
      { secretsEnc: encryptJson(merged, this.secretKey) },
      'Spotify-Konto',
    );
    return merged.accessToken;
  }

  private async tokenRequest(fields: Record<string, string>): Promise<SpotifySecrets> {
    const body = new URLSearchParams(fields).toString();
    const res = await request(`${this.accountsBase}/api/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      timeoutMs: 10_000,
    });

    let parsed: RawToken | null = null;
    try {
      parsed = JSON.parse(res.body) as RawToken;
    } catch {
      parsed = null;
    }

    if (res.status >= 400 || !parsed?.access_token) {
      const description = parsed?.error_description ?? parsed?.error ?? `HTTP ${res.status}`;
      throw badRequest(`Spotify hat die Anmeldung abgelehnt: ${description}`, undefined, hintFor(description));
    }

    return {
      accessToken: parsed.access_token,
      refreshToken: parsed.refresh_token ?? '',
      expiresAt: new Date(Date.now() + (parsed.expires_in ?? 3600) * 1000).toISOString(),
    };
  }

  /**
   * Eine Anfrage an die Web-API.
   *
   * Gibt `null` zurück, wenn Spotify mit 204 antwortet – das ist der
   * Normalfall, wenn gerade gar nichts läuft, und kein Fehler.
   */
  private async apiJson<T>(
    householdId: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T | null> {
    const token = await this.accessToken(householdId);
    const res = await request(`${this.apiBase}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { json: body } : {}),
      timeoutMs: 10_000,
    });

    if (res.status === 204 || !res.body.trim()) return null;

    if (res.status === 403) {
      throw badRequest(
        'Spotify erlaubt das Steuern nur mit Premium.',
        { status: 403 },
        'Anzeigen, was läuft, geht auch ohne – Play, Pause und Lautstärke nicht. Das ist eine Regel von Spotify.',
      );
    }
    if (res.status === 404) {
      throw badRequest(
        'Spotify spielt gerade auf keinem Gerät.',
        { status: 404 },
        'Starte die Wiedergabe einmal auf dem Handy oder am Rechner – danach kann der Hub übernehmen.',
      );
    }
    if (res.status === 429) {
      throw upstreamError('Spotify bittet um eine Pause (zu viele Anfragen).', {
        retryAfter: res.headers['retry-after'],
      });
    }
    if (res.status >= 400) {
      let message = `HTTP ${res.status}`;
      try {
        message = (JSON.parse(res.body) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        /* Rohtext behalten */
      }
      throw upstreamError(`Spotify meldet: ${message}`, { status: res.status });
    }

    try {
      return JSON.parse(res.body) as T;
    } catch {
      throw upstreamError('Spotify hat keine gültige JSON-Antwort geliefert.');
    }
  }

  // -------------------------------------------------------------------------

  private requireAccount(householdId: string): SpotifyAccount {
    const account = this.repos.spotify.findByHousehold(householdId);
    if (!account) {
      throw badRequest(
        'Es ist kein Spotify-Konto verbunden.',
        undefined,
        'Unter „Dienste → Spotify" die Client-ID eintragen und verbinden.',
      );
    }
    return account;
  }

  private premiumNote(account: SpotifyAccount): string | null {
    if (account.product && account.product !== 'premium') {
      return 'Dieses Konto hat kein Premium. Der Hub zeigt an, was läuft – steuern lässt Spotify nur mit Premium zu.';
    }
    return null;
  }

  private toPublic(account: SpotifyAccount): PublicSpotifyAccount {
    const { secretsEnc, ...rest } = account;
    return { ...rest, connected: secretsEnc !== null };
  }

  private async saveAccount(
    householdId: string,
    input: {
      clientId: string;
      redirectUri: string;
      secrets?: SpotifySecrets;
      lastError?: string | null;
    },
  ): Promise<SpotifyAccount> {
    const existing = this.repos.spotify.findByHousehold(householdId);
    const changes = {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      scopes: [...SPOTIFY_SCOPES],
      ...(input.secrets ? { secretsEnc: encryptJson(input.secrets, this.secretKey) } : {}),
      ...(input.lastError !== undefined ? { lastError: input.lastError } : {}),
    };

    if (existing) return this.repos.spotify.patch(existing.id, changes, 'Spotify-Konto');

    return this.repos.spotify.insert({
      id: createId('spo'),
      householdId,
      displayName: null,
      product: null,
      secretsEnc: null,
      lastSeenAt: null,
      lastError: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      ...changes,
    });
  }
}

// ---------------------------------------------------------------------------
// Antwortformate
// ---------------------------------------------------------------------------

interface RawToken {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface RawDevice {
  id?: string | null;
  name?: string;
  type?: string;
  is_active?: boolean;
  volume_percent?: number | null;
}

interface RawPlayback {
  is_playing?: boolean;
  progress_ms?: number | null;
  shuffle_state?: boolean;
  device?: RawDevice;
  item?: {
    name?: string;
    duration_ms?: number;
    artists?: Array<{ name?: string }>;
    album?: { name?: string; images?: Array<{ url?: string; width?: number }> };
  } | null;
}

export function toDevice(raw: RawDevice): SpotifyDevice {
  return {
    id: raw.id ?? '',
    name: raw.name ?? 'Unbenanntes Gerät',
    type: raw.type ?? 'unknown',
    active: raw.is_active === true,
    volume: typeof raw.volume_percent === 'number' ? raw.volume_percent : null,
  };
}

/**
 * Macht aus der Spotify-Antwort das, was die Oberfläche braucht.
 *
 * Das Titelbild wird in mehreren Größen geliefert; genommen wird die
 * mittlere – die größte ist 640 px und für eine Kachel Verschwendung.
 */
export function toPlayback(raw: RawPlayback): SpotifyPlayback {
  const item = raw.item ?? null;
  const images = item?.album?.images ?? [];
  const artwork =
    images.find((image) => (image.width ?? 0) > 200 && (image.width ?? 0) <= 400) ??
    images[images.length - 1] ??
    images[0];

  return {
    playing: raw.is_playing === true,
    title: item?.name ?? null,
    artist: (item?.artists ?? []).map((artist) => artist.name).filter(Boolean).join(', ') || null,
    album: item?.album?.name ?? null,
    artworkUrl: artwork?.url ?? null,
    durationSeconds: item?.duration_ms ? Math.round(item.duration_ms / 1000) : null,
    positionSeconds: typeof raw.progress_ms === 'number' ? Math.round(raw.progress_ms / 1000) : null,
    deviceName: raw.device?.name ?? null,
    deviceId: raw.device?.id ?? null,
    volume: typeof raw.device?.volume_percent === 'number' ? raw.device.volume_percent : null,
    shuffle: raw.shuffle_state === true,
  };
}

/** Die zwei Fehler, die beim Einrichten wirklich passieren. */
function hintFor(description: string): string | undefined {
  if (/redirect/i.test(description)) {
    return 'Die Rückleitungsadresse muss im Spotify-Dashboard unter „Redirect URIs" zeichengenau eingetragen sein – inklusive Port und ohne abschließenden Schrägstrich.';
  }
  if (/client/i.test(description)) {
    return 'Client-ID prüfen: Sie steht im Spotify-Dashboard bei deiner App unter „Settings".';
  }
  return undefined;
}
