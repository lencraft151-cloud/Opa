import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { events } from '../../core/events.js';
import type { Container } from '../../container.js';
import { VERSION } from '../../version.js';
import { assetVersion } from '../assetVersion.js';
import { requireAdminUnlessOpen } from '../auth.js';
import { asyncHandler } from '../http.js';

const START_TIME = Date.now();

/** `public/` liegt neben `src/` bzw. `dist/` – siehe `server/app.ts`. */
const PUBLIC_DIR = fileURLToPath(new URL('../../../public', import.meta.url));

export function systemRoutes(container: Container): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - START_TIME) / 1000),
      polling: container.polling.isRunning(),
    });
  });

  router.get(
    '/system/info',
    asyncHandler(async (_req, res) => {
      const household = container.households.current();
      res.json({
        name: 'Smart-Home-Hub',
        version: VERSION,
        /*
         * Kennung der ausgelieferten Oberfläche. Sie ändert sich mit jeder
         * geänderten Datei unter `public/`; die Weboberfläche erkennt daran,
         * dass eine neue Fassung bereitsteht, und lädt sich selbst neu.
         */
        build: await assetVersion(PUBLIC_DIR),
        node: process.version,
        hasHousehold: household !== undefined,
        setupCompleted: household?.setupCompletedAt !== null && household !== undefined,
        authRequired: !container.config.authDisabled,
        adapters: container.registry.list().map((adapter) => ({
          type: adapter.type,
          displayName: adapter.displayName,
          supportsPush: typeof adapter.subscribe === 'function',
        })),
        settings: {
          pollIntervalSeconds: container.config.pollIntervalSeconds,
          telemetryRetentionDays: container.config.telemetryRetentionDays,
          cloudDiscovery: container.config.allowCloudDiscovery,
        },
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Die Software des Hubs selbst
  // -------------------------------------------------------------------------

  /**
   * Welche Fassung läuft, was ist neu, liegt etwas Neueres bereit?
   *
   * Bewusst getrennt von `/updates`: dort geht es um die Firmware der Geräte,
   * hier um das Programm, das sie steuert.
   */
  router.get(
    '/system/version',
    asyncHandler(async (_req, res) => {
      res.json(await container.hubUpdate.info());
    }),
  );

  /** Das vollständige Änderungsprotokoll – alle Fassungen, neueste zuerst. */
  router.get(
    '/system/changelog',
    asyncHandler(async (_req, res) => {
      res.json({ entries: await container.hubUpdate.changelog() });
    }),
  );

  /** Fragt nach, ob es eine neuere Fassung gibt. */
  router.post(
    '/system/version/check',
    asyncHandler(async (req, res) => {
      requireAdminUnlessOpen(req, container.config.authDisabled);
      res.json(await container.hubUpdate.check());
    }),
  );

  /**
   * Installiert die neuere Fassung. Der Neustart des Dienstes bleibt Sache
   * des Betriebssystems – die Antwort sagt das auch.
   */
  router.post(
    '/system/version/install',
    asyncHandler(async (req, res) => {
      requireAdminUnlessOpen(req, container.config.authDisabled);
      const result = await container.hubUpdate.install(container.households.current()?.id ?? '');
      res.status(202).json({
        ...result,
        message:
          'Die neue Fassung liegt bereit. Sie läuft, sobald der Dienst neu gestartet wurde.',
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Sicherung und Wiederherstellung
  // -------------------------------------------------------------------------

  /**
   * Lädt die Konfiguration als Datei herunter.
   *
   * Ohne Zugangsdaten – siehe `backupService.ts`. Der Dateiname trägt das
   * Datum, damit sich mehrere Sicherungen im Download-Ordner nicht gegenseitig
   * überschreiben.
   */
  router.get('/system/backup', (req, res) => {
    requireAdminUnlessOpen(req, container.config.authDisabled);
    const household = container.households.require();
    const backup = container.backup.export(household.id);
    const stamp = backup.createdAt.slice(0, 10);

    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader(
      'content-disposition',
      `attachment; filename="smarthome-sicherung-${stamp}.json"`,
    );
    res.send(JSON.stringify(backup, null, 2));
  });

  /**
   * Spielt eine Sicherung zurück.
   *
   * Danach laufen die Hintergrunddienste auf einem anderen Datenstand –
   * Polling und Automationen werden deshalb neu aufgesetzt.
   */
  router.post(
    '/system/restore',
    asyncHandler(async (req, res) => {
      requireAdminUnlessOpen(req, container.config.authDisabled);
      const result = await container.backup.restore(req.body);
      await container.startBackgroundServices();
      res.json(result);
    }),
  );

  /**
   * Live-Updates per Server-Sent Events. Die UI hält damit Gerätezustände
   * aktuell, ohne zu pollen.
   */
  router.get('/events', (req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

    const unsubscribe = events.onAny(({ name, payload }) => {
      res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    });

    // Kommentar-Zeilen halten Proxys davon ab, die Verbindung zu kappen.
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20_000);
    keepAlive.unref?.();

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    });
  });

  return router;
}
