const async = require('async');
const { D, str } = require('./accounting-service');
const config = require('../../config').paper;

// Keep endpoints and bucket extrema, rather than shipping thousands of curve points.
function sample(rows) {
  if (rows.length <= 1000) return rows;
  const selected = new Set([0, rows.length - 1]), width = Math.ceil(rows.length / 499);
  for (let start = 0; start < rows.length; start += width) {
    let min = start, max = start;
    for (let i = start + 1; i < Math.min(start + width, rows.length); i++) {
      // Numbers select visual points only; accounting sums retain Decimal precision.
      if (Number(rows[i].settledProfit) < Number(rows[min].settledProfit)) min = i;
      if (Number(rows[i].settledProfit) > Number(rows[max].settledProfit)) max = i;
    }
    selected.add(min); selected.add(max);
  }
  return Array.from(selected).sort(function (a, b) { return a - b; }).map(function (i) { return rows[i]; });
}
function iso(value) { return new Date(value).toISOString(); }
function create(db) {
  function cashSummary(callback) {
    db.readSnapshot(function (tx, done) {
      let account, pending, tasks;
      async.waterfall([
        function (next) { tx.query('SELECT cash,"initialCash",realized AS "totalProfit",fees,"createdAt" FROM paper_accounts WHERE id=$1', ['paper'], next); },
        function (rows, next) {
          account = rows[0]; if (!account) return next(new Error('Account not initialized'));
          tx.query(`SELECT COALESCE(SUM(p.cost),0)::text AS "pendingCost",COALESCE(SUM(b.count),0)::int AS "pendingBets"
            FROM paper_positions p CROSS JOIN LATERAL (
              SELECT COUNT(*) count FROM paper_orders o WHERE o.wallet=p.wallet AND o.token=p.token
                AND o.side='BUY' AND o.status IN ('FILLED','PARTIAL') AND COALESCE((o.details->>'positionCycle')::int,1)=p.cycle
            ) b WHERE p.quantity>0`, [], next);
        },
        function (rows, next) {
          pending = rows[0]; tx.query(`SELECT f.id,f.cash,f."createdAt",COALESCE(l.name,f.id) name
            FROM paper_follow_tasks f LEFT JOIN paper_leaders l ON l.id=f.id
            WHERE f."fundingMode"='dedicated' ORDER BY f."createdAt",f.id`, [], next);
        },
        function (rows, next) { tasks = rows; tx.query("SELECT id,value FROM paper_settings WHERE id='runtime' OR id LIKE 'balance-warning:%'", [], next); },
        function (rows, next) {
          const settings = new Map(rows.map(function (row) { return [row.id, row.value]; }));
          const dedicated = tasks.reduce(function (sum, task) { return sum.plus(task.cash); }, D(0));
          const wallets = [
            { id: 'total', name: '总钱包', cash: account.cash, warning: settings.get('balance-warning:total') || null },
            { id: 'shared', name: '公共钱包', cash: str(D(account.cash).minus(dedicated)), warning: settings.get('balance-warning:shared') || null }
          ];
          tasks.forEach(function (task) {
            const warning = settings.get('balance-warning:dedicated:' + task.id);
            wallets.push({ id: task.id, name: task.name + ' · 独立钱包', cash: task.cash,
              warning: warning && warning.taskCreatedAt && iso(warning.taskCreatedAt) === iso(task.createdAt) ? warning : null });
          });
          next(null, { ...account, ...pending, createdAt: iso(account.createdAt), walletBalances: wallets,
            runtime: settings.get('runtime') || {}, mode: 'paper', currency: config.currency });
        }
      ], done);
    }, callback);
  }
  function homeHistory(callback) {
    db.readSnapshot(function (tx, done) {
      let accountCreatedAt, history, leaders;
      async.waterfall([
        function (next) { tx.query('SELECT "createdAt" FROM paper_accounts WHERE id=$1', ['paper'], next); },
        function (rows, next) {
          if (!rows[0]) return next(new Error('Account not initialized'));
          accountCreatedAt = iso(rows[0].createdAt);
          tx.query(`SELECT s.wallet,COALESCE(l.name,s.wallet) name,s.profit::text,s."createdAt"
            FROM paper_settlements s LEFT JOIN paper_leaders l ON l.id=s.wallet
            UNION ALL SELECT NULL::text,NULL::text,details->>'profit',"createdAt"
            FROM paper_cash_ledger WHERE kind='SETTLEMENT' AND details->>'recordsDeleted'='true'
            ORDER BY "createdAt"`, [], next);
        },
        function (rows, next) {
          let total = D(0), index = 0; const byWallet = new Map();
          history = [{ createdAt: accountCreatedAt, settledProfit: '0' }];
          function batch() {
            try {
              const end = Math.min(rows.length, index + 256);
              for (; index < end; index++) {
                const row = rows[index]; total = total.plus(row.profit);
                const at = iso(row.createdAt), prior = history[history.length - 1];
                if (prior.createdAt === at) prior.settledProfit = str(total);
                else history.push({ createdAt: at, settledProfit: str(total) });
                if (!row.wallet) continue;
                const leader = byWallet.get(row.wallet) || { wallet: row.wallet, name: row.name, count: 0, profit: '0' };
                leader.count++; leader.profit = str(D(leader.profit).plus(row.profit)); byWallet.set(row.wallet, leader);
              }
              if (index < rows.length) return setImmediate(batch);
              leaders = Array.from(byWallet.values()).sort(function (a, b) { return D(b.profit).cmp(a.profit); });
              history = sample(history);
            } catch (err) { return next(err); }
            tx.query('SELECT day::text AS day,"netProfit"::text AS profit FROM paper_daily_reports WHERE "breakdownVersion">=1 ORDER BY day DESC', [], next);
          }
          batch();
        },
        function (days, next) { next(null, { accountCreatedAt, history, leaders, days }); }
      ], done);
    }, callback);
  }
  return { cashSummary, homeHistory };
}
module.exports = { create, sample };
