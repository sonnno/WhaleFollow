// Only the disposable preview on 3220. No production API or worker calls.
const http = require('node:http'), async = require('async'), assert = require('node:assert/strict');
require('../config');
let cookie;
function request(method, route, body, callback, options) {
  options = options || {};
  const data = body ? JSON.stringify(body) : '';
  const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Cookie: options.unauthorized ? '' : cookie || '' };
  if (options.noHeader) delete headers['X-Requested-With'];
  const req = http.request({ hostname: '127.0.0.1', port: 3220, path: route, method, headers }, function (res) {
    let text = ''; res.on('data', function (chunk) { text += chunk; });
    res.on('end', function () { let body; try { body = JSON.parse(text); } catch (err) { return callback(err); } if (res.headers['set-cookie']) cookie = res.headers['set-cookie'][0].split(';')[0]; callback(null, { status: res.statusCode, body }); });
  });
  req.setTimeout(10000, function () { req.destroy(new Error('Preview request timed out')); }); req.on('error', callback); req.end(data);
}
const wallet = '0x' + 'a'.repeat(40);
async.waterfall([
  function (next) { request('GET', '/api/follow-tasks', null, next, { unauthorized: true }); },
  function (res, next) { assert.equal(res.status, 401); request('POST', '/api/login', { username: process.env.ADMIN_USERNAME || 'admin', password: process.env.ADMIN_PASSWORD }, next); },
  function (res, next) { assert.equal(res.status, 200); request('GET', '/api/follow-tasks', null, next); },
  function (res, next) { assert.equal(res.status, 200); assert.equal(res.body.data.length, 2, 'Disposable fixture must have exactly A/B'); assert.equal(res.body.data[0].id, wallet); request('POST', '/api/follow-tasks', { wallet, name: '示例A · 独立账户', fundingMode: 'dedicated', allocation: '400', copyPercent: '100', maxOrderAmount: null }, next); },
  function (res, next) { assert.equal(res.status, 200); assert.equal(Number(res.body.cash), 500); request('POST', '/api/follow-tasks/' + wallet + '/transfers', {direction:'out',amount:'100',requestId:'http-manual-return-100'}, next); },
  function (res, next) { assert.equal(res.status,200); assert.equal(Number(res.body.transfer.cashAfter),400); request('POST','/api/follow-tasks/'+wallet+'/transfers',{direction:'out',amount:'100',requestId:'http-manual-return-100'},next); },
  function (res, next) { assert.equal(res.body.duplicate,true); request('GET','/api/follow-tasks/'+wallet+'/transfers?limit=1&offset=1',null,next); },
  function (res, next) { assert.equal(res.status,200); assert.equal(res.body.total,2); assert.equal(res.body.data.length,1); assert.equal(typeof res.body.data[0].amount,'string'); assert.equal(Number(res.body.data[0].amount),500); request('GET','/api/follow-tasks',null,next); },
  function (res, next) { assert.equal(Number(res.body.wallet.unallocatedCash), 600); request('POST', '/api/follow-tasks/' + wallet + '/control', { action: 'pause' }, next); },
  function (res, next) { assert.equal(res.status, 200); assert.equal(res.body.state, 'paused'); request('POST', '/api/follow-tasks/' + wallet + '/control', { action: 'start' }, next); },
  function (res, next) { assert.equal(res.body.state, 'running'); request('POST', '/api/follow-tasks', { wallet, name: 'A', allocation: '400', copyPercent: '' }, next); },
  function (res, next) { assert.equal(res.status, 400); request('POST', '/api/follow-tasks/' + wallet + '/control', { action: 'pause' }, next, { noHeader: true }); },
  function (res, next) { assert.equal(res.status, 403); request('GET', '/api/leaderboards?type=traders&limit=9999', null, next); },
  function (res, next) { assert.equal(res.status, 400); request('POST','/api/follow-tasks/0x'+'b'.repeat(40)+'/delete',{confirm:true,generation:0},next); },
  function(res,next){assert.equal(res.status,409);assert.match(res.body.error,/停止/);request('POST','/api/follow-tasks/0x'+'b'.repeat(40)+'/control',{action:'stop'},next);},
  function(res,next){assert.equal(res.status,200);request('POST','/api/follow-tasks/0x'+'b'.repeat(40)+'/delete',{confirm:false,generation:res.body.generation},function(err,result){next(err,{...result,generation:res.body.generation});});},
  function(res,next){assert.equal(res.status,400);request('POST','/api/follow-tasks/0x'+'b'.repeat(40)+'/delete',{confirm:true,generation:res.generation},next);},
  function(res,next){assert.equal(res.status,200);assert.equal(res.body.deleted,true);request('GET','/api/follow-tasks',null,next);},
  function(res,next){assert.equal(res.body.data.length,1);assert.equal(res.body.data[0].wallet,wallet);next();}
], function (err) { if (err) { console.error(err.stack); process.exitCode = 1; } else console.log('Preview HTTP passed: auth/validation/CSRF, manual transfers/idempotency/paged journal, delete requires stopped+explicit confirmation, removes only B.'); });

