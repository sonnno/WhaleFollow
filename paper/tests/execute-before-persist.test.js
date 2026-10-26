const test = require('node:test'), assert = require('node:assert/strict');
const store = require('../server/service/paper-copy-store');
const { D, str } = require('../server/service/accounting-service');
function fixture(t, matchRatios) {
  const events = [], orders = [], account = { id: 'paper', cash: '100', fees: '0', realized: '0' };
  const task = { id: 'w', createdAt: new Date(0), generation: 1, state: 'running', fundingMode: 'dedicated', cash: '60', allocation: '60', copyPercent: '10', maxOrderAmount: null, startedAt: new Date(0) };
  const leader = { id: 'w', active: true, joinedAt: new Date(0) };
  const control = { account, task, leader, settings: {}, sharedCash: '40', positionCost: '0', positions: {} };
  const controls = { observe: function () {}, get: function () { return structuredClone(control); }, reserve: function (_, fill) { events.push('reserve'); account.cash = str(D(account.cash).minus(fill.cash)); task.cash = str(D(task.cash).minus(fill.cash)); }, complete: function () {}, invalidate: function () {}, refresh: function (cb) { cb(); } };
  t.mock.method(store, 'read', function (_, signal, cb) { events.push('read'); cb(null, { account: { id: 'paper', cash: '100', fees: '0', realized: '0' }, task: { ...task, cash: '60' }, leader, settings: {}, sharedCash: '40', positionCost: '0', claimed: { ...signal, inserted: true }, position: null, market: null }); });
  t.mock.method(store, 'commit', function (_, __, ___, ____, order, fill, cb) { events.push('commit'); orders.push(order); cb(null, order); });
  const tx = { save: function (_, row, cb) { orders.push(row); cb(null, row); }, query: function (sql, args, cb) { if (sql.includes('INSERT INTO paper_match_ratios')) return cb(null, [{copyPercent:JSON.parse(args[0])[0].copyPercent}]); cb(null, []); } };
  const db = { query: function (_, args, cb) { orders.push({ id: args[0], details: JSON.parse(args[8]) }); cb(null, []); }, transaction: function (work, cb) { events.push('transaction'); work(tx, cb); }, save: function (_, row, cb) { orders.push(row); cb(null, row); } };
  const markets = { prepare: function (_, cb) { events.push('prepare'); cb(null, { outcomeIndex: 0, metadata: { rate: '0', exponent: 1 }, book: { asks: [{ price: '0.5', size: '100' }], bids: [{ price: '0.5', size: '100' }] } }); }, consume: function () { events.push('executed'); } };
  const signal = { id: 'o', sourceId: 's', wallet: 'w', token: 't', condition: 'c', side: 'BUY', outcomeIndex: 0, timestamp: 100, price: '0.5', size: '20', sourceAmount: '10', followGeneration: 1, active: true, config: {} };
  const warnings = { mark: function (signal, state, required, cb) { events.push('balance-warning'); cb(); }, event: function () { return []; }, write: function (_, __, cb) { events.push('balance-clear'); cb(); } };
  const paper = require('../server/service/paper-service').create(db, markets, { controls, warnings, matchRatios });
  return { events, orders, db, tx, markets, controls, signal, paper, warnings, task };
}

test('realistic tiny buys skip before quote work or SQL and record only aggregate reasons', function (t, done) {
  const f = fixture(t), get = f.controls.get, recorded = [];
  f.controls.get = function () { return { ...get(), task: { ...get().task, realisticExecution: true } }; };
  const paper = require('../server/service/paper-service').create(f.db, f.markets, { controls: f.controls, skips: { record(...args) { recorded.push(args); } } });
  paper.copy({ ...f.signal, sourceAmount: '1' }, function (err, result) {
    assert.ifError(err); assert.equal(result.order, null); assert.equal(result.reason, 'BELOW_MIN_BUY_AMOUNT');
    assert.equal(f.events.includes('prepare'), false); assert.equal(f.events.includes('transaction'), false); assert.equal(recorded.length, 1); done();
  });
});
test('a cold sports cache continues the same live signal after policy loads', function (t, done) {
  const f = fixture(t), get = f.controls.get; let warmed = 0, market = null;
  f.controls.get = function () { return { ...get(), task: { ...get().task, shortSportsHours: 72 } }; };
  f.markets.policyMarket = function () { return market; };
  f.markets.ensurePolicy = function (_, cb) { warmed++; setImmediate(function () { market = { gameStartTime: new Date(Date.now()+3600000).toISOString(), sportsMarketType:'moneyline', active:true, acceptingOrders:true, closed:false }; cb(); }); };
  f.paper.copy(f.signal, function (err, result) {
    assert.ifError(err); assert.equal(result.order.status, 'FILLED');
    assert.equal(warmed, 1); assert.equal(result.attempts, undefined); assert.equal(f.events.filter(x=>x==='executed').length, 1); done();
  });
});

