const i18n = require('./helpers/i18n.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),esbuild=require('esbuild');
const A='0x'+'a'.repeat(40),B='0x'+'b'.repeat(40);
function screen(page){
 const states=[{username:'admin'},page,{'/leaders':{data:[{id:A,name:'UpTheBlues',active:true},{id:B,name:'BreakTheBank',active:false}]}},'',null,{wallet:A,condition:'',status:'',from:'',to:''},100],requests=[];let cursor=0,load;
 const React={createElement:function(type,props,...children){return{type,props:props||{},children:children.flat(Infinity)};},useState:function(initial){const i=cursor++;if(states[i]===undefined)states[i]=initial;return[states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},useRef:value=>({current:value}),useEffect:function(){},useCallback:function(fn){load=fn;return fn;}};
 const module={exports:{}};
 vm.runInNewContext(esbuild.transformSync(fs.readFileSync('web/src/App.jsx','utf8'),{loader:'jsx',format:'cjs'}).code,{module,exports:module.exports,require:function(name){if(name==='./i18n')return i18n;if(name==='./LanguageSwitcher'||name==='./WalletDeposit')return()=>null;if(name==='react')return React;if(name==='./api')return{request:function(route,body,callback){requests.push({route,body,callback});}};if((name==='./market-fields'||name==='./market-fields-view'))return{marketFields:()=>({})};if(name==='./OrderDetail')return{default:()=>null,readableReason:String,executionTime:String,executionDelay:String};if(name==='./Leaderboards'||name==='./FollowTasks'||name==='./DailyReports'||name==='./MarketStatistics')return{default:()=>null};throw Error(name);},URLSearchParams,Map,Set,FormData:class{constructor(form){this.entries=form.entries;}[Symbol.iterator](){return this.entries[Symbol.iterator]();}}});
 function render(){cursor=0;const tree=module.exports.default();return tree;}
 function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of tree.children||[]){const result=find(child,predicate);if(result)return result;}return null;}
 return {states,requests,render,find,load:()=>load()};
}
for(const page of ['copies','positions','settlements'])test(page+' provides all/active/paused trader choices and loads the roster separately',function(){
 const app=screen(page),tree=app.render(),select=app.find(tree,x=>x.type==='select'&&x.props['aria-label']==='跟單人');
 assert.ok(select);assert.equal(select.props.name,'wallet');const options=select.children.filter(x=>x&&x.type==='option');assert.ok(options.some(x=>x.props.value===''));assert.ok(options.some(x=>x.props.value===A&&x.children.join('').includes('UpTheBlues')));assert.ok(options.some(x=>x.props.value===B&&x.children.join('').includes('BreakTheBank')));
 app.load();assert.ok(app.requests.some(x=>x.route==='/leaders?limit=500'),'roster must not inherit the selected trader filter');
});
for(const page of ['positions','settlements'])test(page+' submitted trader choice resets pagination and is preserved in list requests and export',function(){
 const app=screen(page),tree=app.render(),form=app.find(tree,x=>x.type==='form'&&x.props.className==='filters');
 form.props.onSubmit({preventDefault:function(){},currentTarget:{entries:[['wallet',B],['condition',''],['from',''],['to','']]}});
 assert.equal(app.states[6],0);assert.equal(app.states[5].wallet,B);const updated=app.render();app.load();
 const listing=app.requests.find(x=>x.route.startsWith('/'+page+'?'));const query=new URLSearchParams(listing.route.split('?')[1]);assert.equal(query.get('wallet'),B);if(page==='positions')assert.equal(query.get('open'),'true');
 const link=app.find(updated,x=>x.type==='a'&&x.props.className==='export');assert.equal(new URLSearchParams(link.props.href.split('?')[1]).get('wallet'),B);
});


test('positions export includes the displayed open-only scope',function(){const app=screen('positions');const link=app.find(app.render(),x=>x.type==='a'&&x.props.className==='export');assert.equal(new URLSearchParams(link.props.href.split('?')[1]).get('open'),'true');});
for(const page of ['copies','positions','settlements'])test(page+' date filters remain visible after navigation',function(){const app=screen(page);app.states[5].from='2026-10-14T01:15';app.states[5].to='2026-10-15T02:30';let tree=app.render();for(const name of ['from','to']){let input=app.find(tree,x=>x.type==='input'&&x.props.name===name);assert.equal(input.props.value,app.states[5][name]);assert.equal(typeof input.props.onChange,'function');}app.states[1]='overview';app.render();app.states[1]=page;tree=app.render();assert.equal(app.find(tree,x=>x.type==='input'&&x.props.name==='from').props.value,app.states[5].from);});

