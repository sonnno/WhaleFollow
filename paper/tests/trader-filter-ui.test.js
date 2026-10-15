const i18n = require('./helpers/i18n.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),esbuild=require('esbuild');
const A='0x'+'a'.repeat(40),B='0x'+'b'.repeat(40);
function screen(page){
 const states=[{username:'admin'},page,{'/leaders':{data:[{id:A,name:'UpTheBlues',active:true},{id:B,name:'BreakTheBank',active:false}]}},'',null,{wallet:A,condition:'',status:'',from:'',to:''},100],requests=[];let cursor=0,load;
 const React={createElement:function(type,props,...children){return{type,props:props||{},children:children.flat(Infinity)};},useState:function(initial){const i=cursor++;if(states[i]===undefined)states[i]=initial;return[states[i],value=>{states[i]=typeof value==='function'?value(states[i]):value;}];},useRef:value=>({current:value}),useEffect:function(){},useCallback:function(fn){load=fn;return fn;}};
 const module={exports:{}};
 vm.runInNewContext(esbuild.transformSync(fs.readFileSync('web/src/App.jsx','utf8'),{loader:'jsx',format:'cjs'}).code,{module,exports:module.exports,require:function(name){if(name==='./i18n')return i18n;if(name==='./LanguageSwitcher')return()=>null;if(name==='react')return React;if(name==='./api')return{request:function(route,body,callback){requests.push({route,body,callback});}};if((name==='./market-fields'||name==='./market-fields-view'))return{marketFields:()=>({})};if(name==='./OrderDetail')return{default:()=>null,readableReason:String,executionTime:String,executionDelay:String};if(name==='./Leaderboards'||name==='./FollowTasks'||name==='./DailyReports'||name==='./MarketStatistics')return{default:()=>null};throw Error(name);},URLSearchParams,Map,Set,FormData:class{constructor(form){this.entries=form.entries;}[Symbol.iterator](){return this.entries[Symbol.iterator]();}}});
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