test('a pause while sports metadata loads prevents the pending live buy', function (t, done) {
  const f=fixture(t),get=f.controls.get;let paused=false,market=null;
  f.controls.get=()=>({...get(),settings:{pauseBuys:paused},task:{...get().task,shortSportsHours:72}});
  f.markets.policyMarket=()=>market;
  f.markets.ensurePolicy=(_,cb)=>{paused=true;market={gameStartTime:new Date(Date.now()+3600000).toISOString(),sportsMarketType:'moneyline',active:true,acceptingOrders:true,closed:false};cb();};
  f.paper.copy(f.signal,(err,result)=>{assert.ifError(err);assert.equal(result.fill,null);assert.equal(f.events.includes('executed'),false);done();});
});

test('sports metadata failures stop after three attempts and never execute', function(t,done){
 const f=fixture(t),get=f.controls.get;let attempts=0;
 f.controls.get=()=>({...get(),task:{...get().task,shortSportsHours:72}});f.markets.policyMarket=()=>null;
 f.markets.ensurePolicy=(_,cb)=>{attempts++;cb(Error('metadata offline'));};
 f.paper.copy(f.signal,(err,result)=>{assert.ifError(err);assert.equal(result.reason,'SPORTS_METADATA_MISSING');assert.equal(attempts,3);assert.equal(f.events.includes('executed'),false);done();});
});

test('tiny realistic sports buys do not load metadata',function(t,done){
 const f=fixture(t),get=f.controls.get;f.controls.get=()=>({...get(),task:{...get().task,shortSportsHours:72,realisticExecution:true}});f.markets.policyMarket=()=>null;f.markets.ensurePolicy=()=>assert.fail('Tiny buy must not request metadata');
 f.paper.copy({...f.signal,sourceAmount:'1'},(err,result)=>{assert.ifError(err);assert.equal(result.reason,'BELOW_MIN_BUY_AMOUNT');done();});
});

test('a warm sports policy keeps the fast path and a loaded long event is still rejected',function(t,done){
 const f=fixture(t),get=f.controls.get;f.controls.get=()=>({...get(),task:{...get().task,shortSportsHours:72}});let market={gameStartTime:new Date(Date.now()+3600000).toISOString(),sportsMarketType:'moneyline',active:true,acceptingOrders:true,closed:false};
 f.markets.policyMarket=()=>market;f.markets.ensurePolicy=()=>assert.fail('Warm policy must not request anything');
 f.paper.copy(f.signal,(err,result)=>{assert.ifError(err);assert.equal(result.order.status,'FILLED');market=null;f.markets.ensurePolicy=(_,cb)=>{market={gameStartTime:new Date(Date.now()+100*3600000).toISOString(),sportsMarketType:'moneyline',active:true,acceptingOrders:true,closed:false};cb();};
 f.paper.copy({...f.signal,id:'new'},(error,value)=>{assert.ifError(error);assert.equal(value.reason,'SPORTS_TOO_FAR');assert.equal(f.events.filter(x=>x==='executed').length,1);done();});});
});

