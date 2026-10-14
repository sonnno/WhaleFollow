const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const async = require('async');
const file = path.join(__dirname, '../server/service/follow-task-service.js');
const wallet = '0x' + 'a'.repeat(40), other = '0x' + 'b'.repeat(40);

function fixture(options) {
  const state = { Account: { paper: { id: 'paper', initialCash: '1000', cash: '1000', realized: '0', fees: '0' } }, FollowTask: {}, Leader: {}, Setting: {}, orders: [], outbox: [], sources: [], legacy: [], positions: [], queries: [] };
  Object.assign(state, options || {});
  let queue = [], busy = false;
  function run() {
    if (busy || !queue.length) return;
    busy = true;
    const [work, callback] = queue.shift(), before = structuredClone(state);
    let locked = false;
    const tx = {
      query: function (sql, params, cb) {
        state.queries.push(sql);
        if (/paper_accounts.*FOR UPDATE/.test(sql)) { locked = true; return cb(null, [structuredClone(state.Account.paper)]); }
        if (/^SELECT clock_timestamp\(\)/.test(sql)) return cb(null, [{ at: new Date('2026-10-13T00:00:00Z') }]);
        if (/SUM\(cash\)/.test(sql)) return cb(null, [{ cash: String(Object.values(state.FollowTask).reduce(function (sum, row) { return sum + (row.fundingMode === 'dedicated' ? Number(row.cash) : 0); }, 0)) }]);
        if (/COUNT\(\*\).*paper_positions/.test(sql)) { const positions = state.positions.filter(function (p) { return p.wallet === params[0] && Number(p.quantity) > 0; }); return cb(null, [{ count: positions.length, cost: String(positions.reduce(function (sum, row) { return sum + Number(row.cost || 0); }, 0)) }]); }
        if (/follow-task-legacy/.test(sql)) return cb(null, structuredClone(state.legacy));
        if (/UPDATE paper_source_trades/.test(sql)) { state.sources.filter(x=>x.wallet===params[0]).forEach(x=>Object.assign(x.raw,{wsPending:false,wsPendingInventory:false,wsSellPending:false}));return cb(null,[]); }
        if (/UPDATE paper_outbox/.test(sql)) { state.outbox.forEach(function (row) { if (row.status === 'pending' && row.payload.wallet === params[0] && (sql.includes('source-confirmation') ? ['source-confirmation','source-reconcile'].includes(row.kind) : row.payload.side === 'BUY')) Object.assign(row, { status: 'done', error: 'TASK_CONTROL_CANCELLED' }); }); return cb(null, []); }
        if (/UPDATE paper_orders/.test(sql)) { state.orders.forEach(function (row) { if (row.status === 'WAITING' && row.wallet === params[0] && row.side === 'BUY') Object.assign(row, { status: 'SKIPPED', reason: 'TASK_CONTROL_CANCELLED', details: { ...row.details, completed: true } }); }); return cb(null, []); }
        return cb(new Error('Unhandled test query: ' + sql));
      },
      one: function (entity, options, cb) { assert.equal(locked, true); cb(null, structuredClone(state[entity][options.where.id] || null)); },
      find: function (entity, _, cb) { assert.equal(locked, true); cb(null, structuredClone(Object.values(state[entity]))); },
      save: function (entity, row, cb) { assert.equal(locked, true); state[entity][row.id] = structuredClone(row); cb(null, row); }
    };
    work(tx, function (err, result) { if (err) Object.assign(state, before); busy = false; callback(err, result); setImmediate(run); });
  }
  return { state, db: { transaction: function (work, cb) { queue.push([work, cb]); run(); }, query: function (sql, _, cb) { state.queries.push(sql); cb(null, [{ result: { wallet: { initialCash: '1000', cash: '1000', totalProfit: '0', allocatedCapital: '0', unallocatedCash: '1000' }, data: [], defaults: { allocation: '1000', copyPercent: '100', maxOrderAmount: null } } }]); } } };
}
function service(f) { return require(file).create(f.db); }
function input(extra) { return { wallet, name: 'Outside leaderboard', allocation: '600', copyPercent: '100', maxOrderAmount: '', ...extra }; }

