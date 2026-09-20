const { randomUUID } = require('node:crypto');

/**
 * 进程内异步事件总线。
 *
 * - publish 永不阻塞调用方：事件按发布顺序排队，在 microtask 中依次派发。
 * - 单个订阅者抛出的异常被隔离，不影响其它订阅者和事件链。
 * - 可通过注入持久化回调（onEvent）把事件写入 SQLite，便于审计与重放。
 * - 未来可替换为 Redis Stream / RabbitMQ，业务代码只依赖 on/publish 接口。
 */
class EventBus {
  constructor({ onEvent } = {}) {
    this.handlers = new Map();
    this.onEvent = onEvent;
    this.queue = [];
    this.flushing = false;
  }

  on(event, handler) {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.handlers.get(event)?.delete(handler);
  }

  publish(event, payload = {}) {
    const envelope = {
      id: randomUUID(),
      event,
      payload,
      ts: new Date().toISOString(),
    };
    this.queue.push(envelope);
    this._flush();
  }

  async _flush() {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const envelope = this.queue.shift();
        if (this.onEvent) {
          try {
            await this.onEvent(envelope);
          } catch {
            // 持久化失败不影响内存中的事件派发。
          }
        }
        const handlers = [...(this.handlers.get(envelope.event) || [])];
        await Promise.allSettled(
          handlers.map(async (handler) => handler(envelope.payload, envelope)),
        );
      }
    } finally {
      this.flushing = false;
    }
  }
}

module.exports = { EventBus };