test('policy expiring during quote preparation reloads instead of dropping the signal',function(t,done){
 const f=fixture(t),get=f.controls.get,prepare=f.markets.prepare;let ready={gameStartTime:new Date(Date.now()+3600000).toISOString(),sportsMarketType:'moneyline',active:true,acceptingOrders:true,closed:false},market=ready,warmed=0,first=true;
 f.controls.get=()=>({...get(),task:{...get().task,shortSportsHours:72}});f.markets.policyMarket=()=>market;
 f.markets.prepare=(signal,cb)=>{if(first){first=false;market=null;}prepare(signal,cb);};
 f.markets.ensurePolicy=(_,cb)=>{warmed++;market=ready;cb();};
 f.paper.copy(f.signal,(err,result)=>{assert.ifError(err);assert.equal(result.order.status,'FILLED');assert.equal(warmed,1);assert.equal(f.events.filter(x=>x==='executed').length,1);done();});
});
test('realistic share failures cannot consume the book or create orders', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { return { ...get(), task: { ...get().task, realisticExecution: true } }; };
  f.markets.prepare = function (_, cb) { cb(null, { outcomeIndex: 0, metadata: { rate: '0', exponent: 1, tick: '0.01', minSize: '5' }, book: { asks: [{ price: '0.5', size: '100' }] } }); };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order, null); assert.equal(result.reason, 'BELOW_MIN_ORDER_SHARES'); assert.equal(result.attempts, 1); assert.equal(f.events.includes('executed'), false); assert.equal(f.events.includes('transaction'), false); done(); });
});
test('realistic amount above an order cap skips whole fill instead of resizing it', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { return { ...get(), task: { ...get().task, realisticExecution: true, maxOrderAmount: '0.5' } }; };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order, null); assert.equal(result.reason, 'ORDER_LIMIT_EXCEEDED'); assert.equal(f.events.includes('prepare'), false); done(); });
});
test('fee-inclusive realistic cap refusal is counted once without resizing or retry', function (t, done) {
  const f = fixture(t), get = f.controls.get; let prepared = 0;
  f.controls.get = function () { return { ...get(), task: { ...get().task, realisticExecution: true, maxOrderAmount: '1' } }; };
  f.markets.prepare = function (_, cb) { prepared++; cb(null, { outcomeIndex: 0, metadata: { rate: '0.1', exponent: 1, tick: '0.01', minSize: '1' }, book: { asks: [{ price: '0.5', size: '100' }] } }); };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order, null); assert.equal(result.reason, 'ORDER_LIMIT_EXCEEDED'); assert.equal(prepared, 1); assert.equal(f.events.includes('executed'), false); done(); });
});
test('fill and local balance reservation happen before the first database operation', function (t, done) {
  const f = fixture(t);
  f.paper.copy(f.signal, function (err, result) {
    assert.ifError(err); assert.equal(result.order.gross, '1');
    assert.ok(f.events.indexOf('executed') < f.events.indexOf('transaction'), f.events.join(','));
    assert.ok(f.events.indexOf('reserve') < f.events.indexOf('transaction'));
    done();
  });
});
test('source reduction fraction sells our fraction before SQL, despite different buy coverage',function(t,done){
 const f=fixture(t),get=f.controls.get;
 f.controls.get=()=>({...get(),positions:{t:{quantity:'20'}},task:{...get().task,copyPercent:'1'}});
 t.mock.method(store,'read',(_,signal,cb)=>{f.events.push('read');cb(null,{claimed:{...signal,inserted:true},account:{cash:'100',fees:'0',realized:'0'},task:{...f.task,copyPercent:'1'},position:{id:'w:t',quantity:'20',cost:'8',realized:'0',cycleRealized:'0',cycle:1}});});
 f.paper.copy({...f.signal,side:'SELL',size:'30',saleSizing:{mode:'leader_fraction',wallet:'w',token:'t',before:'100',sold:'30',after:'70',fraction:'0.3'}},(error,result)=>{
  assert.ifError(error);assert.equal(result.fill.quantity,'6');assert.equal(result.order.details.saleSizing.quantity,'6');assert.equal(result.order.details.saleSizing.mode,'leader_fraction');
  assert.ok(f.events.indexOf('executed')<f.events.indexOf('transaction'));done();
 });
});
test('source all-out exit requests all our sellable holdings and leaves actual precision dust',function(t,done){
 const f=fixture(t),get=f.controls.get;f.controls.get=()=>({...get(),positions:{t:{quantity:'10.123456'}},task:{...get().task,realisticExecution:true,copyPercent:'1'}});
 f.markets.prepare=(_,cb)=>cb(null,{outcomeIndex:0,metadata:{rate:'0',exponent:1,tick:'0.01',minSize:'5'},book:{asks:[],bids:[{price:'0.5',size:'100'}]}});
 t.mock.method(store,'read',(_,signal,cb)=>cb(null,{claimed:{...signal,inserted:true},account:{cash:'100',fees:'0',realized:'0'},task:{...f.task,realisticExecution:true},position:{id:'w:t',quantity:'10.123456',cost:'4',realized:'0',cycleRealized:'0',cycle:1}}));
 f.paper.copy({...f.signal,side:'SELL',size:'30',saleSizing:{mode:'leader_fraction',wallet:'w',token:'t',before:'30',sold:'30',after:'0',fraction:'1'}},(err,result)=>{assert.ifError(err);assert.equal(result.fill.quantity,'10.12');assert.equal(result.order.details.saleSizing.quantity,'10.123456');done();});
});
test('minimum-share sell refusals retain requested sale sizing without creating financial orders',function(t,done){
 const f=fixture(t),get=f.controls.get;f.controls.get=()=>({...get(),positions:{t:{quantity:'4'}},task:{...get().task,realisticExecution:true}});
 f.markets.prepare=(_,cb)=>cb(null,{outcomeIndex:0,metadata:{rate:'0',exponent:1,tick:'0.01',minSize:'5'},book:{asks:[],bids:[{price:'0.5',size:'100'}]}});
 f.paper.copy({...f.signal,side:'SELL',size:'30',saleSizing:{mode:'leader_fraction',wallet:'w',token:'t',before:'30',sold:'30',fraction:'1'}},(error,result)=>{assert.ifError(error);assert.equal(result.reason,'BELOW_MIN_ORDER_SHARES');assert.equal(result.saleSizing.quantity,'4');assert.equal(result.order,null);assert.equal(f.events.includes('reserve'),false);done();});
});
test('three failed attempts end permanently, with no WAITING result', function (t, done) {
  const f = fixture(t); let attempts = 0;
  f.markets.prepare = function (_, cb) { attempts++; cb(new Error('No executable book')); };
  f.paper.copy(f.signal, function (err, result) {
    assert.ifError(err); assert.equal(attempts, 3); assert.equal(result.retry, false);
    assert.equal(result.order.status, 'SKIPPED'); assert.equal(result.order.details.attempts, 3);
    assert.equal(f.events.includes('read'), false); done();
  });
});
test('failure followed by success stops immediately, and success is executed once', function (t, done) {
  const f = fixture(t), prepare = f.markets.prepare; let attempts = 0;
  f.markets.prepare = function (signal, cb) { if (++attempts === 1) return cb(new Error('Temporary failure')); prepare(signal, cb); };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.ok(result.fill); assert.equal(attempts, 2); assert.equal(f.events.filter(function (x) { return x === 'executed'; }).length, 1); done(); });
});
test('persistence failure never executes the successful purchase again', function (t, done) {
  const f = fixture(t);
  t.mock.method(store, 'commit', function (_, __, ___, ____, _____, ______, cb) { cb(new Error('Ledger failure')); });
  f.paper.copy(f.signal, function (err) { assert.match(err.message, /Ledger failure/); assert.equal(f.events.filter(function (x) { return x === 'executed'; }).length, 1); done(); });
});
test('pause is read in memory, without accessing trade database context', function (t, done) {
  const f = fixture(t); f.controls.get = function () { return { ...fixtureControl(), settings: { pauseBuys: true } }; };
  function fixtureControl() { return { leader: { active: true }, task: { state: 'running', generation: 1, startedAt: new Date(0) } }; }
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order.reason, 'BUYS_PAUSED'); assert.equal(f.events.includes('read'), false); done(); });
});

