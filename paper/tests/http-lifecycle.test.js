const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
test('shutdown ends live refresh streams before waiting for HTTP close and releasing the lease',function(_,done){
 const {closeServer}=require('../server/service/http-lifecycle-service');const streams=new Set();
 const server=http.createServer(function(req,res){res.setHeader('Content-Type','text/event-stream');res.flushHeaders();streams.add(res);res.write('data: ready\n\n');req.once('close',function(){streams.delete(res);});});
 let timer,closing=false;server.listen(0,'127.0.0.1',function(){const request=http.get({host:'127.0.0.1',port:server.address().port},function(res){res.once('data',function(){closing=true;timer=setTimeout(function(){server.closeAllConnections();done(new Error('Shutdown waited forever for SSE'));},1000);closeServer(server,streams,function(err){clearTimeout(timer);assert.ifError(err);assert.ok(closing);assert.equal(server.listening,false);done();});});res.on('error',function(){});});request.on('error',function(err){if(!closing)done(err);});});
});
test('shutdown rejects a refresh request whose asynchronous authentication completes late',function(_,done){
 const {closeServer,registerRefreshStream}=require('../server/service/http-lifecycle-service');const streams=new Set();let closing=false,closed=false,status,timer;
 function finish(){if(!closed||status===undefined)return;clearTimeout(timer);assert.equal(status,503);assert.equal(streams.size,0);done();}
 const server=http.createServer(function(req,res){setTimeout(function(){if(!registerRefreshStream(streams,res,closing))return;res.setHeader('Content-Type','text/event-stream');res.flushHeaders();},30);closing=true;closeServer(server,streams,function(err){assert.ifError(err);closed=true;finish();});});
 server.listen(0,'127.0.0.1',function(){timer=setTimeout(function(){server.closeAllConnections();done(new Error('Late refresh stream blocked shutdown'));},1000);http.get({host:'127.0.0.1',port:server.address().port},function(res){status=res.statusCode;res.resume();res.on('end',finish);}).on('error',done);});
});
