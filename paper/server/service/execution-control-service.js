const channel = 'paper:execution-controls';
const { D, str, buy, sell } = require('./accounting-service');
function create(db, redis) {
  let ready = false, busy = false, stopped = false, revision = 0, refreshedAt = 0, subscriber;
  const entries = new Map(); let settings = {}, waiting = [];
  let account, sharedCash = '0', halted = false; const pending = new Map();
  function invalidate() { revision++; ready = false; }
  function refresh(callback) {
    if (stopped) return (callback || function () {})();
    if (pending.size) return (callback || function () {})();
    waiting.push(callback || function () {}); if (busy) return;
    busy = true; const began = revision;
    db.query(`SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'leader',jsonb_build_object('id',l.id,'name',l.name,'active',l.active,'joinedAt',l."joinedAt",'raw',jsonb_build_object('followGeneration',l.raw->'followGeneration')),
      'task',to_jsonb(t)||jsonb_build_object('cash',t.cash::text,'allocation',t.allocation::text,'fundedCapital',t."fundedCapital"::text,'fees',t.fees::text,'realized',t.realized::text,'copyPercent',t."copyPercent"::text,'maxOrderAmount',t."maxOrderAmount"::text),
      'positionCost',(SELECT COALESCE(SUM(p.cost),0)::text FROM paper_positions p WHERE p.wallet=l.id AND p.quantity>0),
      'positions',COALESCE((SELECT jsonb_object_agg(p.token,to_jsonb(p)||jsonb_build_object('quantity',p.quantity::text,'cost',p.cost::text,'realized',p.realized::text,'cycleRealized',p."cycleRealized"::text)) FROM paper_positions p WHERE p.wallet=l.id AND p.quantity>0),'{}'::jsonb)))
      FROM paper_leaders l LEFT JOIN paper_follow_tasks t ON t.id=l.id),'[]'::jsonb) AS roster,
      (SELECT to_jsonb(a)||jsonb_build_object('cash',a.cash::text,'fees',a.fees::text,'realized',a.realized::text) FROM paper_accounts a WHERE id='paper') AS account,
      (SELECT (a.cash-COALESCE((SELECT SUM(cash) FROM paper_follow_tasks WHERE "fundingMode"='dedicated'),0))::text FROM paper_accounts a WHERE id='paper') AS "sharedCash",
      (SELECT value FROM paper_settings WHERE id='runtime') AS settings`, [], function (err, rows) {
      busy = false;
      if (err) ready = false;
      else if (!stopped && began === revision) {
        entries.clear(); (rows[0].roster || []).forEach(function (entry) { entries.set(entry.leader.id, entry); });
        account = rows[0].account; sharedCash = rows[0].sharedCash || '0';
        settings = rows[0].settings || {}; refreshedAt = Date.now(); ready = true;
      }
      const callbacks = waiting; waiting = []; callbacks.forEach(function (done) { done(err); });
    });
  }
  function get(wallet) {
    if (halted || !ready || !pending.size && Date.now() - refreshedAt > 5000) return null;
    const value = entries.get(wallet); return value ? JSON.parse(JSON.stringify({ ...value, settings, account, sharedCash })) : null;
  }
  function reserve(signal, fill) {
    const entry = entries.get(signal.wallet); if (!entry || !account) throw new Error('Execution balance unavailable');
    const buying = signal.side === 'BUY', delta = buying ? D(fill.cash).negated() : D(fill.cash);
    let position = entry.positions && entry.positions[signal.token] || { quantity: '0', cost: '0', realized: '0', cycleRealized: '0' };
    const change = buying ? buy(position, fill) : sell(position, fill);
    const released = buying ? D(fill.cash) : D(change.released).negated();
    if (D(account.cash).plus(delta).lt(0) || buying && entry.task && entry.task.fundingMode === 'dedicated' && D(entry.task.cash).plus(delta).lt(0) || buying && (!entry.task || entry.task.fundingMode === 'shared') && D(sharedCash).plus(delta).lt(0)) throw new Error('Insufficient execution balance');
    revision++; pending.set(signal.id, (pending.get(signal.id) || 0) + 1); account.cash = str(D(account.cash).plus(delta));
    if (entry.task && entry.task.fundingMode === 'dedicated') entry.task.cash = str(D(entry.task.cash).plus(delta)); else sharedCash = str(D(sharedCash).plus(delta));
    entry.positionCost = str(D(entry.positionCost).plus(released));
    if (!entry.positions) entry.positions = {}; entry.positions[signal.token] = { ...position, ...change };
  }
  function complete(id, failed, preserve) {
    revision++;
    if (preserve) { halted = true; ready = false; return; }
    const remaining = (pending.get(id) || 1) - 1;
    if (remaining) pending.set(id, remaining); else pending.delete(id);
    if (failed) ready = false; if (!pending.size) refresh(function () {});
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
  return { get, reserve, complete, observe, observeLeader, invalidate, refresh, start, stop };
}
module.exports = { create, channel };