test('date edits retain local values while list and export use matching ISO instants',function(){const app=screen('positions');let tree=app.render();const from=app.find(tree,x=>x.type==='input'&&x.props.name==='from');from.props.onChange({target:{value:'2026-10-14T09:15'}});assert.equal(app.states[5].from,'2026-10-14T09:15');tree=app.render();app.load();const route=app.requests.find(x=>x.route.startsWith('/positions?')).route;const link=app.find(tree,x=>x.type==='a'&&x.props.className==='export');for(const url of [route,link.props.href])assert.equal(new URLSearchParams(url.split('?')[1]).get('from'),new Date('2026-10-14T09:15').toISOString());});

test('copies exposes an independent settlement column and localized settlement filter',function(){
 const app=screen('copies'),tree=app.render();const select=app.find(tree,x=>x.type==='select'&&x.props.name==='settlementStatus');assert.ok(select);
 assert.deepEqual(select.children.filter(x=>x&&x.type==='option').map(x=>x.props.value),['','settled','pending']);
 const table=app.find(tree,x=>typeof x.type==='function'&&x.props.columns?.some(c=>c[0]==='settlementStatus'));assert.ok(table);
 const col=table.props.columns.find(c=>c[0]==='settlementStatus');
 for(const [value,label]of [['settled','已結算'],['pending','未結算'],['sold','已賣出'],[null,'—']]){const rendered=col[2](value,{});assert.equal(typeof rendered==='string'?rendered:rendered.children.join(''),label);}
});

test('copies settlement selection resets pagination and applies to list and export',function(){
 const app=screen('copies'),form=app.find(app.render(),x=>x.type==='form'&&x.props.className==='filters');
 form.props.onSubmit({preventDefault(){},currentTarget:{entries:[['wallet',B],['condition',''],['status','FILLED'],['settlementStatus','settled'],['from',''],['to','']]}});
 assert.equal(app.states[6],0);const tree=app.render();app.load();
 const route=app.requests.find(r=>r.route.startsWith('/paper-orders?')).route;const link=app.find(tree,x=>x.type==='a'&&x.props.className==='export');
 for(const url of [route,link.props.href]){const q=new URLSearchParams(url.split('?')[1]);assert.equal(q.get('settlementStatus'),'settled');assert.equal(q.get('status'),'FILLED');assert.equal(q.get('wallet'),B);}
});

for(const page of ['copies','settlements'])test(page+' colors only final positive/negative settlement results and keeps pending black',function(){
 const app=screen(page),tree=app.render(),table=app.find(tree,x=>typeof x.type==='function'&&x.props.columns?.some(c=>c[0]===(page==='copies'?'settlementStatus':'profit')));
 assert.equal(typeof table.props.rowClassName,'function');
 const row=profit=>page==='copies'?{status:'FILLED',settlementStatus:'settled',settlementProfit:profit}:{profit};
 assert.match(table.props.rowClassName(row('3')),/trade-profit/);assert.match(table.props.rowClassName(row('-3')),/trade-loss/);assert.match(table.props.rowClassName(row('0')),/trade-neutral/);
 if(page==='copies'){assert.match(table.props.rowClassName({settlementStatus:'pending',settlementProfit:'100'}),/trade-neutral/);assert.match(table.props.rowClassName({status:'SKIPPED',settlementStatus:null}),/trade-neutral/);}
 const rendered=table.type({...table.props,rows:[row('3'),row('-3'),row('0')]});const positive=app.find(rendered,x=>x.type==='tr'&&x.props.className?.includes('trade-profit'));assert.ok(positive,'row class must reach the actual DOM row');
});

for(const page of ['positions','settlements'])test(page+' does not inherit the copies-only settlement filter',function(){
 const app=screen(page);app.states[5].settlementStatus='pending';const tree=app.render();app.load();const route=app.requests.find(r=>r.route.startsWith('/'+page+'?')).route;const link=app.find(tree,x=>x.type==='a'&&x.props.className==='export');for(const url of [route,link.props.href])assert.equal(new URLSearchParams(url.split('?')[1]).has('settlementStatus'),false);
});
