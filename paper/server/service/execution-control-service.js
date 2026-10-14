const channel = 'paper:execution-controls';
function create(db, redis) {
  let ready = false, busy = false, stopped = false, revision = 0, refreshedAt = 0, subscriber;
  const entries = new Map(); let settings = {}, waiting = [];
  function invalidate() { revision++; ready = false; }
  function refresh(callback) {
    if (stopped) return (callback || function () {})();
    waiting.push(callback || function () {}); if (busy) return;
    busy = true; const began = revision;
    db.query(`SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'leader',jsonb_build_object('id',l.id,'name',l.name,'active',l.active,'joinedAt',l."joinedAt",'raw',jsonb_build_object('followGeneration',l.raw->'followGeneration')),
      'task',to_jsonb(t)||jsonb_build_object('cash',t.cash::text,'allocation',t.allocation::text,'fundedCapital',t."fundedCapital"::text,'fees',t.fees::text,'realized',t.realized::text,'copyPercent',t."copyPercent"::text,'maxOrderAmount',t."maxOrderAmount"::text)))
      FROM paper_leaders l LEFT JOIN paper_follow_tasks t ON t.id=l.id),'[]'::jsonb) AS roster,
      (SELECT value FROM paper_settings WHERE id='runtime') AS settings`, [], function (err, rows) {
      busy = false;
      if (err) ready = false;
      else if (!stopped && began === revision) {
        entries.clear(); (rows[0].roster || []).forEach(function (entry) { entries.set(entry.leader.id, entry); });
        settings = rows[0].settings || {}; refreshedAt = Date.now(); ready = true;
      }
      const callbacks = waiting; waiting = []; callbacks.forEach(function (done) { done(err); });
    });
  }
  function get(wallet) {
    if (!ready || Date.now() - refreshedAt > 5000) return null;
    const value = entries.get(wallet); return value ? JSON.parse(JSON.stringify({ ...value, settings })) : null;
  }
  function observe(context) {
    revision++;
    const wallet = context.claimed && context.claimed.wallet || context.leader && context.leader.id;
    if (wallet) entries.set(wallet, { leader: context.leader, task: context.task });
    settings = context.settings || {}; refreshedAt = Date.now();
  }
  function observeLeader(leader) {
    revision++; const entry = entries.get(leader.id) || {}; entries.set(leader.id, { ...entry, leader });
  }
  function start(callback) {
    stopped = false;
    subscriber = redis.duplicate();
    subscriber.on('message', function (name) { if (name !== channel) return; invalidate(); refresh(function () {}); });
    subscriber.on('error', invalidate);
    subscriber.on('ready', function () { if (stopped) return; subscriber.subscribe(channel, function (err) { if (err) invalidate(); else refresh(function () {}); }); });
    subscriber.connect(function (err) { if (err) invalidate(); });
    refresh(callback);
  }
  function stop() { stopped = true; revision++; if (subscriber) subscriber.disconnect(); ready = false; }
  return { get, observe, observeLeader, invalidate, refresh, start, stop };
}
module.exports = { create, channel };
