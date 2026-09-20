const http = require('node:http');
const config = require('./src/config');
const logger = require('./src/utils/logger');
const { buildContainer } = require('./src/container');

async function bootstrap() {
  const container = buildContainer();
  container.engine.start();

  const server = http.createServer(container.app);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, resolve);
  });

  logger.info(`data-sync-service listening on :${config.port}`, {
    env: config.nodeEnv,
    db: config.db.path,
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.warn(`received ${signal}, shutting down`);
    server.close(async () => {
      await container.shutdown(signal);
      logger.info('shutdown complete');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('forced exit after graceful timeout');
      process.exit(1);
    }, 15000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { server, container };
}

if (require.main === module) {
  bootstrap().catch((error) => {
    logger.error('fatal bootstrap error', error);
    process.exit(1);
  });
}

module.exports = { bootstrap };
