// Port 3220 belongs to preview-product.js and its disposable fixture only.
const assert=require('node:assert/strict'),async=require('async'),http=require('node:http');require('../config');let cookie='';
const C='0x'+'c'.repeat(40),D='0x'+'d'.repeat(40);
const input=(wallet,extra)=>({wallet,name:'Fixture '+wallet[2],fundingMode:'dedicated',allocation:'1000',copyPercent:'0.08484',maxOrderAmount:null,initialTransferAmount:'200',requestId:'http-setup-'+wallet,taskVersion:'initial',start:true,...extra});
function req(method,path,body,cb,options={}){const headers={'Content-Type':'application/json','X-Requested-With':'XMLHttpRequest',Cookie:options.noAuth?'':cookie};if(options.noHeader)delete headers['X-Requested-With'];const request=http.request({host:'127.0.0.1',port:3220,path,method,headers},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>{if(res.headers['set-cookie'])cookie=res.headers['set-cookie'][0].split(';')[0];try{cb(null,{status:res.statusCode,body:JSON.parse(text)});}catch(err){cb(err);}});});request.setTimeout(10000,()=>request.destroy(Error('HTTP test timed out')));request.on('error',cb);request.end(body?JSON.stringify(body):'');}
async.waterfall([
 next=>req('POST','/api/follow-tasks/setup',input(C),next,{noAuth:true}),
 (r,next)=>{assert.equal(r.status,401);req('POST','/api/login',{username:process.env.ADMIN_USERNAME||'admin',password:process.env.ADMIN_PASSWORD},next);},
 (r,next)=>{assert.equal(r.status,200);req('POST','/api/follow-tasks/setup',input(C),next,{noHeader:true});},
 (r,next)=>{assert.equal(r.status,403);req('POST','/api/follow-tasks/setup',input(C),next);},
 (r,next)=>{assert.equal(r.status,200);assert.equal(r.body.state,'running');assert.equal(Number(r.body.cash),200);req('POST','/api/follow-tasks/'+C+'/control',{action:'pause'},next);},
 (r,next)=>{assert.equal(r.status,200);req('POST','/api/follow-tasks/setup',input(C),next);},
 (r,next)=>{assert.equal(r.status,200);assert.equal(r.body.duplicate,true);req('POST','/api/follow-tasks/setup',input(D,{initialTransferAmount:'301'}),next);},
 (r,next)=>{assert.equal(r.status,409);req('GET','/api/follow-tasks',null,next);},
 (r,next)=>{assert.equal(r.body.data.length,3);assert.equal(r.body.data.find(t=>t.wallet===C).state,'paused');assert.equal(Number(r.body.wallet.cash),1000);assert.equal(Number(r.body.wallet.unallocatedCash),300);assert.equal(typeof r.body.creationVersions,'object');req('GET','/api/follow-tasks/'+C+'/transfers',null,next);},
 (r,next)=>{assert.equal(r.body.total,1);next();}
],err=>{if(err){console.error(err.stack);process.exitCode=1;}else console.log('Onboarding HTTP passed: authentication, CSRF, funded before start, one transfer on replay, no restart on retry, insufficient funds leave no task.');});
