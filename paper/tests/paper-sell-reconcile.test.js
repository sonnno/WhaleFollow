const test=require('node:test'),assert=require('node:assert/strict'),async=require('async');
function fixture(){
 const cfg={...require('../config').paper,copySizing:'equal_amount'};
 const account={id:'paper',cash:'1000',fees:'0',realized:'0'};
 const tables={Order:new Map(),Position:new Map([['w:t',{id:'w:t',wallet:'w',token:'t',condition:'c',outcomeIndex:0,quantity:'100',cost:'50',realized:'0',cycleRealized:'0',cycle:1}]]),Fill:new Map(),Ledger:new Map(),Cycle:new Map()};
 const tx={query:function(sql,args,cb){if(sql.includes('paper_accounts'))return cb(null,[account]);if(sql.includes('clock_timestamp'))return cb(null,[{at:new Date()}]);const sold=[...tables.Order.values()].filter(x=>x.sourceId===args[0]&&x.side==='SELL'&&x.status==='FILLED');cb(null,[{saleBaseline:sold[0]&&sold[0].details.saleBaseline,soldQuantity:String(sold.reduce((s,x)=>s+Number(x.quantity),0))}]);},one:function(kind,q,cb){cb(null,kind==='Leader'?{active:true,joinedAt:new Date(0)}:tables[kind]&&tables[kind].get(q.where.id));},save:function(kind,row,cb){if(tables[kind])tables[kind].set(row.id,structuredClone(row));cb(null,row);},insert:function(kind,row,cb){tables[kind].set(row.id,structuredClone(row));cb(null,row);}};
 const paper=require('../server/service/paper-service').create({transaction:function(work,cb){work(tx,cb);}},{prepare:function(_,cb){cb(null,{metadata:{rate:'0',exponent:1},book:{asks:[{price:'0.5',size:'10000'}],bids:[{price:'0.5',size:'10000'}],observedAt:Date.now()}});},consume:function(){}});
 const base={wallet:'w',token:'t',condition:'c',outcomeIndex:0,timestamp:100,active:true,historical:false,config:cfg,price:'0.5'};
 return {paper,tables,base,account};
}
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