test('a generation change cannot move an executed fill into another task generation', function (t, done) {
  const f = fixture(t); let reads = 0;
  t.mock.method(store, 'read', function (_, signal, cb) { reads++; cb(null, { claimed: { inserted: true }, account: { cash: '100' }, task: { id: 'w', generation: 2, fundingMode: 'dedicated' } }); });
  f.paper.copy(f.signal, function (err) { assert.match(err.message, /generation changed/); assert.equal(reads, 3); assert.equal(err.executedOrder.order.details.followTask.generation, 1); assert.equal(f.events.filter(function (x) { return x === 'executed'; }).length, 1); done(); });
});

test('the final memory book overrides a previously prepared snapshot', function (t, done) {
  const f = fixture(t);
  f.markets.latestQuote = function () { return { outcomeIndex: 0, metadata: { rate: '0', exponent: 1 }, book: { asks: [{ price: '0.5', size: '1' }] } }; };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order.quantity, '1'); assert.equal(result.order.status, 'PARTIAL'); assert.equal(result.retry, false); done(); });
});

test('a settled position during SELL persistence reports an error instead of throwing from an asynchronous callback', function (t, done) {
  const f = fixture(t);
  f.controls.get = function () { return { leader: { active: true }, task: { id: 'w', generation: 1, fundingMode: 'dedicated', copyPercent: '100', state: 'running', startedAt: new Date(0) }, account: { cash: '100' }, settings: {}, positions: { t: { quantity: '10' } } }; };
  t.mock.method(store, 'read', function (_, signal, cb) { setImmediate(function () { cb(null, { claimed: { inserted: true }, account: { cash: '100' }, task: { id: 'w', generation: 1, fundingMode: 'dedicated' }, position: { quantity: '0', cost: '0', realized: '0', cycleRealized: '0' } }); }); });
  f.paper.copy({ ...f.signal, side: 'SELL', size: '5' }, function (err) { assert.match(err.message, /Invalid sale quantity/); assert.ok(err.executedOrder); done(); });
});