test('start retires old WS barriers and inventory pending flags while pause preserves them',function(_,done){
 const f=fixture({FollowTask:{[wallet]:{id:wallet,state:'running',generation:1,fundingMode:'shared'}},Leader:{[wallet]:{id:wallet,raw:{followGeneration:1},inventory:{},inventoryValid:true}},outbox:[{id:'barrier',kind:'source-confirmation',status:'pending',payload:{wallet,side:'SELL'}}],sources:[{wallet,raw:{wsPending:true,wsPendingInventory:true,wsSellPending:true}}]});
 const s=service(f);s.control(wallet,{action:'pause'},function(e){assert.ifError(e);assert.equal(f.state.outbox[0].status,'pending');s.control(wallet,{action:'start'},function(err){assert.ifError(err);assert.equal(f.state.outbox[0].status,'done');assert.equal(f.state.sources[0].raw.wsPendingInventory,false);done();});});
});

test('save requires an explicit positive percentage and valid finite money', function (_, done) {
  const f = fixture(), s = service(f);
  const invalid = [{ fundingMode: 'bogus' }, { copyPercent: undefined }, { copyPercent: '' }, { copyPercent: null }, { copyPercent: 0 }, { copyPercent: Infinity }, { copyPercent: '-1' }, { allocation: 'NaN' }, { allocation: '-1' }, { allocation: '0.0000000000000000001' }, { maxOrderAmount: '0' }, { name: '' }, { wallet: 'bad' }];
  async.eachSeries(invalid, function (value, next) { s.save(input(value), function (err) { assert.ok(err); assert.equal(err.status, 400); next(); }); }, function (err) { assert.ifError(err); assert.equal(Object.keys(f.state.FollowTask).length, 0); done(); });
});

test('creating dedicated targets does not reserve public cash', function (_, done) {
  const f = fixture(), s = service(f);
  async.parallel([function (next) { s.save(input({ fundingMode: 'dedicated' }), function (err, row) { next(null, { err, row }); }); }, function (next) { s.save(input({ wallet: other, fundingMode: 'dedicated' }), function (err, row) { next(null, { err, row }); }); }], function (err, results) {
    assert.ifError(err); assert.equal(results.filter(function (r) { return !r.err; }).length, 2);
    assert.equal(f.state.Account.paper.cash, '1000'); assert.equal(Object.values(f.state.FollowTask)[0].cash, '0'); assert.equal(Object.values(f.state.FollowTask)[0].state, 'paused'); done();
  });
});

test('decreasing a dedicated target preserves idle money and never creates an automatic refund', function (_, done) {
  const task = { id: wallet, fundingMode: 'dedicated', fundedCapital: '600', allocation: '600', cash: '40', realized: '-30', fees: '2', state: 'running', generation: 3, copyPercent: '100', maxOrderAmount: '10' };
  const f = fixture({ FollowTask: { [wallet]: task }, Leader: { [wallet]: { id: wallet, name: 'Old', active: true, raw: {} } } }), s = service(f);
  s.save(input({ allocation: '200', copyPercent: '250', maxOrderAmount: null }), function (error, row) {
    assert.ifError(error); assert.equal(row.cash, '40'); assert.equal(row.fundedCapital, '600'); assert.equal(row.pendingRelease, undefined); assert.equal(row.realized, '-30'); assert.equal(row.fees, '2'); assert.equal(row.state, 'running'); assert.equal(row.generation, 3); assert.equal(row.copyPercent, '250'); assert.equal(row.maxOrderAmount, null); assert.equal(f.state.Account.paper.cash, '1000'); done();
  });
});

