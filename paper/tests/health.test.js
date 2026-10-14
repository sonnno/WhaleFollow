const test = require('node:test');
const assert = require('node:assert/strict');
const create = require('../server/service/health-service').create;

test('successful inventory recovery clears the active error and retains recovery evidence', function () {
  const health = {}, report = create(health);
  report('inventory', new Error('TLS connection interrupted'));
  const failedAt = health.lastError.at;
  report('inventory', null, { checked: 10 });
  assert.equal(health.lastError, null);
  assert.equal(health.lastIncident.at, failedAt);
  assert.ok(health.lastIncident.recoveredAt);
  assert.equal(health.tasks.inventory.status, 'ok');
});

test('another task succeeding does not hide an unresolved inventory failure', function () {
  const health = {}, report = create(health);
  report('inventory', new Error('TLS connection interrupted'));
  report('trades', null, { checked: 10 });
  assert.equal(health.lastError.task, 'inventory');
  assert.equal(health.tasks?.inventory?.status, 'error');
});

test('a skipped polling round cannot claim that a failed task recovered', function () {
  const health = {}, report = create(health);
  report('inventory', new Error('TLS connection interrupted'));
  report('inventory', null, { checked: 0 });
  assert.equal(health.lastError.task, 'inventory');
  assert.equal(health.tasks?.inventory?.status, 'error');
});


test('backoff waiting keeps the connection failure instead of recording a new incident each tick', function () {
  const health = {}, report = create(health);
  report('trades', new Error('TLS connection interrupted'));
  const incident = health.lastIncident;
  report('trades', Object.assign(new Error('Polymarket backoff active'), { code: 'POLYMARKET_BACKOFF', retryAfterMs: 5000 }));
  assert.equal(health.lastIncident, incident);
  assert.equal(health.lastError.message, 'TLS connection interrupted');
  assert.equal(health.tasks.trades.status, 'retrying');
  assert.ok(new Date(health.tasks.trades.retryAt).getTime() > Date.now());
  report('trades', null, { checked: 1 });
  assert.equal(health.lastError, null); assert.equal(health.tasks.trades.retryAt, null);
});
