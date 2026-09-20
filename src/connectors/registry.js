const mockSource = require('./mockSource');
const mockTarget = require('./mockTarget');
const httpConnector = require('./httpConnector');

const sources = new Map();
const targets = new Map();

function registerSource(connector) {
  if (!connector?.type || typeof connector.fetch !== 'function') {
    throw new Error('source connector requires "type" and fetch()');
  }
  sources.set(connector.type, connector);
}

function registerTarget(connector) {
  if (!connector?.type || typeof connector.push !== 'function') {
    throw new Error('target connector requires "type" and push()');
  }
  targets.set(connector.type, connector);
}

function getSource(type) {
  const source = sources.get(type);
  if (!source) throw new Error(`unknown source connector: ${type}`);
  return source;
}

function getTarget(type) {
  const target = targets.get(type);
  if (!target) throw new Error(`unknown target connector: ${type}`);
  return target;
}

registerSource(mockSource);
registerTarget(mockTarget);
registerSource(httpConnector);
registerTarget(httpConnector);

module.exports = {
  registerSource,
  registerTarget,
  getSource,
  getTarget,
};
