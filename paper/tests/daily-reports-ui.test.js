const i18n = require('./helpers/i18n.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),esbuild=require('esbuild');
const wallet='0x'+'a'.repeat(40);
function screen(){
 const states=[{from:'',to:'',wallet:''},20,20,{'/daily-report-traders':{data:[{wallet,name:'UpTheBlues'}]},'/daily-task-reports':{queryKey:'?from=&to=&wallet=&limit=20&offset=20',data:[{id:'report',day:'2026-10-12',traderName:'UpTheBlues',netProfit:'1',totalProfitEnd:'2',leaderNetProfit:null,leaderStatus:'pending'}],total:1}},''],requests=[];let cursor=0,load;
 const React={createElement:function(type,props,...children){return{type,props:props||{},children:children.flat(Infinity)};},useState:function(initial){const i=cursor++;if(states[i]===undefined)states[i]=initial;return[states[i],v=>{states[i]=typeof v==='function'?v(states[i]):v;}];},useRef:v=>({current:v}),useEffect:function(){},useCallback:function(fn){load=fn;return fn;}};
 const module={exports:{}};
 vm.runInNewContext(esbuild.transformSync(fs.readFileSync('web/src/DailyReports.jsx','utf8'),{loader:'jsx',format:'cjs'}).code,{module,exports:module.exports,require:function(name){if(name==='./i18n')return i18n;if(name==='./LanguageSwitcher')return()=>null;if(name==='react')return React;if(name==='./api')return{request:function(route,body,callback){requests.push({route,callback});}};throw Error(name);},URLSearchParams,Map,Set,FormData:class{constructor(form){this.entries=form.entries;}[Symbol.iterator](){return this.entries[Symbol.iterator]();}}});
 function render(){cursor=0;return module.exports.default();}
 function find(tree,predicate){if(!tree||typeof tree!=='object')return null;if(predicate(tree))return tree;for(const child of tree.children||[]){const found=find(child,predicate);if(found)return found;}return null;}
 return{states,requests,render,find,load:()=>load()};
}
test('daily query submits dates and trader, resets both pagers, wallet only filters task details',function(){
 const app=screen(),tree=app.render(),form=app.find(tree,x=>x.type==='form');assert.ok(app.find(tree,x=>x.type==='select'&&x.props.name==='wallet'));
 form.props.onSubmit({preventDefault:function(){},currentTarget:{entries:[['from','2026-10-01'],['to','2026-10-12'],['wallet',wallet]]}});
 assert.equal(app.states[1],0);assert.equal(app.states[2],0);app.render();app.load();
 const tasks=new URLSearchParams(app.requests.find(x=>x.route.startsWith('/daily-task-reports?')).route.split('?')[1]);assert.equal(tasks.get('wallet'),wallet);assert.equal(tasks.get('from'),'2026-10-01');
 const total=new URLSearchParams(app.requests.find(x=>x.route.startsWith('/daily-reports?')).route.split('?')[1]);assert.equal(total.has('wallet'),false);assert.equal(total.get('to'),'2026-10-12');
});
test('official unknown daily pnl is shown as pending rather than zero',function(){
 const app=screen(),tree=app.render(),table=app.find(tree,x=>typeof x.type==='function'&&x.props.rows&&x.props.rows[0]?.id==='report');assert.ok(table);
 const rendered=table.type(table.props);assert.ok(JSON.stringify(rendered).includes('待補充'));
});
test('old rows are hidden when query or page changes, even if new request fails',function(){
 const app=screen();app.states[0]={from:'2026-10-01',to:'2026-10-01',wallet};let tree=app.render();assert.equal(JSON.stringify(tree).includes('2026-10-12'),false);
 app.load();app.requests.find(r=>r.route.startsWith('/daily-task-reports?')).callback(new Error('network'));tree=app.render();assert.equal(JSON.stringify(tree).includes('2026-10-12'),false);assert.ok(JSON.stringify(tree).includes('network'));
});