test('insufficient cash marks the wallet but never creates an order or a financial transaction', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.cash = '0'; return state; };
  let marked = 0;
  f.warnings.mark = function (signal, state, required, cb) { marked++; assert.equal(state.task.id, 'w'); assert.ok(D(required).gt(0)); cb(); };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.insufficientFunds, true); assert.equal(result.order, null); assert.equal(marked, 1); assert.equal(f.events.includes('transaction'), false); assert.equal(f.events.includes('executed'), false); done(); });
});

test('cash below the required amount does not produce a partial affordable order', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.cash = '0.5'; return state; };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.insufficientFunds, true); assert.equal(result.order, null); assert.equal(f.events.includes('executed'), false); done(); });
});

test('successful execution clears balance warnings in the same transaction as its accounting', function (t, done) {
  const f = fixture(t);
  f.paper.copy(f.signal, function (err) { assert.ifError(err); assert.ok(f.events.indexOf('balance-clear') > f.events.indexOf('commit')); done(); });
});

test('cash covering the gross but not the fee creates no order', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.cash = '1'; return state; };
  f.markets.prepare = function (_, cb) { cb(null, { outcomeIndex: 0, metadata: { rate: '0.1', exponent: 1 }, book: { asks: [{ price: '0.5', size: '100' }] } }); };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order, null); assert.equal(result.insufficientFunds, true); assert.equal(f.events.includes('transaction'), false); done(); });
});

test('an insufficient-cash precision failure still cannot generate an order', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.cash = '0.000000000000000001'; state.task.maxOrderAmount = '0.000000000000000001'; return state; };
  f.markets.prepare = function (_, cb) { cb(null, { outcomeIndex: 0, metadata: { rate: '0', exponent: 1 }, book: { asks: [{ price: '0.8', size: '100' }] } }); };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order, null); assert.equal(result.insufficientFunds, true); assert.equal(f.events.includes('transaction'), false); done(); });
});

test('a configured per-order cap is retained without a false shortage warning', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.cash = '0.5'; state.task.maxOrderAmount = '0.5'; return state; };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order.gross, '0.5'); assert.equal(f.events.includes('balance-warning'), false); done(); });
});

