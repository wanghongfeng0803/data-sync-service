const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('../config');
const logger = require('../utils/logger');

let db;

function openDatabase(dbPath = config.db.path) {
  if (db) return db;

  const persistent = dbPath !== ':memory:';
  if (persistent) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  if (persistent) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('busy_timeout = 5000');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  logger.info('database initialized', { path: persistent ? dbPath : ':memory:' });
  return db;
}

function getDatabase() {
  if (!db) throw new Error('database has not been initialized');
  return db;
}

function closeDatabase() {
  if (db) {
    db.close();
    db = undefined;
  }
}

module.exports = { openDatabase, getDatabase, closeDatabase };
