const test = require('node:test');
const assert = require('node:assert/strict');
const { runTransaction } = require('../server/db/adapter');
const { EventEmitter } = require('node:events');

test('losing the lease connection stops its owner exactly once', function () {
  const watchLease = require('../server/db/adapter').watchLease;
  const client = new EventEmitter();
  let calls = 0;
  const disarm = watchLease(client, function () { calls++; });
  client.emit('error', new Error('connection lost'));
  client.emit('end');
  assert.equal(calls, 1);
  disarm();
});

test('callback failure rolls back and releases the same query runner', function (_, done) {
  const events = [];
  const runner = { manager: {}, connect: function () { events.push('connect'); return Promise.resolve(); }, startTransaction: function () { events.push('begin'); return Promise.resolve(); }, commitTransaction: function () { events.push('commit'); return Promise.resolve(); }, rollbackTransaction: function () { events.push('rollback'); return Promise.resolve(); }, release: function () { events.push('release'); return Promise.resolve(); } };
  runTransaction(runner, function (tx, callback) { callback(new Error('business failure')); }, function (err) {
    assert.equal(err.message, 'business failure');
    assert.deepEqual(events, ['connect', 'begin', 'rollback', 'release']);
    done();
  });
});
test('successful callback transaction with no result commits and releases', function (_, done) {
  const events = [];
  const runner = { manager: {}, connect: function () { events.push('connect'); return Promise.resolve(); }, startTransaction: function () { events.push('begin'); return Promise.resolve(); }, commitTransaction: function () { events.push('commit'); return Promise.resolve(); }, rollbackTransaction: function () { events.push('rollback'); return Promise.resolve(); }, release: function () { events.push('release'); return Promise.resolve(); } };
  runTransaction(runner, function (_, callback) { callback(null); }, function (err, result) { assert.ifError(err); assert.equal(result, undefined); assert.deepEqual(events, ['connect', 'begin', 'commit', 'release']); done(); });
});