test('all control actions advance generation and cancel waiting buys while preserving filled orders and sells', function (_, done) {
  const f = fixture({ FollowTask: { [wallet]: { id: wallet, state: 'paused', generation: 1, cash: '10', allocation: '600', realized: '-4', fees: '2' } }, Leader: { [wallet]: { id: wallet, active: false, inventory: { token: '99' }, inventoryValid: true, raw: { board: { name: 'Old' }, inventoryTimestamp: 99 } } }, orders: [{ wallet, side: 'BUY', status: 'WAITING', details: { old: true } }, { wallet, side: 'BUY', status: 'FILLED' }, { wallet, side: 'SELL', status: 'WAITING' }], outbox: [{ payload: { wallet, side: 'BUY' }, status: 'pending' }, { payload: { wallet, side: 'SELL' }, status: 'pending' }] }), s = service(f);
  async.eachSeries(['start', 'pause', 'stop'], function (action, next) {
    const old = f.state.FollowTask[wallet].generation;
    s.control(wallet, { action }, function (err, row) { assert.ifError(err); assert.equal(row.generation, old + 1); assert.equal(f.state.Leader[wallet].raw.followGeneration, old + 1); assert.equal(f.state.Leader[wallet].active, action === 'start'); if (action === 'start') { assert.deepEqual(f.state.Leader[wallet].inventory, {}); assert.equal(f.state.Leader[wallet].inventoryValid, false); assert.equal(row.startedAt.toISOString(), '2026-10-13T00:00:00.000Z'); } next(); });
  }, function (err) { assert.ifError(err); assert.equal(f.state.orders[0].reason, 'TASK_CONTROL_CANCELLED'); assert.equal(f.state.orders[0].details.completed, true); assert.equal(f.state.orders[0].details.old, true); assert.equal(f.state.orders[1].status, 'FILLED'); assert.equal(f.state.orders[2].status, 'WAITING'); assert.equal(f.state.outbox[0].status, 'done'); assert.equal(f.state.outbox[1].status, 'pending'); assert.equal(f.state.FollowTask[wallet].cash, '10'); done(); });
});

test('initialize preserves a legacy singleton balances and ratio and is idempotent', function (_, done) {
  const config = require('../config').paper, prior = { copySizing: config.copySizing, copyRatio: config.copyRatio };
  Object.assign(config, { copySizing: 'fixed_ratio', copyRatio: '0.5' });
  const f = fixture({ Account: { paper: { id: 'paper', initialCash: '1000', cash: '615', realized: '-33', fees: '4' } }, legacy: [{ id: wallet, name: 'Legacy', active: true, joinedAt: new Date('2026-01-01Z'), raw: {}, positionCost: '352', realized: '-33', fees: '4' }] }), s = service(f);
  s.initialize(function (err) { Object.assign(config, prior); assert.ifError(err); const t = f.state.FollowTask[wallet]; assert.equal(t.allocation, '1000'); assert.equal(t.cash, '0'); assert.equal(t.fundedCapital, '0'); assert.equal(t.fundingMode, 'shared'); assert.equal(t.realized, '-33'); assert.equal(t.fees, '4'); assert.equal(t.copyPercent, '50'); s.initialize(function (error, result) { assert.ifError(error); assert.equal(result.initialized, false); assert.equal(f.state.Account.paper.cash, '615'); done(); }); });
});

test('legacy shared tasks require no partition of wallet principal', function (_, done) {
  const f = fixture({ Account: { paper: { id: 'paper', initialCash: '1000', cash: '50', realized: '-10', fees: '2' } }, legacy: [{ id: wallet, active: true, positionCost: '600', realized: '-10', fees: '1' }, { id: other, active: true, positionCost: '600', realized: '0', fees: '1' }] });
  service(f).initialize(function (err) { assert.ifError(err); Object.values(f.state.FollowTask).forEach(function (row) { assert.equal(row.allocation, '1000'); assert.equal(row.cash, '0'); assert.equal(row.fundedCapital, '0'); }); assert.equal(f.state.Account.paper.cash, '50'); done(); });
});

test('multiple legacy shared tasks keep closed-position realized profit without reserving public cash', function (_, done) {
  const f = fixture({ Account: { paper: { id: 'paper', initialCash: '1000', cash: '550', realized: '-50', fees: '7' } }, legacy: [{ id: wallet, active: false, positionCost: '300', realized: '-100', fees: '5' }, { id: other, active: true, positionCost: '100', realized: '50', fees: '2' }] });
  service(f).initialize(function (err) { assert.ifError(err); const a = f.state.FollowTask[wallet], b = f.state.FollowTask[other]; assert.equal(a.allocation, '1000'); assert.equal(a.cash, '0'); assert.equal(a.realized, '-100'); assert.equal(b.allocation, '1000'); assert.equal(b.cash, '0'); assert.equal(b.realized, '50'); assert.equal(f.state.Account.paper.cash, '550'); done(); });
});

