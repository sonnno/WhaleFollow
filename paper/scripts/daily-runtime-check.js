// Read-only application checks; credentials stay in memory and are never printed.
require('../config');
const http=require('node:http'),async=require('async');
let cookie='';
function request(route,body,callback){
 const payload=body?JSON.stringify(body):null;
 const req=http.request({host:'127.0.0.1',port:3000,path:'/api'+route,method:body?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(payload?{'content-type':'application/json','content-length':Buffer.byteLength(payload),'x-requested-with':'XMLHttpRequest'}:{})}},function(res){
  let text='';if(res.headers['set-cookie'])cookie=res.headers['set-cookie'].map(function(v){return v.split(';')[0];}).join('; ');
  res.setEncoding('utf8');res.on('data',function(chunk){text+=chunk;});res.on('end',function(){let data;try{data=JSON.parse(text);}catch(err){return callback(new Error('Non-JSON response '+route));}callback(null,{status:res.statusCode,data});});
 });req.on('error',callback);req.setTimeout(5000,function(){req.destroy(new Error('Local API timeout'));});if(payload)req.write(payload);req.end();
}
async.waterfall([
 function(next){request('/login',{username:process.env.ADMIN_USERNAME||'admin',password:process.env.ADMIN_PASSWORD},next);},
 function(result,next){if(result.status!==200)return next(new Error('Local login failed'));async.mapSeries(['/daily-reports?limit=20','/daily-task-reports?limit=20','/daily-report-traders','/health','/daily-reports?from=2026-02-30'],function(route,done){request(route,null,function(err,result){done(err,result&&{route,...result});});},next);},
 function(results,next){const summary=results.map(function(r){if(r.route==='/health')return{route:r.route,status:r.status,worker:r.data.worker};return{route:r.route,status:r.status,total:r.data.total,rows:r.data.data&&r.data.data.length,error:r.data.error};});if(results.some(function(r){return r.status!==(r.route.includes('2026-02-30')?400:200);}))return next(new Error('Unexpected API status'));console.log(JSON.stringify(summary,null,2));next();}
],function(err){if(err){console.error(err.message);process.exitCode=1;}});
