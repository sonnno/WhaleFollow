const test=require('node:test'),assert=require('node:assert/strict'),async=require('async');
function fixture(){
 const cfg={...require('../config').paper,copySizing:'equal_amount'};
 const account={id:'paper',cash:'1000',fees:'0',realized:'0'};
 const tables={Order:new Map(),Position:new Map([['w:t',{id:'w:t',wallet:'w',token:'t',condition:'c',outcomeIndex:0,quantity:'100',cost:'50',realized:'0',cycleRealized:'0',cycle:1}]]),Fill:new Map(),Ledger:new Map(),Cycle:new Map()};
 let reads=0;
 const tx={query:function(sql,args,cb){
   if(sql.includes('paper-copy-commit')){const value=JSON.parse(args[0]),at=new Date();Object.assign(account,value.account);tables.Position.set(value.position.id,structuredClone(value.position));tables.Order.set(value.order.id,{...structuredClone(value.order),createdAt:at});value.fills.forEach(function(part){tables.Fill.set(part.id,{...part,orderId:value.order.id});});tables.Ledger.set('trade:'+value.order.id,{delta:value.delta,balance:account.cash});if(value.position.quantity==='0')tables.Cycle.set(value.position.id+':'+value.position.cycle,{});return cb(null,[{accountCount:1,orderCount:1,taskCount:value.task?1:0,positionCount:1,ledgerCount:1,fillCount:value.fills.length,at}]);}
   reads++;
   if(sql.includes('paper-copy-context')){const existing=tables.Order.get(args[0]);const claimed=existing?{...structuredClone(existing),inserted:false}:{id:args[0],wallet:args[1],token:args[2],condition:args[3],sourceId:args[4],side:args[6],status:'WAITING',details:{},inserted:true};const orders=[...tables.Order.values()].filter(function(x){return x.sourceId===args[4]&&['FILLED','PARTIAL'].includes(x.status);}),sold=orders.filter(function(x){return x.side==='SELL';});return cb(null,[{claimed,position:structuredClone(tables.Position.get(args[1]+':'+args[2])),leader:{id:args[1],active:true,joinedAt:new Date(0)},settings:{},task:null,job:null,market:null,spent:String(orders.filter(x=>x.side==='BUY').reduce((total,x)=>total+Number(x.gross)+Number(x.fee),0)),soldQuantity:String(sold.reduce((total,x)=>total+Number(x.quantity),0)),saleBaseline:sold[0]&&sold[0].details.saleBaseline,dedicatedCash:'0',positionCost:'0'}]);}
   if(sql.includes('paper_accounts'))return cb(null,[account]);
   throw new Error('Unexpected SQL '+sql);
 },one:function(kind,q,cb){reads++;cb(null,kind==='Leader'?{active:true,joinedAt:new Date(0)}:tables[kind]&&tables[kind].get(q.where.id));},save:function(kind,row,cb){if(tables[kind])tables[kind].set(row.id,structuredClone(row));cb(null,row);},insert:function(kind,row,cb){tables[kind].set(row.id,structuredClone(row));cb(null,row);}};
 const paper=require('../server/service/paper-service').create({transaction:function(work,cb){work(tx,cb);}},{prepare:function(_,cb){cb(null,{metadata:{rate:'0',exponent:1},book:{asks:[{price:'0.5',size:'10000'}],bids:[{price:'0.5',size:'10000'}],observedAt:Date.now()}});},consume:function(){}});
 const base={wallet:'w',token:'t',condition:'c',outcomeIndex:0,timestamp:100,active:true,historical:false,config:cfg,price:'0.5'};
 return {paper,tables,base,account,reads:function(){return reads;}};
}

test('successful copy needs at most two database context reads and duplicate order does not debit twice',function(_,done){
 const f=fixture(),signal={...f.base,id:'copy-once',sourceId:'source-once',side:'BUY',size:'20',sourceAmount:'10'};
 f.paper.copy(signal,function(err,r){assert.ifError(err);assert.equal(r.order.status,'FILLED');assert.ok(f.reads()<=2,'per-field database reads must be removed');const cash=f.account.cash;f.paper.copy(signal,function(error,duplicate){assert.ifError(error);assert.equal(duplicate.duplicate,true);assert.equal(f.account.cash,cash);done();});});
});
test('late extra SELL fills use the original inventory fraction, excluding later copied buys',function(_,done){
 const {paper,tables,base}=fixture();
 async.waterfall([
  cb=>paper.copy({...base,id:'sell1',sourceId:'sale',side:'SELL',size:'3',cumulativeSize:'3',beforeInventory:'100'},cb),
  (r,cb)=>{assert.equal(r.order.quantity,'3');paper.copy({...base,id:'later-buy',sourceId:'buy',side:'BUY',size:'100',price:'0.25',sourceAmount:'25'},cb);},
  (_,cb)=>paper.copy({...base,id:'sell2',sourceId:'sale',side:'SELL',size:'3',cumulativeSize:'6',beforeInventory:'197'},cb)
 ],function(e,r){assert.ifError(e);assert.equal(r.order.quantity,'3');assert.equal(tables.Position.get('w:t').quantity,'144');done();});
});

test('a fully satisfied original sale cannot retry forever or sell later additions',function(_,done){
 const {paper,tables,base,account}=fixture();tables.Order.set('old',{id:'old',sourceId:'sale',side:'SELL',status:'FILLED',quantity:'100',details:{saleBaseline:{leaderQuantity:'100',ownQuantity:'100',positionCycle:1}}});
 paper.copy({...base,id:'extra',sourceId:'sale',side:'SELL',size:'50',cumulativeSize:'150',beforeInventory:'100'},function(e,r){assert.ifError(e);assert.equal(r.retry,false);assert.equal(r.order.status,'SKIPPED');assert.equal(r.order.reason,'SOURCE_SELL_ALREADY_SATISFIED');assert.equal(tables.Position.get('w:t').quantity,'100');assert.equal(account.cash,'1000');done();});
});
test('first executable sale excludes earlier source quantity skipped during pause',function(_,done){
 const {paper,base}=fixture();paper.copy({...base,id:'paused-sale',sourceId:'sale',side:'SELL',size:'3',cumulativeSize:'3',beforeInventory:'100',pausedAtDiscovery:true},function(e,r){assert.ifError(e);assert.equal(r.order.reason,'PAUSED_AT_DISCOVERY');paper.copy({...base,id:'new-sale',sourceId:'sale',side:'SELL',size:'3',cumulativeSize:'6',beforeInventory:'97'},function(err,result){assert.ifError(err);assert.equal(result.order.quantity,'3.092783505154639175');assert.equal(result.order.details.saleBaseline.sourceOffset,'3');done();});});
});
