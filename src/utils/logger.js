const config = require('../config');

const levels = { debug: 10, info: 20, warn: 30, error: 40 };
const current = levels[config.logLevel] || levels.info;

function serializeErrors(_key, value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function write(level, message, meta) {
  if (levels[level] < current) return;
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(meta && typeof meta === 'object' ? meta : {}),
  };
  const line = JSON.stringify(payload, serializeErrors);
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

module.exports = {
  debug: (message, meta) => write('debug', message, meta),
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};
