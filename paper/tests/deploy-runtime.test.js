const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('first Compose boot generates private persistent credentials and matching PostgreSQL secret', function (t) {
  const runtime = require('../deploy/runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefollow-runtime-'));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  const first = runtime.bootstrap(dir, {}), second = runtime.bootstrap(dir, {});
  assert.deepEqual(second, first);
  assert.equal(first.adminUsername, 'admin');
  assert.ok(first.adminPassword.length >= 20);
  assert.ok(first.sessionSecret.length >= 64);
  assert.notEqual(first.adminPassword, first.postgresPassword);
  assert.equal(fs.readFileSync(path.join(dir, 'postgres-password'), 'utf8').trim(), first.postgresPassword);
  assert.equal(runtime.load(dir, {}).ADMIN_PASSWORD, first.adminPassword);
});

test('configuration overrides persist once and mismatched credentials fail instead of locking out database', function (t) {
  const runtime = require('../deploy/runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefollow-runtime-'));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  const first = runtime.bootstrap(dir, { ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'chosen-local-pass', SESSION_SECRET: 's'.repeat(64), POSTGRES_PASSWORD: 'db-local-pass' });
  assert.equal(first.adminUsername, 'owner');
  assert.equal(first.adminPassword, 'chosen-local-pass');
  assert.deepEqual(runtime.bootstrap(dir, {}), first);
  assert.throws(function () { runtime.bootstrap(dir, { POSTGRES_PASSWORD: 'changed-pass' }); }, /已生成|already|mismatch/i);
  assert.throws(function () { runtime.bootstrap(dir, { SESSION_SECRET: 'short' }); }, /SESSION_SECRET/);
  const target = { ADMIN_PASSWORD: 'other' };
  runtime.load(dir, target);
  assert.equal(target.ADMIN_PASSWORD, 'chosen-local-pass');
});

test('custom password spaces survive repeated bootstrap without trimming', function (t) {
  const runtime = require('../deploy/runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefollow-runtime-'));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  const first = runtime.bootstrap(dir, { POSTGRES_PASSWORD: ' spaced-password ' });
  assert.deepEqual(runtime.bootstrap(dir, {}), first);
});

test('runtime refuses missing or damaged state and never silently replaces a database password', function (t) {
  const runtime = require('../deploy/runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whalefollow-runtime-'));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(function () { runtime.load(dir, {}); }, /ENOENT|missing/);
  runtime.bootstrap(dir, {});
  fs.writeFileSync(path.join(dir, 'postgres-password'), 'wrong-password');
  assert.throws(function () { runtime.bootstrap(dir, {}); }, /password|密码/i);
});

test('Docker network binding is opt-in and initial virtual capital is validated', function () {
  const { listenOptions } = require('../server/lib/listen-options');
  assert.deepEqual(listenOptions({}), { host: '127.0.0.1', port: 3000 });
  assert.deepEqual(listenOptions({ HOST: '0.0.0.0', PORT: '3000' }), { host: '0.0.0.0', port: 3000 });
  assert.throws(function () { listenOptions({ PORT: 'not-a-port' }); }, /PORT/);
  const { execFileSync } = require('node:child_process');
  const script = "process.stdout.write(require('./config').paper.initialCash)";
  assert.equal(execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, INITIAL_CASH: '350' }, encoding: 'utf8' }), '350');
  assert.throws(function () { execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, INITIAL_CASH: '-1' }, stdio: 'pipe' }); });
  ['Infinity', '0', '100000000000000000000', '0.0000000000000000001'].forEach(function (INITIAL_CASH) { assert.throws(function () { execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..'), env: { ...process.env, INITIAL_CASH }, stdio: 'pipe' }); }); });
});
