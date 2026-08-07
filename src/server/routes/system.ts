import { Router } from 'express';
import { events } from '../../core/events.js';
import type { Container } from '../../container.js';

const START_TIME = Date.now();
const VERSION = '1.0.0';

export function systemRoutes(container: Container): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptimeSeconds: Math.round((Date.now() - START_TIME) / 1000),
      polling: container.polling.isRunning(),
    });
  });

  router.get('/system/info', (_req, res) => {
    const household = container.households.current();
    res.json({
      name: 'Smart-Home-Hub',
      version: VERSION,
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
  });

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
