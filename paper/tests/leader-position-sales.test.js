const test=require('node:test'),assert=require('node:assert/strict');
const service=require('../server/service/leader-position-sale-service');
const wallet='0x'+'a'.repeat(40),other='0x'+'b'.repeat(40),task={generation:1,createdAt:'2026-01-01T00:00:00Z'};
function fixture(rows){
 let now=1000000,read,setting={wallets:[wallet]},calls=0;
 const controls={peek:()=>({task})};
 const db={one:(_,query,cb)=>cb(null,{value:setting})};
 const http={pages:(_,route,params,cb)=>{calls++;assert.equal(route,'/v2/positions');assert.equal(params.user,wallet);read=cb;if(rows)cb(null,rows);}};
 const tracker=service.create(db,{http,controls,now:()=>now});
 const refresh=()=>new Promise((resolve,reject)=>tracker.refresh(e=>e?reject(e):resolve()));
 const signal=(side,size,timestamp=1001,token='1')=>({wallet,token,side,size:String(size),timestamp});
 return{tracker,refresh,signal,advance:ms=>{now+=ms;},read:(error,data)=>read(error,data),calls:()=>calls,setSetting:v=>{setting=v;}};
}
test('source partial and full sells use fractions of its before-sale inventory',async()=>{
 const f=fixture([{token_id:'1',current_size:'100'}]);await f.refresh();
 const a=f.tracker.observe(f.signal('SELL',30),task);assert.equal(a.mode,'leader_fraction');assert.equal(a.fraction,'0.3');assert.equal(a.before,'100');assert.equal(a.after,'70');
 const b=f.tracker.observe(f.signal('SELL',70,1002),task);assert.equal(b.fraction,'1');assert.equal(b.after,'0');
 assert.deepEqual(service.size({...f.signal('SELL',30),saleSizing:a},'20','0.0001').quantity,'6');
 assert.equal(service.size({...f.signal('SELL',70,1002),saleSizing:b},'19.876543','0.0001').quantity,'19.876543');
});
test('small buys and buys that we do not copy still advance source inventory, without reads',async()=>{
 const f=fixture([{token_id:'1',current_size:'100'}]);await f.refresh();const count=f.calls();
 f.tracker.observe(f.signal('BUY',50),task);const s=f.tracker.observe(f.signal('SELL',30,1002),task);
 assert.equal(s.before,'150');assert.equal(s.fraction,'0.2');assert.equal(f.calls(),count);
 assert.equal(f.tracker.observe({...f.signal('SELL',10),wallet:other},task),null);
});
test('unknown balances and source sells exceeding known inventory never imply liquidation',async()=>{
 const f=fixture([{token_id:'1',current_size:'20'}]);await f.refresh();
 const s=f.tracker.observe(f.signal('SELL',25),task);assert.equal(s.mode,'fixed_ratio_fallback');assert.equal(s.reason,'SOURCE_BALANCE_TOO_SMALL');
 const sized=service.size({...f.signal('SELL',25),saleSizing:s},'20','0.1');assert.equal(sized.quantity,'2.5');
 const fresh=fixture();assert.equal(fresh.tracker.observe(fresh.signal('SELL',20),task),null);
});
test('late observations, feed gaps and stale snapshots use the ratio fallback',async()=>{
 const f=fixture([{token_id:'1',current_size:'100'}]);await f.refresh();
 assert.equal(f.tracker.observe(f.signal('SELL',5,1000),task).mode,'fixed_ratio_fallback');
 await f.refresh();f.tracker.invalidate('FEED_GAP');assert.equal(f.tracker.observe(f.signal('SELL',5),task).reason,'FEED_GAP');
 f.advance(3000);await f.refresh();f.advance(180001);assert.equal(f.tracker.observe(f.signal('SELL',5,1184),task).reason,'SOURCE_SNAPSHOT_STALE');
});
test('new token buys after a complete snapshot start from zero and tokens stay isolated',async()=>{
 const f=fixture([{token_id:'1',current_size:'100'}]);await f.refresh();f.tracker.observe(f.signal('BUY',40,1001,'2'),task);
 const a=f.tracker.observe(f.signal('SELL',10,1002,'2'),task);assert.equal(a.fraction,'0.25');
 const b=f.tracker.observe(f.signal('SELL',20,1002,'1'),task);assert.equal(b.fraction,'0.2');
});
test('a background snapshot cannot overwrite a token changed while the read was pending',async()=>{
 const f=fixture();const promise=f.refresh();f.tracker.observe(f.signal('BUY',10),task);f.advance(2000);
 f.read(null,[{token_id:'1',current_size:'100'},{token_id:'2',current_size:'50'}]);await promise;
 assert.equal(f.tracker.observe(f.signal('SELL',10,1003),task).reason,'SOURCE_SNAPSHOT_RACE');
 assert.equal(f.tracker.observe(f.signal('SELL',10,1003,'2'),task).fraction,'0.2');
});
test('a feed gap during a pending snapshot prevents that read from restoring confidence',async()=>{
 const f=fixture();const p=f.refresh();f.tracker.invalidate('FEED_GAP');f.read(null,[{token_id:'1',current_size:'100'}]);await p;
 assert.equal(f.tracker.observe(f.signal('SELL',10),task).mode,'fixed_ratio_fallback');
});
test('generation changes, malformed snapshots and shutdown fail back without HTTP in observe',async()=>{
 const f=fixture([{token_id:'1',current_size:'100'}]);await f.refresh();
 assert.equal(f.tracker.observe(f.signal('SELL',10),{...task,generation:2}).reason,'SOURCE_TASK_CHANGED');
 const broken=fixture([{token_id:'1',current_size:'NaN'}]);await assert.rejects(broken.refresh(),/position/i);
 assert.equal(broken.tracker.observe(broken.signal('SELL',10),task).mode,'fixed_ratio_fallback');
 f.tracker.stop();assert.equal(f.tracker.observe(f.signal('SELL',1),task),null);
});
test('untrusted or forged fraction evidence cannot sell all own shares',()=>{
 const signal={wallet,token:'1',side:'SELL',size:'30',saleSizing:{mode:'leader_fraction',wallet,token:'1',before:'100',sold:'30',fraction:'1'}};
 const s=service.size(signal,'20','0.1');assert.equal(s.mode,'fixed_ratio_fallback');assert.equal(s.quantity,'3');
});
test('snapshot rows missing quantities cannot establish a trusted zero position',async()=>{
 const f=fixture([{token_id:'1'}]);await assert.rejects(f.refresh(),/position/i);
 assert.equal(f.tracker.observe(f.signal('SELL',5),task).mode,'fixed_ratio_fallback');
});
