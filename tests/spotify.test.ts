/**
 * Spotify: die Anmeldung mit PKCE, das Erneuern der Token und die
 * Antwortformate der Web-API – geprüft gegen einen nachgebauten Dienst.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setLogLevel } from '../src/core/logger.ts';
import type { Household } from '../src/core/types.ts';
import { DEFAULT_APPEARANCE, DEFAULT_PRESENCE } from '../src/core/types.ts';
import {
  parseSpotifyUri,
  SpotifyService,
  toDevice,
  toPlayback,
} from '../src/services/spotifyService.ts';
import { Database } from '../src/storage/database.ts';
import { createRepositories } from '../src/storage/repositories.ts';
import { decryptJson, encryptJson } from '../src/util/crypto.ts';
import { nowIso } from '../src/util/id.ts';

setLogLevel('silent');

// ---------------------------------------------------------------------------
// Antwortformate
// ---------------------------------------------------------------------------

describe('Wiedergabe auswerten', () => {
  it('nimmt Titel, alle Interpreten und ein mittelgroßes Bild', () => {
    const playback = toPlayback({
      is_playing: true,
      progress_ms: 62_000,
      shuffle_state: true,
      device: { id: 'dev1', name: 'Küche', type: 'Speaker', volume_percent: 40 },
      item: {
        name: 'Under Pressure',
        duration_ms: 245_000,
        artists: [{ name: 'Queen' }, { name: 'David Bowie' }],
        album: {
          name: 'Hot Space',
          images: [
            { url: 'https://i.example/640.jpg', width: 640 },
            { url: 'https://i.example/300.jpg', width: 300 },
            { url: 'https://i.example/64.jpg', width: 64 },
          ],
        },
      },
    });

    assert.equal(playback.title, 'Under Pressure');
    // Zwei Interpreten gehören beide hin – „Queen" allein wäre falsch.
    assert.equal(playback.artist, 'Queen, David Bowie');
    assert.equal(playback.durationSeconds, 245);
    assert.equal(playback.positionSeconds, 62);
    // 640 px für eine Kachel wäre Verschwendung.
    assert.equal(playback.artworkUrl, 'https://i.example/300.jpg');
    assert.equal(playback.deviceName, 'Küche');
    assert.equal(playback.volume, 40);
    assert.equal(playback.shuffle, true);
  });

  it('kommt mit einer Wiedergabe ohne Titel zurecht', () => {
    const playback = toPlayback({ is_playing: false, item: null });
    assert.equal(playback.title, null);
    assert.equal(playback.artist, null);
    assert.equal(playback.playing, false);
  });

  it('liest die Geräteliste', () => {
    const device = toDevice({ id: 'x', name: 'Wohnzimmer', type: 'Speaker', is_active: true });
    assert.deepEqual(device, {
      id: 'x',
      name: 'Wohnzimmer',
      type: 'Speaker',
      active: true,
      volume: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Der ganze Weg gegen einen nachgebauten Dienst
// ---------------------------------------------------------------------------

const CLIENT_ID = 'testclientid';
const REDIRECT = 'http://127.0.0.1:8080/api/spotify/callback';

interface FakeSpotify {
  server: http.Server;
  url: string;
  /** Zuletzt beim Token-Tausch empfangene Felder. */
  lastTokenRequest: Record<string, string>;
  /** Alle Aufrufe der Web-API als `METHODE /pfad`. */
  calls: string[];
  accessToken: string;
  /** Antwortet das Erneuern mit einem neuen Erneuerungstoken? */
  rotateRefreshToken: boolean;
  /** Erzwingt einen Fehlercode für den nächsten API-Aufruf. */
  nextStatus: number | null;
}

