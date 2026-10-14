const async = require('async');
const crypto = require('node:crypto');
const http = require('../lib/http-client');
const config = require('../../config').paper;

function create(db, options) {
  const config = options && options.config || require('../../config').paper;
  function refresh(callback) {
    db.one('Setting', { where: { id: 'follow-tasks-initialized' } }, function (err, marker) {
      if (err) return callback(err);
      if (marker) return callback(null, { manualRoster: true });
      refreshAutomatic(callback);
    });
  }
  function refreshAutomatic(callback) {
    let board;
    async.waterfall([
      function (next) { http.request(config.dataUrl, '/v2/leaderboard', { category: 'overall', time_period: 'month', sort_by: 'PNL', limit: 10 }, next); },
      function (response, next) {
        if (!Array.isArray(response.data) || response.data.some(function (row) { return !/^0x[a-fA-F0-9]{40}$/.test(row.user_id); })) return next(new Error('Invalid leaderboard response'));
        if (response.data.length === 0) return next(new Error('Empty leaderboard; preserving prior roster'));
        const fixed = config.followWallets && config.followWallets.length ? config.followWallets : null;
        board = response.data.slice(0, 10).filter(function (row) { return !fixed || fixed.includes(row.user_id.toLowerCase()); });
        db.transaction(function (tx, done) {
          async.waterfall([
            function (step) { tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], step); },
            function (_, step) { tx.query('UPDATE paper_leaders SET active=false WHERE active=true AND NOT(id=ANY($1::text[]))', [fixed || board.map(function (row) { return row.user_id.toLowerCase(); })], step); },
            function (_, step) {
              async.eachSeries(board, function (row, saved) {
                tx.one('Leader', { where: { id: row.user_id.toLowerCase() } }, function (err, existing) {
                  if (err) return saved(err);
                  tx.save('Leader', { ...existing, id: row.user_id.toLowerCase(), name: row.user_name || row.user_id, rank: row.rank, pnl: String(row.pnl), active: true, joinedAt: existing && existing.active ? existing.joinedAt : new Date(), inventory: existing && existing.active ? existing.inventory : {}, inventoryValid: existing && existing.active ? existing.inventoryValid : false, raw: { ...(existing && existing.active ? existing.raw : {}), board: row } }, function (error) { saved(error); });
                });
              }, step);
            },
            function (step) { tx.insert('Board', { id: crypto.randomUUID(), rows: { category: 'overall', time_period: 'month', sort_by: 'PNL', data: board } }, step); }
          ], done);
        }, next);
      }
    ], callback);
  }
  function tracked(callback) {
    db.query('SELECT l.* FROM paper_leaders l WHERE l.active OR EXISTS (SELECT 1 FROM paper_positions p WHERE p.wallet=l.id AND p.quantity>0) ORDER BY l.active DESC,l.rank ASC', [], callback);
  }
  function inventory(leader, callback) {
    const began = Date.now();
    http.pages(config.dataUrl, '/v2/positions', { user: leader.id, status: 'OPEN', filter_amount: 0, limit: 1000 }, function (err, rows) {
      if (err) return callback(err);
      const inventory = {};
      rows.forEach(function (row) { const token = row.token_id || row.asset; const size = row.current_size === undefined ? row.size : row.current_size; if (token && size !== undefined) inventory[token] = String(size); });
      // Only post-response trades can advance this baseline; ambiguous older signals cannot sell.
      const ended = Math.ceil(Date.now() / 1000);
      db.transaction(function (tx, done) {
        async.waterfall([
          function (next) { tx.query('SELECT id FROM paper_accounts WHERE id=$1 FOR UPDATE', ['paper'], next); },
          function (_, next) { tx.one('Leader', { where: { id: leader.id } }, next); },
          function (row, next) { if (!row || Number(row.raw && row.raw.followGeneration || 0) !== Number(leader.raw && leader.raw.followGeneration || 0)) return next(null, { stale: true }); row.raw = row.raw || {}; row.inventory = inventory; row.inventoryValid = Number(row.raw.lastTradeObservedAt || 0) < began; row.raw.inventoryTimestamp = ended; row.raw.inventoryRevision = crypto.randomUUID(); tx.save('Leader', row, next); }
        ], done);
      }, callback);
    });
  }
  return { refresh, tracked, inventory };
}
module.exports = { create };