test('a tiny per-order cap cannot falsely mark a funded wallet as insufficient', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.maxOrderAmount = '0.000000000000000001'; return state; };
  f.markets.prepare = function (_, cb) { cb(null, { outcomeIndex: 0, metadata: { rate: '0', exponent: 1 }, book: { asks: [{ price: '0.8', size: '100' }] } }); };
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.order, null); assert.equal(result.reason, 'ORDER_AMOUNT_BELOW_PRECISION'); assert.equal(f.events.includes('balance-warning'), false); done(); });
});

test('partial source fills use already spent money before consuming the book', function (t, done) {
  const f = fixture(t), get = f.controls.get;
  f.controls.get = function () { const state = get(); state.task.maxOrderAmount = '1'; state.sourceSpending = { s: '0.8' }; return state; };
  t.mock.method(store, 'read', function (_, signal, cb) { const state = f.controls.get(); cb(null, { ...state, account: { cash: '100', fees: '0', realized: '0' }, spent: '0.8', claimed: { inserted: true } }); });
  f.paper.copy(f.signal, function (err, result) { assert.ifError(err); assert.equal(result.fill.cash, '0.2'); assert.equal(f.events.filter(x => x === 'executed').length, 1); done(); });
});

test('pauseAll set during SELL preparation prevents consumption and accounting', function (t, done) {
  const f = fixture(t), get = f.controls.get, prepare = f.markets.prepare; let paused = false;
  f.controls.get = function () { const state = get(); state.settings.pauseAll = paused; state.positions = { t: { quantity: '10', cost: '5' } }; return state; };
  f.markets.prepare = function (signal, cb) { paused = true; prepare(signal, cb); };
  f.paper.copy({ ...f.signal, side: 'SELL' }, function (err, result) { assert.ifError(err); assert.equal(result.fill, null); assert.equal(f.events.includes('executed'), false); assert.equal(f.events.includes('commit'), false); done(); });
});

test('recording an executed receipt never asks for a price or executes a second purchase', function (t, done) {
  const f = fixture(t);
  f.paper.copy(f.signal, function (err, result) {
    assert.ifError(err); const receipt = { order: result.order, fill: result.fill }; f.events.length = 0;
    f.paper.recordExecuted(receipt, function (error) { assert.ifError(error); assert.equal(f.events.includes('executed'), false); assert.equal(f.events.includes('prepare'), false); assert.ok(f.events.includes('commit')); done(); });
  });
});

test('an executed receipt replaces an unaccounted SKIPPED row instead of being discarded', function (t, done) {
  const f = fixture(t);
  f.paper.copy(f.signal, function (err, result) {
    assert.ifError(err); const receipt = { order: result.order, fill: result.fill }, read = store.read; f.events.length = 0;
    t.mock.method(store, 'read', function (tx, signal, cb) { read(tx, signal, function (error, context) { context.claimed = { inserted: false, status: 'SKIPPED', quantity: '0', gross: '0', fee: '0' }; cb(error, context); }); });
    f.paper.recordExecuted(receipt, function (error) { assert.ifError(error); assert.equal(f.events.filter(x => x === 'commit').length, 1); assert.equal(f.events.includes('executed'), false); done(); });
  });
});
test('a duplicate recovery requires matching recorded amounts and cash ledger', function (t, done) {
  const f = fixture(t);
  f.paper.copy(f.signal, function (err, result) {
    assert.ifError(err); const receipt = { order: result.order, fill: result.fill }, read = store.read; let ledger;
    t.mock.method(store, 'read', function (tx, signal, cb) { read(tx, signal, function (error, context) { context.claimed = { ...receipt.order, inserted: false }; context.tradeLedger = ledger; cb(error, context); }); });
    f.paper.recordExecuted(receipt, function (error) {
      assert.match(error.message, /accounting/); ledger = { delta: str(D(receipt.fill.cash).negated()) };
      f.paper.recordExecuted(receipt, function (issue, value) { assert.ifError(issue); assert.equal(value.duplicate, true); done(); });
    });
  });
});

