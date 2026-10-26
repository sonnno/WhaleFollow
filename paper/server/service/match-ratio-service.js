const async = require('async'), crypto = require('node:crypto');
const { D, str } = require('./accounting-service');
function eventKey(value) { return typeof value === 'string' ? value.trim().toLowerCase().replace(/-more-markets(?:-\d+)?$/, '') : ''; }
function timestamp(value) { return new Date(value).toISOString(); }
function create(db, markets) {
  const locks = new Map(), conditions = new Map(), resolving = new Map();
  function identity(signal, callback) {
    const raw = (signal.raw || [])[0] || {};
    const key = eventKey(signal.eventSlug || signal.event_slug || raw.event_slug || raw.eventSlug || conditions.get(signal.condition));
    if (key) { conditions.set(signal.condition, key); return callback(null, key); }
    if (resolving.has(signal.condition)) { resolving.get(signal.condition).push(callback); return; }
    resolving.set(signal.condition, [callback]);
    function finish(err, value) {
      const resolved = !err && eventKey(value), waiting = resolving.get(signal.condition); resolving.delete(signal.condition);
      if (resolved) conditions.set(signal.condition, resolved);
      const error = resolved ? null : Object.assign(new Error('无法确认这笔订单属于哪场比赛，未使用新比例下注'), { code: 'MATCH_IDENTITY_UNAVAILABLE', cause: err });
      waiting.forEach(function (done) { done(error, resolved); });
    }
    if (!markets.identifyEvent) return finish(new Error('Match resolver unavailable'));
    markets.identifyEvent(signal, finish);
  }
  function selection(wallet, createdAt, key, percent) {
    const taskCreatedAt = timestamp(createdAt);
    const id = crypto.createHash('sha256').update(JSON.stringify([wallet, taskCreatedAt, key])).digest('hex');
    return { id, wallet, taskCreatedAt, eventKey: key, copyPercent: str(percent) };
  }
  function effective(value, task) {
    return { ...(locks.get(value.id) || (task ? { ...value, copyPercent: str(task.copyPercent) } : value)) };
  }
  function lock(value, orderId, at) {
    if (!locks.has(value.id)) locks.set(value.id, { ...value, firstOrderId: orderId, lockedAt: timestamp(at) });
    return effective(value);
  }
  function persist(tx, value, callback) {
    tx.query(`INSERT INTO paper_match_ratios(id,wallet,"taskCreatedAt","eventKey","copyPercent","firstOrderId","lockedAt")
      SELECT v->>'id',v->>'wallet',(v->>'taskCreatedAt')::timestamptz,v->>'eventKey',(v->>'copyPercent')::numeric,v->>'firstOrderId',(v->>'lockedAt')::timestamptz
      FROM jsonb_array_elements($1::jsonb) v
      ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id
      RETURNING "copyPercent"::text`, [JSON.stringify([value])], function (err, rows) {
      if (err) return callback(err);
      if (!rows[0] || !D(rows[0].copyPercent).eq(value.copyPercent)) return callback(new Error('Persisted match ratio differs from executed ratio'));
      // Receipt replay records an already executed buy after a restart. Restore
      // its memory lock before execution resumes, even if accounting must retry.
      lock(value, value.firstOrderId, value.lockedAt);
      callback();
    });
  }
  function start(callback) {
    const recovered = new Map();
    async.waterfall([
      function (next) { db.query('SELECT id,wallet,"taskCreatedAt","eventKey","copyPercent"::text,"firstOrderId","lockedAt" FROM paper_match_ratios', [], next); },
      function (rows, next) {
        rows.forEach(function (row) { recovered.set(row.id, { ...row, taskCreatedAt: timestamp(row.taskCreatedAt), lockedAt: timestamp(row.lockedAt) }); });
        db.query(`/* match-ratio-history */ SELECT o.wallet,o.condition,t."createdAt" AS "taskCreatedAt",
          COALESCE(NULLIF(o.details->'matchRatio'->>'firstOrderId',''),o.id) AS "firstOrderId",
          COALESCE(NULLIF(o.details->'matchRatio'->>'lockedAt','')::timestamptz,
            NULLIF(o.details->'timings'->>'executedAt','')::timestamptz,o."createdAt") AS "lockedAt",
          COALESCE(NULLIF(o.details->'matchRatio'->>'eventKey',''),NULLIF(o.details->'signal'->'raw'->0->>'event_slug',''),
            NULLIF(o.details->'signal'->'raw'->0->>'eventSlug',''),NULLIF(m.raw->'gamma'->>'eventSlug','')) AS "eventSlug",
          COALESCE(NULLIF(o.details->'matchRatio'->>'copyPercent',''),NULLIF(o.details->'followTask'->>'copyPercent',''),
            CASE WHEN o.details->'config'->>'copySizing'='fixed_ratio' THEN ((o.details->'config'->>'copyRatio')::numeric*100)::text END,
            CASE WHEN o.details->'signal'->'config'->>'copySizing'='fixed_ratio' THEN ((o.details->'signal'->'config'->>'copyRatio')::numeric*100)::text END,'100') AS "copyPercent"
          FROM paper_orders o JOIN paper_follow_tasks t ON t.id=o.wallet
          LEFT JOIN paper_markets m ON m.id=o.condition
          WHERE o.side='BUY' AND o.status IN ('FILLED','PARTIAL') AND o.gross>0
          ORDER BY "lockedAt",o.id`, [], next);
      },
      function (rows, next) {
        async.eachLimit(rows, 2, function (row, done) {
          identity({ condition: row.condition, eventSlug: row.eventSlug }, function (err, key) {
            if (err) return done(err);
            let value;
            try { value = { ...selection(row.wallet, row.taskCreatedAt, key, row.copyPercent), firstOrderId: row.firstOrderId, lockedAt: timestamp(row.lockedAt) }; }
            catch (error) { return done(error); }
            const prior = recovered.get(value.id);
            if (!prior || value.lockedAt < prior.lockedAt || value.lockedAt === prior.lockedAt && value.firstOrderId < prior.firstOrderId) recovered.set(value.id, value);
            // Startup backfill also yields between rows, keeping shutdown responsive.
            setImmediate(done);
          });
        }, next);
      },
      function (next) {
        if (!recovered.size) return next();
        db.query(`INSERT INTO paper_match_ratios(id,wallet,"taskCreatedAt","eventKey","copyPercent","firstOrderId","lockedAt")
          SELECT v->>'id',v->>'wallet',(v->>'taskCreatedAt')::timestamptz,v->>'eventKey',(v->>'copyPercent')::numeric,v->>'firstOrderId',(v->>'lockedAt')::timestamptz
          FROM jsonb_array_elements($1::jsonb) v ON CONFLICT(id) DO UPDATE SET
            "copyPercent"=EXCLUDED."copyPercent","firstOrderId"=EXCLUDED."firstOrderId","lockedAt"=EXCLUDED."lockedAt"
          WHERE (EXCLUDED."lockedAt",EXCLUDED."firstOrderId") < (paper_match_ratios."lockedAt",paper_match_ratios."firstOrderId")`,
        [JSON.stringify(Array.from(recovered.values()))], function (err) { next(err); });
      }
    ], function (err) {
      if (!err) { locks.clear(); recovered.forEach(function (value, id) { locks.set(id, value); }); }
      callback(err);
    });
  }
  function select(signal, task, callback) {
    identity(signal, function (err, key) {
      if (err) return callback(err);
      let value;
      try { value = selection(signal.wallet, task.createdAt, key, task.copyPercent); } catch (error) { return callback(error); }
      callback(null, effective(value, task));
    });
  }
  return { start, select, effective, lock, persist };
}
module.exports = { create, eventKey };
