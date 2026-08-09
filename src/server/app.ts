import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createLogger } from '../core/logger.js';
import type { Container } from '../container.js';
import { createAuthMiddleware } from './auth.js';
import { errorHandler, notFoundHandler } from './errorHandler.js';
import { authRoutes } from './routes/auth.js';
import { automationRoutes } from './routes/automations.js';
import { deviceRoutes } from './routes/devices.js';
import { energyRoutes } from './routes/energy.js';
import { householdRoutes } from './routes/household.js';
import { integrationRoutes } from './routes/integrations.js';
import { musicRoutes } from './routes/music.js';
import { nextcloudRoutes } from './routes/nextcloud.js';
import { roomRoutes } from './routes/rooms.js';
import { sceneRoutes } from './routes/scenes.js';
import { setupRoutes } from './routes/setup.js';
import { systemRoutes } from './routes/system.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { updateRoutes } from './routes/updates.js';

const log = createLogger('http');

/**
 * `public/` liegt neben `src/` bzw. `dist/` – der relative Pfad stimmt damit
 * sowohl beim Start über tsx als auch aus dem Build.
 */
const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));

export function createApp(container: Container): express.Express {
  const app = express();

  app.disable('x-powered-by');

  /*
   * Zwei Größenbeschränkungen statt einer.
   *
   * Für alles Normale reichen 256 kB mit weitem Abstand; eine großzügigere
   * Grenze wäre nur eine Einladung, den Hub mit einer einzigen Anfrage
   * lahmzulegen. Eine zurückgespielte Sicherung ist die eine Ausnahme: Ein
   * Haushalt mit ein paar hundert Geräten und deren Zuständen kommt schnell
   * über ein Megabyte.
   */
  const RESTORE_PATH = '/api/system/restore';
  const normalBody = express.json({ limit: '256kb' });
  const restoreBody = express.json({ limit: '16mb' });
  app.use((req, res, next) => {
    if (req.path === RESTORE_PATH) return restoreBody(req, res, next);
    return normalBody(req, res, next);
  });

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      // Der Eventstream läuft dauerhaft – das würde das Log zumüllen.
      if (req.path === '/api/events') return;
      log.debug(`${req.method} ${req.originalUrl}`, {
        status: res.statusCode,
        ms: Date.now() - startedAt,
      });
    });
    next();
  });

  const api = express.Router();
  api.use(createAuthMiddleware(container));
  api.use(systemRoutes(container));
  api.use(authRoutes(container));
  api.use(setupRoutes(container));
  api.use(householdRoutes(container));
  api.use(roomRoutes(container));
  api.use(integrationRoutes(container));
  api.use(deviceRoutes(container));
  api.use(telemetryRoutes(container));
  api.use(automationRoutes(container));
  api.use(energyRoutes(container));
  api.use(updateRoutes(container));
  api.use(sceneRoutes(container));
  api.use(nextcloudRoutes(container));
  api.use(musicRoutes(container));
  app.use('/api', api);

  app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: '1h' }));

  // Alles, was keine API-Route ist, bekommt die Oberfläche.
  app.get(/^(?!\/api).*/, (_req, res, next) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
      if (err) next();
    });
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