test('legacy balances with unmatched fees refuse partial initialization', function (_, done) {
  const f = fixture({ legacy: [{ id: wallet, active: true, positionCost: '0', realized: '0', fees: '1' }, { id: other, active: false, positionCost: '0', realized: '0', fees: '0' }] });
  service(f).initialize(function (err) { assert.ok(err); assert.equal(err.status, 409); assert.match(err.message, /手续费.*人工/); assert.deepEqual(f.state.FollowTask, {}); assert.deepEqual(f.state.Setting, {}); done(); });
});

test('a dedicated target may exceed current cash because targets are not transfers', function (_, done) {
  const f = fixture(); service(f).save(input({ allocation: '1001', fundingMode: 'dedicated' }), function (err, row) { assert.ifError(err); assert.equal(row.cash, '0'); assert.equal(row.allocation, '1001'); done(); });
});

test('setting a dedicated target to zero blocks buys without withdrawing its idle cash', function (_, done) {
  const f = fixture({ FollowTask: { [wallet]: { id: wallet, fundingMode: 'dedicated', cash: '500', fundedCapital: '500', state: 'paused', generation: 0 } } });
  service(f).save(input({ allocation: '0' }), function (err, row) { assert.ifError(err); assert.equal(row.cash, '500'); assert.equal(row.availableCash, '0'); assert.equal(row.fundedCapital, '500'); done(); });
});

test('empty initialization creates only a marker and list reads a single consistent SQL snapshot', function (_, done) {
  const f = fixture(), s = service(f);
  s.initialize(function (err, result) { assert.ifError(err); assert.equal(result.count, 0); assert.deepEqual(f.state.FollowTask, {}); assert.ok(f.state.Setting['follow-tasks-initialized']); f.state.queries = []; s.list(function (error, value) { assert.ifError(error); assert.equal(value.defaults.copyPercent, '100'); assert.equal(value.wallet.unallocatedCash, '1000'); assert.equal(f.state.queries.length, 1); assert.match(f.state.queries[0], /paper_positions/); assert.match(f.state.queries[0], /quantity>0/); done(); }); });
});

test('shared default tasks have overlapping caps without reserving any public cash', function (_, done) {
  const f = fixture(), s = service(f); async.eachSeries([wallet, other], function (id, next) { s.save(input({ wallet: id, allocation: '1000' }), function (err, row) { assert.ifError(err); assert.equal(row.fundingMode, 'shared'); assert.equal(row.cash, '0'); assert.equal(row.fundedCapital, '0'); assert.equal(row.availableCash, '1000'); next(); }); }, function (err) { assert.ifError(err); assert.equal(f.state.Account.paper.cash, '1000'); done(); });
});

test('raising a target does not add funds or schedule any refund', function (_, done) {
  const f = fixture({ FollowTask: { [wallet]: { id: wallet, fundingMode: 'dedicated', allocation: '200', fundedCapital: '500', cash: '0', state: 'paused', generation: 0, realized: '-10', fees: '1' } } });
  service(f).save(input({ allocation: '700' }), function (err, row) { assert.ifError(err); assert.equal(row.fundedCapital, '500'); assert.equal(row.cash, '0'); assert.equal(row.pendingRelease, undefined); assert.equal(f.state.Account.paper.cash, '1000'); done(); });
});

test('mode switch with open holdings is rejected without altering funds or generation', function (_, done) {
  const task = { id: wallet, fundingMode: 'dedicated', allocation: '500', fundedCapital: '500', cash: '100', state: 'running', generation: 4, realized: '0', fees: '0' };
  const f = fixture({ FollowTask: { [wallet]: task }, positions: [{ wallet, quantity: '10' }] });
  service(f).save(input({ fundingMode: 'shared' }), function (err) { assert.ok(err); assert.match(err.message, /未结算持仓.*切换/); assert.equal(f.state.FollowTask[wallet].generation, 4); assert.equal(f.state.FollowTask[wallet].cash, '100'); done(); });
});

