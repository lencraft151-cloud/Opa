import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container.js';
import { asyncHandler, parseBody } from '../http.js';

const mediaCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('play') }),
  z.object({ type: z.literal('pause') }),
  z.object({ type: z.literal('next') }),
  z.object({ type: z.literal('previous') }),
  z.object({ type: z.literal('setVolume'), volume: z.number().min(0).max(100) }),
  z.object({ type: z.literal('setMute'), muted: z.boolean() }),
]);

/**
 * Musik: Sonos im eigenen Netz und Spotify in der Wolke.
 *
 * Zusammen in einer Datei, weil sie in der Oberfläche zusammen auftreten –
 * und weil die halbe Steuerung dieselbe ist: Play, Pause, weiter, lauter.
 */
export function musicRoutes(container: Container): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Sonos
  // -------------------------------------------------------------------------

  router.get(
    '/sonos',
    asyncHandler(async (_req, res) => {
      const household = container.households.require();
      res.json(await container.sonos.overview(household.id));
    }),
  );

  /** Sucht Lautsprecher im Netz. Dauert ein paar Sekunden. */
  router.post(
    '/sonos/discover',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const { scan, host } = parseBody(
        z.object({ scan: z.boolean().optional(), host: z.string().min(1).max(120).optional() }),
        req,
      );
      const players = await container.sonos.discover(household.id, {
        scan,
        ...(host ? { hosts: [host] } : {}),
      });
      res.json({ players, found: players.length });
    }),
  );

  router.post(
    '/sonos/:id/command',
    asyncHandler(async (req, res) => {
      const command = parseBody(mediaCommandSchema, req);
      res.json(await container.sonos.execute(req.params.id as string, command));
    }),
  );

  /** Ordnet den Lautsprecher einem Raum des Hubs zu (`null` löst die Zuordnung). */
  router.patch(
    '/sonos/:id',
    asyncHandler(async (req, res) => {
      const { roomId } = parseBody(z.object({ roomId: z.string().nullable() }), req);
      res.json(await container.sonos.rename(req.params.id as string, roomId));
    }),
  );

  router.delete(
    '/sonos/:id',
    asyncHandler(async (req, res) => {
      await container.sonos.remove(req.params.id as string);
      res.status(204).end();
    }),
  );

  // -------------------------------------------------------------------------
  // Spotify
  // -------------------------------------------------------------------------

  router.get(
    '/spotify',
    asyncHandler(async (_req, res) => {
      const household = container.households.require();
      res.json(await container.spotify.status(household.id));
    }),
  );

  /**
   * Beginnt die Anmeldung. Antwortet mit der Adresse, die der Nutzer im
   * Browser aufrufen muss – der Hub kann das nicht für ihn tun, er hat kein
   * Spotify-Passwort und soll auch keines bekommen.
   */
  router.post(
    '/spotify/authorize',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const input = parseBody(
        z.object({
          clientId: z.string().min(1).max(200),
          redirectUri: z.string().min(1).max(300),
        }),
        req,
      );
      res.json(await container.spotify.begin(household.id, input));
    }),
  );

  /**
   * Hier kommt der Browser nach der Zustimmung wieder heraus.
   *
   * Die Antwort ist eine Seite und keine JSON-Struktur: An dieser Stelle
   * sitzt ein Mensch vor dem Bildschirm, kein Programm.
   */
  router.get(
    '/spotify/callback',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const code = String(req.query['code'] ?? '');
      const state = String(req.query['state'] ?? '');
      const error = String(req.query['error'] ?? '');

      if (error) {
        res.status(400).type('html').send(resultPage(false, `Spotify meldet: ${error}`));
        return;
      }
      if (!code || !state) {
        res.status(400).type('html').send(resultPage(false, 'Die Rückmeldung war unvollständig.'));
        return;
      }

      try {
        const account = await container.spotify.complete(household.id, { code, state });
        res
          .type('html')
          .send(resultPage(true, `Angemeldet als ${account.displayName ?? account.clientId}.`));
      } catch (err) {
        res
          .status(400)
          .type('html')
          .send(resultPage(false, err instanceof Error ? err.message : 'Unbekannter Fehler'));
      }
    }),
  );

  router.post(
    '/spotify/command',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const command = parseBody(mediaCommandSchema, req);
      res.json({ playback: await container.spotify.execute(household.id, command) });
    }),
  );

  /** Wiedergabe auf ein anderes Gerät umziehen. */
  router.post(
    '/spotify/transfer',
    asyncHandler(async (req, res) => {
      const household = container.households.require();
      const { deviceId, play } = parseBody(
        z.object({ deviceId: z.string().min(1), play: z.boolean().optional() }),
        req,
      );
      await container.spotify.transfer(household.id, deviceId, play ?? true);
      res.json({ playback: await container.spotify.playback(household.id) });
    }),
  );

  router.delete(
    '/spotify',
    asyncHandler(async (_req, res) => {
      const household = container.households.require();
      await container.spotify.disconnect(household.id);
      res.status(204).end();
    }),
  );

  return router;
}

/**
 * Die Seite, auf der der Nutzer nach dem Umweg über Spotify landet.
 *
 * Bewusst ohne Stylesheet und ohne Skript: Sie wird einmal im Leben
 * angesehen, oft in einem Browser-Tab, der gleich wieder zugeht. Was sie
 * leisten muss, ist eine klare Aussage und ein Weg zurück.
 */
function resultPage(ok: boolean, message: string): string {
  const title = ok ? 'Spotify ist verbunden' : 'Das hat nicht geklappt';
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.2rem;line-height:1.6">
  <h1 style="font-size:1.4rem">${ok ? '✓' : '✗'} ${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
  <p><a href="/">Zurück zum Hub</a></p>
</body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
