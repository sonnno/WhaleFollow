const crypto = require('node:crypto');
function create(db) {
  const pending = new Map(); let writing = false;
  function merge(row) {
    const key = row.id + ':' + row.generation, existing = pending.get(key);
    if (!existing) return pending.set(key, row);
    existing.count += row.count;
    if (row.lastAt >= existing.lastAt) { existing.lastAt = row.lastAt; existing.sample = row.sample; }
  }
  function record(signal, task, reason, amount) {
    if (!task?.createdAt) return;
    const taskCreatedAt = new Date(task.createdAt).toISOString();
    const id = crypto.createHash('sha256').update(signal.wallet + ':' + taskCreatedAt + ':' + reason).digest('hex');
    if (amount != null && Number.isFinite(Number(amount)) && Number(amount) >= 1) console.warn(new Date().toISOString() + ' copy-skip: ' + JSON.stringify({ reason, signalId: signal.id || null, sourceId: signal.sourceId || null, wallet: signal.wallet, token: signal.token || null, condition: signal.condition || null, title: signal.title || '', sourceAmount: signal.sourceAmount || null, amount: String(amount), price: signal.price || null, size: signal.size || null, receivedAt: signal.receivedAt || null }));
    merge({ id, wallet: signal.wallet, taskCreatedAt, generation: task.generation, reason, count: 1, lastAt: new Date().toISOString(), sample: { signalId: signal.id || null, sourceId: signal.sourceId || null, token: signal.token || null, condition: signal.condition || null, price: signal.price || null, size: signal.size || null, side: signal.side || null, receivedAt: signal.receivedAt || null, title: signal.title || '', sourceAmount: signal.sourceAmount || null, amount: amount == null ? null : String(amount), sourceTimestamp: signal.timestamp || null } });
  }
  function flush(callback) {
    if (writing || !pending.size) return callback();
    writing = true; const batch = [...pending.values()]; pending.clear();
    db.query(`INSERT INTO paper_copy_skip_stats(id,wallet,"taskCreatedAt",reason,count,"lastAt",sample)
      SELECT v->>'id',v->>'wallet',(v->>'taskCreatedAt')::timestamptz,v->>'reason',(v->>'count')::bigint,(v->>'lastAt')::timestamptz,v->'sample'
      FROM jsonb_array_elements($1::jsonb) v WHERE EXISTS(SELECT 1 FROM paper_follow_tasks t WHERE t.id=v->>'wallet' AND date_trunc('milliseconds',t."createdAt")=(v->>'taskCreatedAt')::timestamptz AND t.generation=(v->>'generation')::int)
      ON CONFLICT(id) DO UPDATE SET count=paper_copy_skip_stats.count+EXCLUDED.count,
      "lastAt"=GREATEST(paper_copy_skip_stats."lastAt",EXCLUDED."lastAt"),sample=CASE WHEN EXCLUDED."lastAt">=paper_copy_skip_stats."lastAt" THEN EXCLUDED.sample ELSE paper_copy_skip_stats.sample END`, [JSON.stringify(batch)], function (err) {
      if (err) batch.forEach(merge);
      writing = false; callback(err);
    });
  }
  return { record, flush };
}
module.exports = { create };