test('mode switch requires manually withdrawing dedicated idle cash first', function (_, done) {
  const task = { id: wallet, fundingMode: 'dedicated', allocation: '500', fundedCapital: '500', cash: '510', state: 'running', generation: 4, realized: '10', fees: '0' };
  const f = fixture({ FollowTask: { [wallet]: task }, Leader: { [wallet]: { id: wallet, name: 'A', raw: {}, inventory: {} } }, outbox: [{ payload: { wallet, side: 'BUY' }, status: 'pending' }], orders: [{ wallet, side: 'BUY', status: 'WAITING', details: {} }] });
  service(f).save(input({ fundingMode: 'shared' }), function (err) { assert.ok(err); assert.equal(err.status, 409); assert.match(err.message, /手动转出/); assert.equal(f.state.FollowTask[wallet].cash, '510'); assert.equal(f.state.FollowTask[wallet].generation, 4); done(); });
});

test('shared available cash respects its own remaining exposure cap', function (_, done) {
  const f = fixture({ FollowTask: { [wallet]: { id: wallet, fundingMode: 'shared', allocation: '600', fundedCapital: '0', cash: '0', state: 'running', generation: 0, realized: '0', fees: '0' } }, positions: [{ wallet, quantity: '20', cost: '450' }] });
  service(f).save(input({ allocation: '500' }), function (err, row) { assert.ifError(err); assert.equal(row.availableCash, '50'); assert.equal(row.cash, '0'); assert.equal(f.state.Leader[wallet].raw.followFundingMode, 'shared'); done(); });
});
test('recreating a deleted wallet advances beyond its retired generation',function(_,done){const f=fixture({Setting:{['task-deletion:'+wallet]:{id:'task-deletion:'+wallet,value:{generation:8}}}});service(f).save(input(),function(err,row){assert.ifError(err);assert.equal(row.generation,9);assert.equal(f.state.Leader[wallet].raw.followGeneration,9);done();});});

test('explicit create rejects an existing normalized wallet without changing its configuration',(_,done)=>{const f=fixture(),s=service(f);s.save(input({operation:'create'}),(err,row)=>{assert.ifError(err);const before=structuredClone(f.state);s.save(input({operation:'create',wallet:wallet.toUpperCase().replace('0X','0x'),copyPercent:'200'}),err=>{assert.equal(err.status,409);assert.match(err.message,/已有跟单任务/);assert.deepEqual(f.state.FollowTask,before.FollowTask);assert.deepEqual(f.state.Leader,before.Leader);done();});});});
test('concurrent create requests for the same wallet allow only one success',(_,done)=>{const f=fixture(),s=service(f);async.parallel([1,2].map(n=>cb=>s.save(input({operation:'create',copyPercent:String(n)}),(err,row)=>cb(null,{err,row}))),(_,results)=>{assert.equal(results.filter(r=>!r.err).length,1);assert.equal(results.find(r=>r.err).err.status,409);assert.equal(Object.keys(f.state.FollowTask).length,1);done();});});
test('starting an already running wallet rejects without changing generation, inventory or waiting buys',(_,done)=>{const f=fixture({FollowTask:{[wallet]:{id:wallet,state:'paused',generation:1,cash:'0',allocation:'1000'}},Leader:{[wallet]:{id:wallet,name:'A',active:false,inventory:{},raw:{}}}}),s=service(f);s.control(wallet,{action:'start'},err=>{assert.ifError(err);f.state.Leader[wallet].inventory={token:'99'};f.state.orders.push({wallet,side:'BUY',status:'WAITING'});const before=structuredClone(f.state);s.control(wallet.toUpperCase().replace('0X','0x'),{action:'start'},err=>{assert.equal(err.status,409);assert.match(err.message,/正在跟单/);assert.deepEqual(f.state.FollowTask,before.FollowTask);assert.deepEqual(f.state.Leader,before.Leader);assert.deepEqual(f.state.orders,before.orders);done();});});});
