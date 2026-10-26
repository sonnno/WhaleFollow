const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-recording-'));
  t.after(function () { fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, journal: require('../server/service/executed-receipt-service').create(dir) };
}
test('failed bookkeeping retains receipts across restart; successful retry removes only recorded entries', function (t, done) {
  const f = fixture(t), receipt = { order: { id: 'one' }, fill: { cash: '5' } }; f.journal.append(receipt);
  f.journal.flush(function (_, cb) { cb(Error('database unavailable')); }, function () { assert.fail('not recorded'); }, function (err) {
    assert.match(err.message, /database/); assert.equal(f.journal.count(), 1);
    const restarted = require('../server/service/executed-receipt-service').create(f.dir); let recorded = 0;
    restarted.flush(function (value, cb) { assert.deepEqual(value, receipt); cb(); }, function (value) { assert.equal(value.order.id, 'one'); recorded++; }, function (error) { assert.ifError(error); assert.equal(recorded, 1); assert.equal(restarted.count(), 0); done(); });
  });
});
test('late appends survive a journal rewrite and previously committed receipts are safe to retry', function (t, done) {
  const f = fixture(t); f.journal.append({ order: { id: 'one' } });
  f.journal.flush(function (_, cb) { f.journal.append({ order: { id: 'two' } }); cb(null, { duplicate: true }); }, function () {}, function (err) {
    assert.ifError(err); assert.equal(f.journal.count(), 1);
    f.journal.flush(function (record, cb) { assert.equal(record.order.id, 'two'); cb(); }, function () {}, function (error) { assert.ifError(error); assert.equal(f.journal.count(), 0); done(); });
  });
});
test('malformed receipt files are preserved and never treated as an empty queue', function (t, done) {
  const f = fixture(t), file = path.join(f.dir, 'unrecorded-fills.jsonl'); fs.writeFileSync(file, '{bad json}\n');
  f.journal.flush(function () { assert.fail('cannot book damaged receipt'); }, function () {}, function (err) { assert.ok(err); assert.equal(fs.readFileSync(file, 'utf8'), '{bad json}\n'); done(); });
});
test('failure callback order cannot reverse dependent executions during bookkeeping', function (t, done) {
  const f = fixture(t), recorded = [];
  const make = (side, sequence) => ({ order: { id: side, side, details: { timings: { executionSession: 'run', executionSequence: sequence, executedAt: '2026-10-15T01:00:00Z' } } } });
  f.journal.append(make('SELL', 2)); f.journal.append(make('BUY', 1));
  f.journal.flush(function (item, cb) { if (item.order.side === 'SELL' && recorded[0] !== 'BUY') return cb(Error('Invalid sale quantity')); recorded.push(item.order.side); cb(); }, function () {}, function (err) { assert.ifError(err); assert.deepEqual(recorded, ['BUY', 'SELL']); assert.equal(f.journal.count(), 0); done(); });
});
