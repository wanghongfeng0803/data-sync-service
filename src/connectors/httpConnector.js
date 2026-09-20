const config = require('../config');

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function withTimeout(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timeout')), timeoutMs);
  signal?.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

function getByPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, segment) => (acc == null ? undefined : acc[segment]), obj);
}

async function requestJson(method, url, options = {}, timeoutMs = config.connector.httpTimeoutMs) {
  const timeout = withTimeout(options.signal, timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: timeout.signal,
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status} ${response.statusText}`), {
        status: response.status,
        retryable: TRANSIENT_STATUS.has(response.status),
        body,
      });
    }
    return body;
  } finally {
    timeout.done();
  }
}

/**
 * HTTP JSON 数据源。
 * config: { url, method?, headers?, dataPath?, timeoutMs? }
 * 返回体应为 [{ key, data }]，可用 dataPath 指向数组所在字段（点路径）。
 */
async function fetch(connectorConfig = {}) {
  if (!connectorConfig.url) throw new Error('http source requires config.url');
  const body = await requestJson(
    connectorConfig.method || 'GET',
    connectorConfig.url,
    { headers: connectorConfig.headers },
    connectorConfig.timeoutMs,
  );
  const records = getByPath(body, connectorConfig.dataPath);
  if (!Array.isArray(records)) {
    throw new Error(`http source response at "${connectorConfig.dataPath || '$'}" is not an array`);
  }
  return records.map((record) => ({
    key: String(record.key ?? record.data?.id ?? record.id),
    data: record.data ?? record,
  }));
}

/**
 * HTTP JSON 目标。
 * config: { url, method?, headers?, timeoutMs? }
 */
async function push(record, connectorConfig = {}) {
  if (!connectorConfig.url) throw new Error('http target requires config.url');
  return requestJson(
    connectorConfig.method || 'POST',
    connectorConfig.url,
    {
      headers: connectorConfig.headers,
      body: record,
    },
    connectorConfig.timeoutMs,
  );
}

module.exports = { type: 'http', fetch, push };
