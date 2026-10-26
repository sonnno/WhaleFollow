const fs=require('node:fs'),vm=require('node:vm'),esbuild=require('esbuild'),path=require('node:path');
const target={exports:{}};
vm.runInNewContext(esbuild.transformSync(fs.readFileSync(path.join(__dirname,'../../web/src/request-id.js'),'utf8'),{format:'cjs'}).code,{module:target,exports:target.exports,crypto:require('node:crypto').webcrypto});
module.exports=target.exports;
