const config = require('./config');
const { openDatabase, closeDatabase } = require('./db');
const { EventBus } = require('./eventbus/EventBus');
const { createEventRepository } = require('./repositories/eventRepository');
const { createAuditRepository } = require('./repositories/auditRepository');
const { createJobRepository } = require('./repositories/jobRepository');
const { createItemRepository } = require('./repositories/itemRepository');
const { TransformPool } = require('./transform/TransformPool');
const { SyncEngine } = require('./sync/SyncEngine');
const { createApp } = require('./api/app');

function buildContainer({ dbPath = config.db.path, engineOptions = {} } = {}) {
  const database = openDatabase(dbPath);
  const eventRepository = createEventRepository(database);
  const auditRepository = createAuditRepository(database);
  const jobRepository = createJobRepository(database);
  const itemRepository = createItemRepository(database);

  const eventBus = new EventBus({
    onEvent: (envelope) => eventRepository.record(envelope),
  });

  const transformPool = new TransformPool(config.transform.workers);
  const engine = new SyncEngine({
    eventBus,
    jobRepository,
    itemRepository,
    transformPool,
    options: engineOptions,
  });

  const app = createApp({
    eventBus,
    jobRepository,
    itemRepository,
    eventRepository,
    auditRepository,
    engine,
    transformPool,
  });

  async function shutdown(signal) {
    engine.stop();
    await transformPool.destroy();
    closeDatabase();
    return signal;
  }

  return {
    app,
    engine,
    eventBus,
    transformPool,
    jobRepository,
    itemRepository,
    eventRepository,
    auditRepository,
    database,
    shutdown,
  };
}

module.exports = { buildContainer };
