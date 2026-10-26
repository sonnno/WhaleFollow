const i18n = require('./helpers/i18n.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),esbuild=require('esbuild');
test('selected existing trader hydrates saved settings after the first slow list response',function(){
 const states=[],effects=[],requests=[];const React={useCallback:fn=>fn,createElement:function(){return null;},useState:function(initial){const index=states.length;states.push(typeof initial==='function'?initial():initial);return[states[index],function(value){states[index]=typeof value==='function'?value(states[index]):value;}];},useRef:function(value){return{current:value};},useEffect:function(fn){effects.push(fn);}};
 const module={exports:{}};vm.runInNewContext(esbuild.transformSync(fs.readFileSync('web/src/FollowTasks.jsx','utf8'),{loader:'jsx',format:'cjs'}).code,{module,exports:module.exports,require:function(name){if(name==='./request-id')return require('./helpers/request-id.cjs');if(name==='./i18n')return i18n;if(name==='./LanguageSwitcher')return()=>null;if(name==='react')return React;if(name==='./TaskEditorDialog'||name==='./TaskDeleteDialog')return function(){return null;};if(name==='./money-format')return{formatMoney:String,formatBalance:String};if(name==='./FollowTransfers')return function(){return null;};if(name==='./api')return{request:function(route,body,cb){requests.push({route,cb});}};throw new Error(name);},setInterval:function(){return 1;},clearInterval:function(){}});
 const wallet='0x'+'a'.repeat(40);module.exports.default({selection:{wallet,name:'Board A'}});effects.forEach(function(fn){fn();});
 requests[0].cb(null,{wallet:{},defaults:{allocation:'1000'},data:[{wallet,name:'Existing A',fundingMode:'dedicated',allocation:'500',copyPercent:'0.2424',maxOrderAmount:'20'}]});
 assert.equal(states[1].fundingMode,'dedicated');assert.equal(states[1].allocation,'500');assert.equal(states[1].copyPercent,'0.2424');assert.equal(states[1].maxOrderAmount,'20');
});