async function startFakeSpotify(): Promise<FakeSpotify> {
  const state: FakeSpotify = {
    server: null as unknown as http.Server,
    url: '',
    lastTokenRequest: {},
    calls: [],
    accessToken: 'token-1',
    rotateRefreshToken: false,
    nextStatus: null,
  };

  state.server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === '/api/token') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        state.lastTokenRequest = Object.fromEntries(new URLSearchParams(body));
        if (state.lastTokenRequest['code'] === 'falscher-code') {
          json(400, { error: 'invalid_grant', error_description: 'Invalid redirect URI' });
          return;
        }
        state.accessToken = `token-${Date.now()}`;
        json(200, {
          access_token: state.accessToken,
          ...(state.lastTokenRequest['grant_type'] === 'authorization_code' ||
          state.rotateRefreshToken
            ? { refresh_token: 'refresh-1' }
            : {}),
          expires_in: 3600,
          token_type: 'Bearer',
        });
      });
      return;
    }

    // Ab hier: Web-API. Ohne gültiges Token ist Schluss.
    if (req.headers.authorization !== `Bearer ${state.accessToken}`) {
      json(401, { error: { status: 401, message: 'Invalid access token' } });
      return;
    }
    state.calls.push(`${req.method} ${url.pathname}${url.search}`);

    if (state.nextStatus) {
      const status = state.nextStatus;
      state.nextStatus = null;
      json(status, { error: { status, message: 'Player command failed' } });
      return;
    }

    switch (url.pathname) {
      case '/me':
        json(200, { display_name: 'Anna Beispiel', product: 'premium' });
        return;
      case '/me/player':
        if (req.method !== 'GET') {
          res.writeHead(204).end();
          return;
        }
        json(200, {
          is_playing: true,
          progress_ms: 1000,
          device: { id: 'dev1', name: 'Küche', type: 'Speaker', volume_percent: 30 },
          item: {
            name: 'Roads',
            duration_ms: 200_000,
            artists: [{ name: 'Portishead' }],
            album: { name: 'Dummy', images: [{ url: 'https://i.example/300.jpg', width: 300 }] },
          },
        });
        return;
      case '/me/player/devices':
        json(200, {
          devices: [{ id: 'dev1', name: 'Küche', type: 'Speaker', is_active: true }],
        });
        return;
      default:
        res.writeHead(204).end();
    }
  });

  await new Promise<void>((resolve) => state.server.listen(0, '127.0.0.1', resolve));
  const { port } = state.server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}`;
  return state;
}

const household = (id: string): Household => ({
  id,
  name: 'Testhaushalt',
  timezone: 'Europe/Berlin',
  locale: 'de-DE',
  setupStep: 'done',
  setupCompletedAt: nowIso(),
  pollIntervalSeconds: 15,
  fritzboxUrl: '',
  pricePerKwh: 0.35,
  currency: 'EUR',
  basePricePerMonth: 0,
  autoUpdate: false,
  autoUpdateFrom: '03:00',
  autoUpdateTo: '05:00',
  appearance: { ...DEFAULT_APPEARANCE },
  presence: { ...DEFAULT_PRESENCE },
  createdAt: nowIso(),
  updatedAt: nowIso(),
});

describe('Spotify verbinden und steuern', () => {
  let dir: string;
  let fake: FakeSpotify;
  let service: SpotifyService;
  let db: Database;
  let authorizeUrl: URL;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'smarthome-spotify-'));
    fake = await startFakeSpotify();
    db = new Database(path.join(dir, 'db.json'));
    await db.load();
    await db.update((data) => {
      data.households.push(household('hh_1'));
    });
    service = new SpotifyService(createRepositories(db), 'testschluessel', {
      accountsBase: fake.url,
      apiBase: fake.url,
    });
  });

  after(async () => {
    fake.server.closeAllConnections();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it('baut eine Anmeldeadresse mit PKCE', async () => {
    const { authorizeUrl: raw } = await service.begin('hh_1', {
      clientId: CLIENT_ID,
      redirectUri: REDIRECT,
    });
    authorizeUrl = new URL(raw);

    assert.equal(authorizeUrl.searchParams.get('response_type'), 'code');
    assert.equal(authorizeUrl.searchParams.get('client_id'), CLIENT_ID);
    assert.equal(authorizeUrl.searchParams.get('redirect_uri'), REDIRECT);
    assert.equal(authorizeUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok((authorizeUrl.searchParams.get('code_challenge') ?? '').length > 20);
    assert.ok((authorizeUrl.searchParams.get('state') ?? '').length > 10);
    // Nur die Rechte, die der Hub wirklich braucht.
    assert.equal(
      authorizeUrl.searchParams.get('scope'),
      'user-read-playback-state user-modify-playback-state user-read-currently-playing',
    );
  });

  it('weist eine Rückmeldung mit fremdem state ab', async () => {
    await assert.rejects(
      () => service.complete('hh_1', { code: 'egal', state: 'untergeschoben' }),
      /gehört nicht zu dieser Anmeldung/,
    );
  });

  it('tauscht den Code gegen Token – mit passendem Verifier', async () => {
    const state = authorizeUrl.searchParams.get('state') as string;
    const account = await service.complete('hh_1', { code: 'guter-code', state });

    assert.equal(account.connected, true);
    assert.equal(account.displayName, 'Anna Beispiel');
    assert.equal(account.product, 'premium');

    // Der Beweis für PKCE: Der mitgeschickte Verifier muss zu der
    // Prüfsumme passen, die vorher in der Adresse stand.
    const verifier = fake.lastTokenRequest['code_verifier'] as string;
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    assert.equal(challenge, authorizeUrl.searchParams.get('code_challenge'));
    // Ohne Client-Geheimnis – es gäbe keinen sicheren Ort dafür.
    assert.equal(fake.lastTokenRequest['client_secret'], undefined);
  });

  it('legt die Token nur verschlüsselt ab', () => {
    const stored = db.read().spotify[0];
    assert.ok(stored?.secretsEnc);
    assert.equal(JSON.stringify(stored).includes('refresh-1'), false);
    const secrets = decryptJson<{ refreshToken: string }>(
      stored.secretsEnc as string,
      'testschluessel',
    );
    assert.equal(secrets.refreshToken, 'refresh-1');
  });

  it('liest, was gerade läuft', async () => {
    const status = await service.status('hh_1');
    assert.equal(status.playback?.title, 'Roads');
    assert.equal(status.playback?.artist, 'Portishead');
    assert.equal(status.devices[0]?.name, 'Küche');
    assert.equal(status.note, null);
  });

  it('schickt Steuerbefehle an die richtigen Pfade', async () => {
    fake.calls.length = 0;
    await service.execute('hh_1', { type: 'pause' });
    await service.execute('hh_1', { type: 'next' });
    await service.execute('hh_1', { type: 'setVolume', volume: 55 });

    assert.ok(fake.calls.includes('PUT /me/player/pause'));
    assert.ok(fake.calls.includes('POST /me/player/next'));
    assert.ok(fake.calls.includes('PUT /me/player/volume?volume_percent=55'));
  });

  it('begrenzt die Lautstärke, statt sie durchzureichen', async () => {
    fake.calls.length = 0;
    await service.execute('hh_1', { type: 'setVolume', volume: 300 });
    assert.ok(fake.calls.includes('PUT /me/player/volume?volume_percent=100'));
  });

  it('erneuert ein abgelaufenes Token von allein', async () => {
    const account = db.read().spotify[0];
    assert.ok(account);
    const before = fake.accessToken;

    // Token künstlich altern lassen.
    await db.update((data) => {
      const entry = data.spotify[0];
      if (!entry?.secretsEnc) return;
      const secrets = decryptJson<{ accessToken: string; refreshToken: string; expiresAt: string }>(
        entry.secretsEnc,
        'testschluessel',
      );
      secrets.expiresAt = new Date(Date.now() - 1000).toISOString();
      entry.secretsEnc = encryptJson(secrets, 'testschluessel');
    });

    const playback = await service.playback('hh_1');
    assert.equal(playback?.title, 'Roads');
    assert.notEqual(fake.accessToken, before);
    assert.equal(fake.lastTokenRequest['grant_type'], 'refresh_token');
  });

  it('behält das alte Erneuerungstoken, wenn Spotify keines mitschickt', () => {
    // Spotify schickt beim Erneuern nicht immer ein neues. Es zu
    // überschreiben wäre der sichere Weg in eine Anmeldung, die sich nach
    // einer Stunde selbst beendet.
    const stored = db.read().spotify[0];
    const secrets = decryptJson<{ refreshToken: string }>(
      stored?.secretsEnc as string,
      'testschluessel',
    );
    assert.equal(secrets.refreshToken, 'refresh-1');
  });

  it('erklärt einen 403 als fehlendes Premium', async () => {
    fake.nextStatus = 403;
    await assert.rejects(() => service.execute('hh_1', { type: 'play' }), /nur mit Premium/);
  });

  it('erklärt einen 404 als „nichts läuft gerade"', async () => {
    fake.nextStatus = 404;
    await assert.rejects(
      () => service.execute('hh_1', { type: 'play' }),
      /auf keinem Gerät/,
    );
  });

  it('meldet ein Problem am Konto, statt die Karte leer zu lassen', async () => {
    fake.nextStatus = 500;
    const status = await service.status('hh_1');
    assert.equal(status.playback, null);
    assert.match(status.account?.lastError ?? '', /.+/);
  });

  it('trennt die Verbindung samt Token', async () => {
    await service.disconnect('hh_1');
    assert.deepEqual(db.read().spotify, []);
    const status = await service.status('hh_1');
    assert.equal(status.account, null);
  });

  it('erklärt eine Steuerung ohne Anmeldung', async () => {
    await assert.rejects(
      () => service.execute('hh_1', { type: 'play' }),
      /kein Spotify-Konto verbunden/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Die eingebettete Spotify-Oberfläche
// ---------------------------------------------------------------------------

/**
 * Woraus die Adresse des Einbettungs-Players gebaut wird.
 *
 * Spotifys **voller** Web-Player lässt sich nicht einbetten – das verbietet
 * Spotify per `frame-ancestors`. Der offizielle Einbettungs-Player unter
 * `open.spotify.com/embed/<art>/<kennung>` lässt sich sehr wohl einbetten, und
 * genau diese beiden Angaben braucht er.
 */
describe('Spotify-Kennungen', () => {
  it('zerlegt eine Playlist-Adresse', () => {
    assert.deepEqual(parseSpotifyUri('spotify:playlist:37i9dQZF1DX0XUsuxWHRQd'), {
      type: 'playlist',
      id: '37i9dQZF1DX0XUsuxWHRQd',
    });
  });

  it('kennt Alben, Künstler und Sendungen', () => {
    assert.equal(parseSpotifyUri('spotify:album:1DFixLWuPkv3KT3TnV35m3')?.type, 'album');
    assert.equal(parseSpotifyUri('spotify:artist:0OdUWJ0sBjDrqHygGUXeCF')?.type, 'artist');
    assert.equal(parseSpotifyUri('spotify:show:4rOoJ6Egrf8K2IrywzwOMk')?.type, 'show');
  });

  it('verwirft, was keine Entsprechung im Web hat', () => {
    // Lokale Dateien etwa – für die gibt es keine Seite zum Einbetten.
    assert.equal(parseSpotifyUri('spotify:local:Kuenstler:Album:Titel:230'), null);
    assert.equal(parseSpotifyUri('spotify:user:jemand'), null);
    assert.equal(parseSpotifyUri('kein-uri'), null);
    assert.equal(parseSpotifyUri(null), null);
    assert.equal(parseSpotifyUri(undefined), null);
  });

  it('lässt keine krummen Kennungen durch', () => {
    assert.equal(parseSpotifyUri('spotify:playlist:kurz'), null);
    assert.equal(parseSpotifyUri('spotify:playlist:mit/schraegstrich0000'), null);
  });

  it('reicht Titel und Quelle bis in die Wiedergabe durch', () => {
    const playback = toPlayback({
      is_playing: true,
      context: { uri: 'spotify:playlist:37i9dQZF1DX0XUsuxWHRQd', type: 'playlist' },
      item: { id: '4cOdK2wGLETKBW3PvgPWqT', name: 'Never Gonna Give You Up' },
    });
    assert.equal(playback.trackId, '4cOdK2wGLETKBW3PvgPWqT');
    assert.equal(playback.contextType, 'playlist');
    assert.equal(playback.contextId, '37i9dQZF1DX0XUsuxWHRQd');
  });

  it('kommt ohne Quelle aus – dann bleibt der Titel', () => {
    const playback = toPlayback({
      is_playing: true,
      item: { id: '4cOdK2wGLETKBW3PvgPWqT', name: 'Ein Titel' },
    });
    assert.equal(playback.contextId, null);
    assert.equal(playback.contextType, null);
    assert.equal(playback.trackId, '4cOdK2wGLETKBW3PvgPWqT');
  });
});
