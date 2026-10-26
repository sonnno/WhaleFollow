const crypto = require('node:crypto');
const { eventKey } = require('./match-ratio-service');
function signalEvent(signal) {
  const raw = (signal.raw || [])[0] || {};
  return eventKey(signal.eventKey || signal.eventSlug || signal.event_slug || raw.event_slug || raw.eventSlug);
}
function freeze(tx, wallet, at, callback) {
  tx.query(`/* smart-pause-events */ SELECT DISTINCT p.condition,
    COALESCE(NULLIF(m.raw->'gamma'->>'eventSlug',''),(
      SELECT COALESCE(NULLIF(o.details->'matchRatio'->>'eventKey',''),NULLIF(o.details->'signal'->'raw'->0->>'event_slug',''),NULLIF(o.details->'signal'->'raw'->0->>'eventSlug',''))
      FROM paper_orders o WHERE o.wallet=p.wallet AND o.token=p.token AND o.side='BUY' AND o.status IN ('FILLED','PARTIAL') AND o.gross>0
      ORDER BY o."createdAt" DESC,o.id DESC LIMIT 1)) AS "eventSlug"
    FROM paper_positions p LEFT JOIN paper_markets m ON m.id=p.condition
    WHERE p.wallet=$1 AND p.quantity>0 AND COALESCE(m.resolution->>'status','')<>'resolved'
      AND COALESCE(m.raw->'gamma'->>'eventClosed','false')<>'true'`, [wallet], function (err, rows) {
    if (err) return callback(err);
    if (rows.some(function (row) { return !eventKey(row.eventSlug); })) return callback(Object.assign(new Error('未结算比赛信息尚未同步，暂不能智能暂停；仍可使用全部暂停'), {status:409}));
    callback(null, {id:crypto.randomUUID(), at:new Date(at).toISOString(), events:[...new Set(rows.map(function (row) {return eventKey(row.eventSlug);}))]});
  });
}
function recordExecuted(tx, task, order, callback) {
  const pause = task && task.smartPause;
  if (order.side !== 'BUY' || !pause || order.details.followTask?.smartPauseId === pause.id) return callback();
  const key = eventKey(order.details.matchRatio?.eventKey) || signalEvent(order.details.signal || {});
  if (!key || pause.events.includes(key)) return callback();
  // The buy already executed under the previous control snapshot. Include it
  // while recording the receipt; never re-buy or compare different clocks.
  tx.query(`UPDATE paper_follow_tasks SET "smartPause"=jsonb_set("smartPause",'{events}',COALESCE("smartPause"->'events','[]'::jsonb)||jsonb_build_array($3::text)),"updatedAt"=clock_timestamp()
    WHERE id=$1 AND "smartPause"->>'id'=$2 AND NOT ("smartPause"->'events' ? $3)`, [task.id,pause.id,key], function (err) {callback(err);});
}
module.exports = {freeze,signalEvent,recordExecuted};
