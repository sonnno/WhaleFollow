const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm');
const esbuild=require('esbuild'),React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
function load(language,file='App.jsx'){const code=esbuild.buildSync({entryPoints:['web/src/'+file],bundle:true,platform:'node',format:'cjs',write:false,external:['react']}).outputFiles[0].text,module={exports:{}};const storage={getItem:()=>language,setItem(){}};vm.runInNewContext(code,{module,exports:module.exports,require:name=>{if(name==='react')return React;throw Error(name);},window:{localStorage:storage,addEventListener(){},removeEventListener(){}},console,URLSearchParams,Map,Set});return module.exports;}
function markup(component,props={}){return renderToStaticMarkup(React.createElement(component,props));}
test('unauthenticated login exposes both language choices and localized form without any API call',()=>{
 const traditional=markup(load('zh-Hant').Login,{onLogin(){}});assert.ok(traditional.includes('虛擬跟單後台'));assert.ok(traditional.includes('使用者名稱'));assert.ok(traditional.includes('密碼'));assert.ok(traditional.includes('繁體中文'));assert.ok(traditional.includes('English'));assert.match(traditional,/aria-pressed="true"/);assert.doesNotMatch(traditional,/<svg/);assert.equal(traditional.includes('用户名'),false);
 const english=markup(load('en').Login,{onLogin(){}});assert.ok(english.includes('Paper copy trading dashboard'));assert.ok(english.includes('Username'));assert.ok(english.includes('Password'));assert.ok(english.includes('Log in to dashboard'));assert.equal(english.includes('虚拟跟单后台'),false);
});
test('user trader names and official titles are never translated even when they equal UI keys',()=>{
 const app=load('en');const table=markup(app.Table,{rows:[{name:'系统设置',title:'总览',traderName:'系统设置'}],columns:[['name','人员'],['title','市场'],['traderName','跟单人员']]});assert.ok(table.includes('系统设置'));assert.ok(table.includes('总览'));
 const reports=markup(load('en','DailyReports.jsx').ReportTable,{rows:[{id:'1',traderName:'系统设置'}],columns:[['traderName','跟单人员']]});assert.ok(reports.includes('系统设置'));
 const notice=markup(load('en','FollowTasks.jsx').TaskNotice,{value:{type:'task-control',name:'系统设置',action:'start'}});assert.ok(notice.includes('Started following 系统设置.'));assert.equal(notice.includes('System settings'),false);
});
test('market display localizes direction and units after parsing without changing source fields',()=>{
 const en=load('en','market-fields-view.js'),zh=load('zh-Hant','market-fields-view.js');const order={title:'Original Football Match: O/U 2.5',eventTitle:'总览',category:'足球',outcome:'Under'};const before=JSON.stringify(order),fields=en.marketFields(order);assert.equal(fields.event,'总览');assert.equal(fields.line,'2.5 goals');assert.equal(fields.direction,'Under 2.5 goals');assert.ok(zh.marketFields(order).direction.includes('小於'));assert.equal(JSON.stringify(order),before);
});
test('settings exposes the same persistent language choices with localized explanation',()=>{
 const en=markup(load('en').LanguageSettings);assert.ok(en.includes('Interface language'));assert.ok(en.includes('does not affect follow tasks'));assert.ok(en.includes('繁體中文'));assert.ok(en.includes('English'));
 const zh=markup(load('zh-Hant').LanguageSettings);assert.ok(zh.includes('介面語言'));assert.ok(zh.includes('瀏覽器'));assert.ok(zh.includes('不影響跟單任務'));
});

test('known execution reasons follow the chosen UI language',()=>{assert.equal(load('en','OrderDetail.jsx').readableReason('BUY_PAUSED'),'Buying paused');assert.equal(load('zh-Hant','OrderDetail.jsx').readableReason('BUY_PAUSED'),'買入已暫停');});
