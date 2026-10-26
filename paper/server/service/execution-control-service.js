const channel = 'paper:execution-controls';
const { D, str, buy, sell } = require('./accounting-service');
function create(db, redis) {
  let ready = false, busy = false, stopped = false, revision = 0, subscriber;
  let subscriptionRequired = false, subscriberReady = false, subscriptionRevision = 0;
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
      'sourceSpending',CASE WHEN t."maxOrderAmount" IS NOT NULL THEN COALESCE((SELECT jsonb_object_agg(s."sourceId",s.spent) FROM
        (SELECT o."sourceId",SUM(o.gross+o.fee)::text AS spent FROM paper_orders o WHERE o.wallet=l.id AND o.side='BUY' AND o.status IN ('FILLED','PARTIAL') GROUP BY o."sourceId") s),'{}'::jsonb) ELSE '{}'::jsonb END,
      'positions',COALESCE((SELECT jsonb_object_agg(p.token,to_jsonb(p)||jsonb_build_object('quantity',p.quantity::text,'cost',p.cost::text,'realized',p.realized::text,'cycleRealized',p."cycleRealized"::text)) FROM paper_positions p WHERE p.wallet=l.id AND p.quantity>0),'{}'::jsonb)))
      FROM paper_leaders l LEFT JOIN paper_follow_tasks t ON t.id=l.id),'[]'::jsonb) AS roster,
      (SELECT to_jsonb(a)||jsonb_build_object('cash',a.cash::text,'fees',a.fees::text,'realized',a.realized::text) FROM paper_accounts a WHERE id='paper') AS account,
      (SELECT (a.cash-COALESCE((SELECT SUM(cash) FROM paper_follow_tasks WHERE "fundingMode"='dedicated'),0))::text FROM paper_accounts a WHERE id='paper') AS "sharedCash",
      (SELECT value FROM paper_settings WHERE id='runtime') AS settings`, [], function (err, rows) {
      busy = false;
      // Background read failures leave a coherent memory snapshot intact. Explicit
      // control/subscription invalidation still keeps reads closed until reload.
      if (!err && !stopped && began === revision) {
        entries.clear(); (rows[0].roster || []).forEach(function (entry) { entries.set(entry.leader.id, entry); });
        account = rows[0].account; sharedCash = rows[0].sharedCash || '0';
        settings = rows[0].settings || {}; ready = true;
      }
      const callbacks = waiting; waiting = []; callbacks.forEach(function (done) { done(err); });
      if (subscriptionRequired && subscriberReady && !stopped && began !== revision && !pending.size) refresh(function () {});
    });
  }
  function available(wallet) {
    if (halted || !ready || subscriptionRequired && !subscriberReady) return null;
    return entries.get(wallet) || null;
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function tracks(wallet) { return entries.has(wallet); }
  function peek(wallet) {
    const value = available(wallet);
    return value ? clone({ leader: value.leader, task: value.task, settings }) : null;
  }
  function selected(values, key) {
    return values && Object.prototype.hasOwnProperty.call(values, key) ? { [key]: values[key] } : {};
  }
  function get(wallet, token, sourceId) {
    const value = available(wallet); if (!value) return null;
    if (arguments.length === 1) return clone({ ...value, settings, account, sharedCash });
    return clone({ ...value, positions: selected(value.positions, token), sourceSpending: selected(value.sourceSpending, sourceId), settings, account, sharedCash });
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
    if (buying && signal.sourceId) { if (!entry.sourceSpending) entry.sourceSpending = {}; entry.sourceSpending[signal.sourceId] = str(D(entry.sourceSpending[signal.sourceId] || 0).plus(fill.cash)); }
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
    settings = context.settings || {};
  }
  function observeLeader(leader) {
    revision++; const entry = entries.get(leader.id) || {}; entries.set(leader.id, { ...entry, leader });
  }
  function start(callback) {
    stopped = false; subscriptionRequired = true; subscriberReady = false; invalidate();
    function disconnected() { subscriptionRevision++; subscriberReady = false; invalidate(); }
    subscriber = redis.duplicate();
    subscriber.on('message', function (name) { if (name !== channel) return; invalidate(); refresh(function () {}); });
    ['error', 'close', 'end', 'reconnecting'].forEach(function (event) { subscriber.on(event, disconnected); });
    subscriber.on('ready', function () {
      if (stopped) return;
      const subscribing = ++subscriptionRevision; subscriberReady = false; invalidate();
      subscriber.subscribe(channel, function (err) {
        if (stopped || subscribing !== subscriptionRevision) return;
        if (err) return disconnected();
        subscriberReady = true; invalidate(); refresh(function () {});
      });
    });
    subscriber.connect(function (err) { if (err) disconnected(); });
    refresh(callback);
  }
  function stop() { stopped = true; revision++; subscriptionRevision++; subscriberReady = false; if (subscriber) subscriber.disconnect(); ready = false; }
  function resume(callback) {
    if (pending.size) return callback(new Error('Executed fills are still being recorded'));
    invalidate();
    refresh(function (err) {
      if (err) return callback(err);
      if (!ready || pending.size || stopped) return callback(new Error('Execution balances are not ready'));
      halted = false; callback();
    });
  }
  return { get, peek, tracks, reserve, complete, observe, observeLeader, invalidate, refresh, start, stop, resume };
}
module.exports = { create, channel };