test('empty depth retries with a fresh book before recording a successful buy', function (t, done) {
  const f = fixture(t), requests = [];
  f.signal.feed = { type: 'orders_matched', publishedAt: '2026-10-16T09:00:00.100Z' };
  f.markets.prepare = function (signal, cb) {
    requests.push(signal.refreshBook === true);
    cb(null, { outcomeIndex: 0, quoteSource: signal.refreshBook ? 'book-refresh' : 'websocket-cache', metadata: { rate: '0', exponent: 1 }, book: { hash: signal.refreshBook ? 'fresh' : 'empty', observedAt: Date.now(), asks: signal.refreshBook ? [{ price: '0.5', size: '100' }] : [], bids: [] } });
  };
  f.paper.copy(f.signal, function (err, result) {
    assert.ifError(err); assert.ok(result.fill); assert.deepEqual(requests, [false, true]);
    assert.equal(result.order.details.executionAttempts.length, 2);
    assert.equal(result.order.details.executionAttempts[0].error, 'NO_EXECUTABLE_DEPTH');
    assert.equal(result.order.details.executionAttempts[0].book.executableLevels, 0);
    assert.equal(result.order.details.timings.feed.type, 'orders_matched');
    assert.equal(f.events.filter(x => x === 'executed').length, 1); done();
  });
});

test('three empty books end without an order queue and preserve all failed quote evidence', function (t, done) {
  const f = fixture(t), requests = [];
  f.markets.prepare = function (signal, cb) { requests.push(signal.refreshBook === true); cb(null, { outcomeIndex: 0, quoteSource: 'book-refresh', metadata: { rate: '0', exponent: 1 }, book: { hash: 'empty-' + requests.length, asks: [], bids: [] } }); };
  f.paper.copy(f.signal, function (err, result) {
    assert.ifError(err); assert.deepEqual(requests, [false, true, true]); assert.equal(result.order.status, 'SKIPPED'); assert.equal(result.retry, false);
    assert.equal(result.order.details.executionAttempts.length, 3);
    assert.equal(result.order.details.executionAttempts[2].book.hash, 'empty-3');
    assert.equal(f.events.includes('executed'), false); done();
  });
});


test('successful trades use the original match ratio across markets after settings change, with no pre-fill SQL', function (t, done) {
  const ratios = require('../server/service/match-ratio-service').create({}, {}), f = fixture(t, ratios);
  f.signal.raw = [{event_slug:'a-b-2026-10-19'}];
  f.paper.copy(f.signal, function (err, first) {
    assert.ifError(err); assert.equal(first.order.gross, '1');
    assert.equal(first.order.details.matchRatio.copyPercent, '10');
    f.task.copyPercent = '20'; f.events.length = 0;
    const second = {...f.signal,id:'second',sourceId:'s2',token:'totals',condition:'c2',raw:[{event_slug:'a-b-2026-10-19-more-markets'}]};
    f.paper.copy(second, function (error, next) {
      assert.ifError(error); assert.equal(next.order.gross, '1');
      assert.equal(next.order.details.followTask.copyPercent, '10');
      assert.equal(next.order.details.configuredCopyPercent, '20');
      assert.equal(next.order.details.matchRatio.firstOrderId, 'o');
      assert.ok(f.events.indexOf('executed') < f.events.indexOf('transaction'));
      f.paper.copy({...second,id:'third',sourceId:'s3',raw:[{event_slug:'different-game'}]}, function (issue, fresh) {
        assert.ifError(issue); assert.equal(fresh.order.gross, '2'); assert.equal(fresh.order.details.matchRatio.copyPercent, '20'); done();
      });
    });
  });
});

test('a failed first buy does not freeze the percentage for the next successful buy', function (t, done) {
  const ratios = require('../server/service/match-ratio-service').create({}, {}), f = fixture(t, ratios), prepare = f.markets.prepare;
  f.signal.raw = [{event_slug:'game-a'}];
  f.markets.prepare = function (_, cb) { cb(new Error('No executable book')); };
  f.paper.copy(f.signal, function (err, failed) {
    assert.ifError(err); assert.equal(failed.order.status, 'SKIPPED');
    f.task.copyPercent = '20'; f.markets.prepare = prepare;
    f.paper.copy({...f.signal,id:'success',sourceId:'next'}, function (error, result) {
      assert.ifError(error); assert.equal(result.order.gross, '2'); assert.equal(result.order.details.matchRatio.firstOrderId, 'success'); done();
    });
  });
});

