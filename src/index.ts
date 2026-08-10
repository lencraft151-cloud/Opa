import { loadConfig, loadDotEnv } from './config.js';
import { createContainer } from './container.js';
import { createLogger, setLogLevel } from './core/logger.js';
import { errorMessage } from './core/errors.js';
import { createApp } from './server/app.js';

const log = createLogger('main');

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  setLogLevel(config.logLevel);

  /*
   * Wo die Daten liegen, gehört in die erste Zeile des Protokolls – es ist
   * die eine Auskunft, die man braucht, um zu sichern, umzuziehen oder zu
   * verstehen, warum der Assistent wieder von vorn anfängt.
   */
  log.info('Datenordner', {
    pfad: config.dataDir,
    schlüssel:
      config.secretKeySource === 'created'
        ? 'neu angelegt (secret.key)'
        : config.secretKeySource === 'file'
          ? 'aus secret.key'
          : 'aus der Umgebung',
  });
  if (config.dataDirNote) log.warn(config.dataDirNote);

  const container = await createContainer(config);
  const app = createApp(container);

  const server = app.listen(config.port, config.host, () => {
    const household = container.households.current();
    log.info('Smart-Home-Hub gestartet', {
      url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
      dataDir: config.dataDir,
    });
    if (!household) {
      log.info('Noch kein Haushalt vorhanden – Einrichtung im Browser starten');
    } else {
      log.info('Haushalt geladen', {
        name: household.name,
        setup: household.setupCompletedAt ? 'abgeschlossen' : household.setupStep,
      });
    }
  });

  await container.startBackgroundServices();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Signal ${signal} empfangen – fahre herunter`);

    // Neue Verbindungen ablehnen, laufende beenden lassen.
    server.close();
    const force = setTimeout(() => {
      log.warn('Erzwungenes Beenden nach Zeitüberschreitung');
      process.exit(1);
    }, 10_000);
    force.unref();

    try {
      await container.shutdown();
      clearTimeout(force);
      process.exit(0);
    } catch (err) {
      log.error('Fehler beim Herunterfahren', { error: errorMessage(err) });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    log.error('Unbehandelte Promise-Ablehnung', { error: errorMessage(reason) });
  });
  process.on('uncaughtException', (err) => {
    log.error('Unbehandelte Ausnahme', { error: err.message, stack: err.stack });
  });
}

main().catch((err) => {
  // Konfigurationsfehler sollen ohne Stacktrace lesbar sein.
  process.stderr.write(`\nStart fehlgeschlagen: ${errorMessage(err)}\n\n`);
  process.exit(1);
});
