// Every inserted fixture targets a newly created disposable database; no live/public calls.
const assert=require('node:assert/strict'),async=require('async'),{Client}=require('pg'),settings=require('../config/DBsettings');
const name='polymarket_market_stats_test_'+Date.now(),db=require('../server/db/adapter').create({database:name});
const admin=new Client({host:settings.POSTGRES_HOST,port:settings.POSTGRES_PORT,user:settings.POSTGRES_USER,password:settings.POSTGRES_PASSWORD,database:'postgres',connectionTimeoutMillis:5000});
const statistics=require('../server/service/market-statistics-service').create(db),{D}=require('../server/service/accounting-service');
const A='0x'+'a'.repeat(40),B='0x'+'b'.repeat(40);let created=false,seen,cleaning=false;
process.once('uncaughtException',cleanup);
const fixtures=[
 {id:'football-a',wallet:A,condition:'football',profit:'6',cost:'4',revenue:'10',at:'2026-10-12T16:00:00Z'},
 {id:'football-b',wallet:B,condition:'football',profit:'-4',cost:'8',revenue:'4',at:'2026-10-13T15:59:59.999Z'},
 {id:'tennis',wallet:A,condition:'tennis',profit:'-5',cost:'10',revenue:'5',at:'2026-10-13T16:00:00Z'},
 {id:'draw',wallet:A,condition:'draw',profit:'0',cost:'2',revenue:'2',at:'2026-10-13T00:00:00Z'},
 ...Array.from({length:23},function(_,i){const value=i===22?100:i===1?20:i===0?9:1;return{id:'extra-'+i,wallet:A,condition:'extra-'+i,profit:String(value),cost:'1',revenue:String(value+1),at:'2026-10-13T01:00:00Z'};})
];
async.waterfall([
 function(next){admin.connect(function(err){next(err);});},
 function(next){admin.query('CREATE DATABASE "'+name+'"',function(err){created=!err;next(err);});},
 function(next){db.connect(function(err){next(err);});},
 function(next){db.migrate(function(err){next(err);});},
 function(next){async.eachSeries(['football','tennis','draw',...Array.from({length:23},function(_,i){return'extra-'+i;})],function(condition,saved){const tags=condition==='football'?[{slug:'sports'},{slug:'SOCCER'}]:condition==='tennis'?[{slug:'tennis'}]:condition==='draw'?[{slug:'politics'}]:condition==='extra-22'?{}:[{slug:'weather'}];db.insert('Market',{id:condition,raw:{gamma:{question:condition==='draw'?'City 100% win':condition==='football'?'Portugal match':condition,tags,category:condition==='extra-22'?'Custom':null,slug:condition,eventSlug:'event-'+condition,sportsMarketType:'moneyline'}}},function(err){saved(err);});},next);},
 function(next){async.eachSeries(fixtures,function(f,saved){db.insert('Settlement',{id:f.id,wallet:f.wallet,token:f.id,condition:f.condition,quantity:'10',payout:'1',profit:f.profit,cost:f.cost,revenue:f.revenue,createdAt:new Date(f.at)},function(err){saved(err);});},next);},
 function(next){statistics.list({limit:1},next);},
 function(page,next){assert.equal(page.data[0].condition,'extra-22','Pagination must sort numeric 100 before 20, 9 and 2');statistics.list({},next);},
 function(page,next){assert.equal(page.total,26);assert.equal(page.data.length,20);assert.ok(D(page.summary.profit).eq('146'));assert.equal(page.summary.records,27);const football=page.data.find(function(r){return r.condition==='football';});assert.equal(football.category,'足球');assert.equal(football.count,2);assert.ok(D(football.profit).eq('2'));assert.equal(football.officialUrl,'https://polymarket.com/event/event-football/football');seen=page.data.map(function(r){return r.condition;});statistics.list({offset:20},next);},
 function(page,next){assert.equal(page.total,26);assert.equal(page.data.length,6);page.data.forEach(function(r){assert.ok(!seen.includes(r.condition));});assert.equal(new Set(seen.concat(page.data.map(function(r){return r.condition;}))).size,26);statistics.list({offset:40},next);},
 function(page,next){assert.equal(page.total,26);assert.equal(page.data.length,0);assert.ok(D(page.summary.profit).eq('146'));statistics.list({wallet:A,keyword:'Portugal',category:'足球',profit:'positive',from:'2026-10-13',to:'2026-10-13'},next);},
 function(page,next){assert.equal(page.total,1);assert.equal(page.data[0].count,1);assert.ok(D(page.data[0].profit).eq('6'));statistics.list({category:'足球',profit:'negative'},next);},
 function(page,next){assert.equal(page.total,0,'Mixed market must be classified by net profit, not its losing individual record');statistics.list({wallet:B,category:'足球',profit:'negative',from:'2026-10-13',to:'2026-10-13'},next);},
 function(page,next){assert.equal(page.total,1);assert.ok(D(page.data[0].profit).eq('-4'));statistics.list({from:'2026-10-13',to:'2026-10-13'},next);},
 function(page,next){assert.equal(page.total,25,'Next-day midnight excluded, both first and last instant included');assert.ok(D(page.summary.profit).eq('151'));statistics.list({from:'2026-10-14',to:'2026-10-14'},next);},
 function(page,next){assert.equal(page.total,1);assert.equal(page.data[0].condition,'tennis');statistics.list({keyword:'%'},next);},
 function(page,next){assert.equal(page.total,1,'Keyword percent must be literal, not a wildcard');assert.equal(page.data[0].condition,'draw');statistics.list({keyword:"' OR true --"},next);},
 function(page,next){assert.equal(page.total,0);statistics.list({category:'Custom'},next);},
 function(page,next){assert.equal(page.total,1);assert.equal(page.data[0].category,'Custom');statistics.list({profit:'zero'},next);},
 function(page,next){assert.equal(page.total,1);assert.equal(page.data[0].condition,'draw');assert.ok(D(page.summary.profit).isZero());next();}
],cleanup);
function cleanup(err){if(cleaning)return;cleaning=true;db.close(function(closeErr){function finish(cleanErr){admin.end(function(){const error=err||closeErr||cleanErr;if(error){console.error(error.stack);if(error.query)console.error(error.query);process.exitCode=1;}else console.log('Market statistics passed: aggregation, 20/6/empty pagination, per-person net classification, Shanghai boundaries, category parity, literal keywords and summaries. Disposable DB removed.');});}if(created&&/^polymarket_market_stats_test_\d+$/.test(name))admin.query('DROP DATABASE "'+name+'"',finish);else finish();});}