test('concurrent market preparations use the ratio of the first actual successful fill', function (t, done) {
  const ratios = require('../server/service/match-ratio-service').create({}, {}), f = fixture(t, ratios), prepare = f.markets.prepare, waiting = [];
  f.signal.raw = [{event_slug:'game-a'}];
  f.markets.prepare = function (s, cb) { waiting.push(function () { prepare(s, cb); }); };
  let completed = 0;
  function copied(err, result) {
    assert.ifError(err); assert.equal(result.order.gross, '2'); assert.equal(result.order.details.matchRatio.copyPercent, '20');
    if (++completed === 2) done();
  }
  f.paper.copy(f.signal, copied);
  f.task.copyPercent = '20';
  f.paper.copy({...f.signal,id:'second',sourceId:'second',condition:'totals'}, copied);
  waiting[1](); f.task.copyPercent = '30'; waiting[0]();
});

test('smart pause buys retained matches across markets but ignores new matches without SQL or an order',function(t,done){const ratios=require('../server/service/match-ratio-service').create({},{}),f=fixture(t,ratios);f.task.smartPause={id:'pause',events:['game-a']};f.signal.raw=[{event_slug:'game-a-more-markets'}];f.paper.copy(f.signal,function(err,result){assert.ifError(err);assert.ok(result.fill);assert.equal(result.order.details.followTask.smartPauseId,'pause');f.events.length=0;f.paper.copy({...f.signal,id:'new',raw:[{event_slug:'game-b'}]},function(error,skipped){assert.ifError(error);assert.equal(skipped.reason,'SMART_PAUSE_NEW_EVENT');assert.equal(skipped.order,null);assert.equal(f.events.includes('prepare'),false);assert.equal(f.events.includes('transaction'),false);done();});});});
test('smart pause arriving during quote preparation blocks a new event before execution',function(t,done){const ratios=require('../server/service/match-ratio-service').create({},{}),f=fixture(t,ratios),prepare=f.markets.prepare;let release,preparations=0;f.signal.raw=[{event_slug:'new-game'}];f.markets.prepare=function(s,cb){preparations++;release=()=>prepare(s,cb);};f.paper.copy(f.signal,function(err,result){assert.ifError(err);assert.equal(result.reason,'SMART_PAUSE_NEW_EVENT');assert.equal(result.order,null);assert.equal(f.events.includes('executed'),false);assert.equal(preparations,1);done();});f.task.smartPause={id:'pause',events:['old-game']};release();});
test('a fill already executed before smart pause is included while recording its receipt, without re-buying',function(t,done){const ratios=require('../server/service/match-ratio-service').create({},{}),f=fixture(t,ratios),read=store.read,query=f.tx.query;f.signal.raw=[{event_slug:'inflight-game'}];let included=0;t.mock.method(store,'read',function(tx,s,cb){read(tx,s,function(err,context){context.task.smartPause={id:'pause',events:[]};cb(err,context);});});t.mock.method(f.tx,'query',function(sql,args,cb){if(sql.startsWith('UPDATE paper_follow_tasks SET "smartPause"')){included++;assert.deepEqual(args,['w','pause','inflight-game']);return cb(null,[]);}query(sql,args,cb);});f.paper.copy(f.signal,function(err,result){assert.ifError(err);assert.ok(result.fill);assert.equal(included,1);assert.equal(f.events.filter(e=>e==='executed').length,1);assert.ok(f.events.indexOf('executed')<f.events.indexOf('transaction'));done();});});

test('full pause after an actual fill cannot discard its accounting for the same task instance',function(t,done){const f=fixture(t),read=store.read;t.mock.method(store,'read',function(tx,s,cb){read(tx,s,function(err,context){context.task.state='paused';context.task.generation++;cb(err,context);});});f.paper.copy(f.signal,function(err,result){assert.ifError(err);assert.ok(result.fill);assert.equal(f.events.filter(e=>e==='executed').length,1);done();});});
