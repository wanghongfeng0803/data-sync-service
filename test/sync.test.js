process.env.NODE_ENV = 'test';
process.env.DB_PATH = ':memory:';
process.env.PORT = '0';
process.env.SYNC_BACKOFF_BASE_MS = '10';
process.env.SYNC_BACKOFF_FACTOR = '2';
process.env.SYNC_BACKOFF_MAX_MS = '200';
process.env.SYNC_SCAN_INTERVAL_MS = '50';
process.env.TRANSFORM_WORKERS = '1';
process.env.LOG_LEVEL = 'error';

const test = require('node:test');
const assert = require('node:assert/strict');
const { bootstrap } = require('../server');
const { registerTarget } = require('../src/connectors/registry');

let baseUrl;
let engine;
let server;
let shutdownContainer;

test.before(async () => {
  const started = await bootstrap();
  server = started.server;
  engine = started.container.engine;
  shutdownContainer = started.container.shutdown;
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await engine.waitUntilIdle(15000).catch(() => {});
  engine.stop();
  await new Promise((resolve) => server.close(resolve));
  await shutdownContainer('test');
});

async function api(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const json = await response.json();
  return { status: response.status, body: json };
}

async function createJob(body) {
  const { status, body: json } = await api('/api/v1/jobs', { method: 'POST', body });
  assert.equal(status, 202, JSON.stringify(json));
  return json.job;
}

async function waitForJob(jobId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await api(`/api/v1/jobs/${jobId}`);
    if (['completed', 'failed', 'cancelled'].includes(body.job.status)) return body.job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${jobId} did not finish in time`);
}

test('happy path: mock -> mock syncs every item and emits events', async () => {
  const job = await createJob({
    source: { type: 'mock', config: { count: 8 } },
    target: { type: 'mock' },
    max_attempts: 2,
  });

  const finished = await waitForJob(job.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.total, 8);
  assert.equal(finished.succeeded, 8);
  assert.equal(finished.failed, 0);

  const { body } = await api(`/api/v1/jobs/${job.id}/items`);
  assert.equal(body.items.length, 8);
  assert.ok(body.items.every((item) => item.status === 'succeeded'));

  const events = await api(`/api/v1/events?event=job.completed`);
  assert.ok(events.body.items.some((event) => event.payload.jobId === job.id));
});

test('failure compensation: transient errors retry with backoff and succeed', async () => {
  const job = await createJob({
    source: { type: 'mock', config: { count: 3, keyPrefix: 'flaky' } },
    target: { type: 'mock', config: { failAttempts: 2 } },
    max_attempts: 5,
  });

  const finished = await waitForJob(job.id);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.succeeded, 3);

  const { body } = await api(`/api/v1/jobs/${job.id}/items`);
  assert.ok(body.items.every((item) => item.attempts >= 3));
});

test('dead letter: permanent failure fails the job and records the item', async () => {
  const job = await createJob({
    source: { type: 'mock', config: { count: 4, keyPrefix: 'poison' } },
    target: { type: 'mock', config: { failKeys: ['poison-2'] } },
    max_attempts: 2,
  });

  const finished = await waitForJob(job.id);
  assert.equal(finished.status, 'failed');
  assert.equal(finished.succeeded, 3);
  assert.equal(finished.dead_lettered, 1);

  const { body } = await api(`/api/v1/jobs/${job.id}/items`);
  const dead = body.items.find((item) => item.item_key === 'poison-2');
  assert.equal(dead.status, 'dead_lettered');
  assert.match(dead.last_error, /permanent failure/);

  const events = await api('/api/v1/events?event=item.dead_lettered');
  assert.ok(events.body.items.some((event) => event.payload.itemId === dead.id));
});

test('manual retry reopens dead-lettered items and resets attempts', async () => {
  const job = await createJob({
    source: { type: 'mock', config: { count: 2, keyPrefix: 'retryme' } },
    target: { type: 'mock', config: { failKeys: ['retryme-1'] } },
    max_attempts: 1,
  });

  const failed = await waitForJob(job.id);
  assert.equal(failed.status, 'failed');

  const retry = await api(`/api/v1/jobs/${job.id}/retry`, {
    method: 'POST',
    body: { max_attempts: 1 },
  });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.job.status, 'pending');

  const secondRun = await waitForJob(job.id);
  assert.equal(secondRun.status, 'failed');
  assert.equal(secondRun.dead_lettered, 1);

  const { body } = await api(`/api/v1/jobs/${job.id}/items`);
  const stillBad = body.items.find((item) => item.item_key === 'retryme-1');
  assert.equal(stillBad.attempts, 1);

  const audit = await api(`/api/v1/audit?action=job.retried&job_id=${job.id}`);
  assert.equal(audit.body.items.length, 1);
});

test('source fetch failure marks the job failed', async () => {
  const job = await createJob({
    source: { type: 'mock', config: { failFetch: true } },
    target: { type: 'mock' },
  });

  const finished = await waitForJob(job.id);
  assert.equal(finished.status, 'failed');
  assert.match(finished.error, /source fetch failed/);
});

test('worker-thread transform applies the mapping before target push', async () => {
  const received = [];
  registerTarget({
    type: 'collector',
    async push(record) {
      received.push(record);
      return { ok: true };
    },
  });

  const job = await createJob({
    source: { type: 'mock', config: { count: 2, keyPrefix: 'mapped' } },
    target: { type: 'collector' },
    mapping: {
      keepUnmapped: false,
      fields: { identifier: 'id', title: 'name' },
      defaults: { source: 'mock' },
    },
  });

  const finished = await waitForJob(job.id);
  assert.equal(finished.status, 'completed');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(received.length, 2);
  assert.deepEqual(received[0].data, {
    identifier: 1,
    title: 'mapped 1',
    source: 'mock',
  });
});

test('health and validation endpoints behave', async () => {
  const health = await api('/api/v1/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');

  const bad = await api('/api/v1/jobs', { method: 'POST', body: { source: { type: 'mock' } } });
  assert.equal(bad.status, 400);

  const missing = await api('/api/v1/jobs/nope');
  assert.equal(missing.status, 404);
});
