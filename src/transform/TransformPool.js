const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { randomUUID } = require('node:crypto');
const { applyMapping } = require('./mapping');
const logger = require('../utils/logger');

/**
 * CPU 密集型转换放入 worker_threads，避免阻塞事件循环（HTTP I/O 不受影响）。
 * TRANSFORM_WORKERS=0 时退化为主线程纯函数调用，便于调试与测试。
 */
class TransformPool {
  constructor(size = 1) {
    this.size = size;
    this.workers = [];
    this.queue = [];
    this.pending = new Map();
    this.nextWorker = 0;

    if (size > 0) {
      for (let i = 0; i < size; i += 1) {
        const worker = new Worker(path.join(__dirname, 'transform.worker.js'));
        worker.on('message', (message) => {
          const { resolve, reject } = this.pending.get(message.id) || {};
          this.pending.delete(message.id);
          if (message.ok) resolve?.(message.data);
          else reject?.(Object.assign(new Error(message.error?.message || 'transform failed'), { stack: message.error?.stack }));
          this._drain();
        });
        worker.on('error', (error) => logger.error('transform worker error', error));
        this.workers.push(worker);
      }
    }
  }

  transform(data, mapping) {
    if (this.size === 0) {
      return Promise.resolve().then(() => applyMapping(data, mapping));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ id: randomUUID(), data: structuredClone(data), mapping, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    while (this.queue.length > 0 && this.pending.size < this.size * 2) {
      const task = this.queue.shift();
      const worker = this.workers[this.nextWorker];
      this.nextWorker = (this.nextWorker + 1) % this.workers.length;
      this.pending.set(task.id, task);
      worker.postMessage({ id: task.id, data: task.data, mapping: task.mapping });
    }
  }

  async destroy() {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
    this.workers = [];
  }
}

module.exports = { TransformPool };
