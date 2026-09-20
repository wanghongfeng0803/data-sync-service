const { parentPort } = require('node:worker_threads');
const { applyMapping } = require('./mapping');

parentPort.on('message', (task) => {
  try {
    parentPort.postMessage({ id: task.id, ok: true, data: applyMapping(task.data, task.mapping) });
  } catch (error) {
    parentPort.postMessage({ id: task.id, ok: false, error: { message: error.message, stack: error.stack } });
  }
});
