const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),esbuild=require('esbuild');
function load(){const module={exports:{}};vm.runInNewContext(esbuild.transformSync(fs.readFileSync('web/src/FollowTransfers.jsx','utf8'),{loader:'jsx',format:'cjs'}).code,{module,exports:module.exports,require:function(name){if(name==='react')return{};if(name==='./api'||name==='./money-format')return{};throw new Error(name);}});return module.exports;}
test('a transfer retry reuses its request ID, while editing destination/direction/amount creates a new intent',function(){
 const {transferIntent}=load();let sequence=0;const generate=()=> 'ui-transfer-'+(++sequence);const first=transferIntent('0xabc','in','20',null,generate);const retry=transferIntent('0xabc','in','20',first,generate);
 assert.equal(retry.payload.requestId,first.payload.requestId);assert.equal(sequence,1);assert.notEqual(transferIntent('0xabc','out','20',first,generate).payload.requestId,first.payload.requestId);assert.notEqual(transferIntent('0xabc','in','21',first,generate).payload.requestId,first.payload.requestId);assert.notEqual(transferIntent('0xdef','in','20',first,generate).payload.requestId,first.payload.requestId);
});
test('closing or reloading a panel retains an unconfirmed intent until success acknowledgement',function(){
 const values=new Map(),storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};let sequence=0;const generate=()=> 'persisted-transfer-'+(++sequence);
 const first=load().storeTransferIntent('0xabc','out','20',storage,generate);
 const reloaded=load(),retry=reloaded.storeTransferIntent('0xabc','out','20',storage,generate);
 assert.equal(retry.payload.requestId,first.payload.requestId);assert.equal(sequence,1);assert.equal(reloaded.readTransferIntent('0xabc',storage).payload.amount,'20');
 reloaded.acknowledgeTransferIntent('0xabc',retry,storage);assert.equal(reloaded.readTransferIntent('0xabc',storage),null);
 assert.notEqual(reloaded.storeTransferIntent('0xabc','out','20',storage,generate).payload.requestId,first.payload.requestId);
});
test('a persisted transfer is scoped to task creation, not to pause/resume controls',function(){const values=new Map(),storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};let sequence=0;const generate=()=> 'version-transfer-'+(++sequence);const api=load(),first=api.storeTransferIntent('0xabc','in','20',storage,generate,'initial');assert.equal(api.storeTransferIntent('0xabc','in','20',storage,generate,'initial').payload.requestId,first.payload.requestId);const recreated=api.storeTransferIntent('0xabc','in','20',storage,generate,'8');assert.notEqual(recreated.payload.requestId,first.payload.requestId);assert.equal(recreated.payload.taskVersion,'8');});
