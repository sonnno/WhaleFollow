const { definitions } = require('../entities');
function quote(value) { return '"' + value.replace(/"/g, '""') + '"'; }
function column(name, def) {
  let sql = quote(name) + ' ' + (def.type === 'numeric' ? 'numeric(38,18)' : def.type);
  if (!def.nullable) sql += ' NOT NULL';
  if (Object.hasOwn(def, 'default')) {
    if (typeof def.default === 'function') sql += ' DEFAULT ' + def.default();
    else if (def.default === null) sql += ' DEFAULT NULL';
    else if (typeof def.default === 'object') sql += " DEFAULT '{}'::jsonb";
    else if (typeof def.default === 'boolean') sql += ' DEFAULT ' + String(def.default);
    else sql += " DEFAULT '" + String(def.default).replace(/'/g, "''") + "'";
  }
  return sql;
}
class Initial1780000000000 {
  name = 'Initial1780000000000';
  up(runner) {
    const sql = Object.values(definitions).filter(function (def) { return !['paper_daily_reports','paper_daily_task_reports'].includes(def.table); }).map(function (def) {
      const columns = ['id text PRIMARY KEY', ...Object.entries(def.columns).map(function ([key, value]) { return column(key, value); }), '"createdAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP', '"updatedAt" timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP'];
      return 'CREATE TABLE ' + quote(def.table) + ' (' + columns.join(',') + ')';
    });
    sql.push('CREATE INDEX paper_source_wallet_time ON paper_source_trades(wallet,timestamp)', 'CREATE INDEX paper_orders_created ON paper_orders("createdAt" DESC)', 'CREATE INDEX paper_positions_condition ON paper_positions(condition)', 'CREATE INDEX paper_outbox_pending ON paper_outbox(status,"createdAt")', 'CREATE INDEX paper_fills_order ON paper_fills("orderId")');
    return runner.query(sql.join(';'));
  }
  down(runner) { return runner.query(Object.values(definitions).filter(function (def) { return !['paper_daily_reports','paper_daily_task_reports'].includes(def.table); }).reverse().map(function (def) { return 'DROP TABLE ' + quote(def.table); }).join(';')); }
}
module.exports = Initial1780000000000;
