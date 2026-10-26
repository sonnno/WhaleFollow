const test = require('node:test'), assert = require('node:assert/strict');
const create = require('../server/service/activity-feed-service').create;
test('identity cache bounds memory and expires old identities without merging different fills',function(){
 let now=0;const feed=create({now:function(){return now;},maxEntries:2,ttlMs:10});
 assert.equal(feed.claim('a'),true);assert.equal(feed.claim('a'),false);assert.equal(feed.claim('b'),true);assert.equal(feed.claim('c'),true);assert.equal(feed.size(),2);assert.equal(feed.claim('a'),true);now=11;assert.equal(feed.claim('a'),true);
});
test('publisher timing separates source publication delay from transport delay',function(){
 const feed=create();const value=feed.telemetry({timestamp:12000,type:'orders_matched'},{timestamp:10},{receivedAt:new Date(12200).toISOString(),receivedMonotonicMs:5},12300,'connection-1',{});
 assert.equal(value.sourceToPublishMs,2000);assert.equal(value.transitMs,200);assert.equal(value.rawReceivedAtMs,12300);assert.equal(feed.telemetry({type:'trades'},{timestamp:10},{receivedAt:'bad'},0,'x',{}).transitMs,null);
});
