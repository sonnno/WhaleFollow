const test=require('node:test'),assert=require('node:assert/strict');
const rules=require('../server/service/follow-rule-service');
const base={state:'running',generation:3,startedAt:new Date(0),smartPause:{id:'s',events:['game-a']}};
const signal={followGeneration:3,timestamp:100,eventKey:'game-a'};
test('smart pause allows retained event across markets and blocks all others, including empty lists',()=>{
 assert.equal(rules.buyBlocked(signal,base),'');
 assert.equal(rules.buyBlocked({...signal,eventKey:'game-a-more-markets'},base),'');
 assert.equal(rules.buyBlocked({...signal,eventKey:'game-b'},base),'SMART_PAUSE_NEW_EVENT');
 assert.equal(rules.buyBlocked(signal,{...base,smartPause:{id:'s',events:[]}}),'SMART_PAUSE_NEW_EVENT');
 assert.equal(rules.buyBlocked(signal,{...base,state:'paused'}),'TASK_PAUSED');
 assert.equal(rules.buyBlocked({...signal,eventKey:'game-b'},{...base,smartPause:null}),'');
});
