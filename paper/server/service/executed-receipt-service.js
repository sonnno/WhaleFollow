const fs = require('node:fs'), path = require('node:path'), async = require('async');
// Only already executed fills belong here. This is a bookkeeping journal, never
// an order queue: flush receives a record-only callback, not the copy executor.
function create(directory) {
  const file = path.join(directory, 'unrecorded-fills.jsonl'); let busy = false;
  function lines() { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(function (line) { return line.trim(); }) : []; }
  function count() { return lines().length; }
  function append(receipt) { fs.mkdirSync(directory, { recursive: true }); fs.appendFileSync(file, JSON.stringify(receipt) + '\n', { mode: 0o600, flush: true }); }
  function flush(record, recorded, callback) {
    if (busy) return callback(new Error('Receipt recording already in progress'));
    let batch;
    try { batch = lines().map(function (line) { return { line, receipt: JSON.parse(line) }; }); } catch (err) { return callback(err); }
    batch.sort(function (a, b) {
      const left = a.receipt.order && a.receipt.order.details && a.receipt.order.details.timings || {};
      const right = b.receipt.order && b.receipt.order.details && b.receipt.order.details.timings || {};
      if (left.executionSession && left.executionSession === right.executionSession && Number.isSafeInteger(left.executionSequence) && Number.isSafeInteger(right.executionSequence)) return left.executionSequence - right.executionSequence;
      return (Date.parse(left.executedAt) || 0) - (Date.parse(right.executedAt) || 0);
    });
    busy = true;
    async.eachSeries(batch, function (item, next) {
      record(item.receipt, function (err) {
        if (err) return next(err);
        try {
          // Preserve any receipts appended while the DB callback was pending.
          const remaining = lines(), index = remaining.indexOf(item.line);
          if (index < 0) throw new Error('Executed receipt disappeared during recording');
          remaining.splice(index, 1);
          fs.writeFileSync(file + '.tmp', remaining.length ? remaining.join('\n') + '\n' : '', { mode: 0o600, flush: true });
          fs.renameSync(file + '.tmp', file);
          recorded(item.receipt);
        } catch (error) { return next(error); }
        next();
      });
    }, function (err) { busy = false; callback(err); });
  }
  return { count, append, flush };
}
module.exports = { create };
