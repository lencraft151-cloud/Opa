import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createLogger } from '../core/logger.js';
import type { Container } from '../container.js';
import { createAuthMiddleware } from './auth.js';
import { errorHandler, notFoundHandler } from './errorHandler.js';
import { automationRoutes } from './routes/automations.js';
import { deviceRoutes } from './routes/devices.js';
import { householdRoutes } from './routes/household.js';
import { integrationRoutes } from './routes/integrations.js';
import { roomRoutes } from './routes/rooms.js';
import { setupRoutes } from './routes/setup.js';
import { systemRoutes } from './routes/system.js';
import { telemetryRoutes } from './routes/telemetry.js';

const log = createLogger('http');

/**
 * `public/` liegt neben `src/` bzw. `dist/` – der relative Pfad stimmt damit
 * sowohl beim Start über tsx als auch aus dem Build.
 */
const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));

export function createApp(container: Container): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

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
  api.use(setupRoutes(container));
  api.use(householdRoutes(container));
  api.use(roomRoutes(container));
  api.use(integrationRoutes(container));
  api.use(deviceRoutes(container));
  api.use(telemetryRoutes(container));
  api.use(automationRoutes(container));
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
