const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const assets = path.join(__dirname, '../web/dist/assets');
for (const name of fs.readdirSync(assets)) {
  if (!/\.(js|css)$/.test(name)) continue;
  const file = path.join(assets, name);
  fs.writeFileSync(file + '.gz', zlib.gzipSync(fs.readFileSync(file), { level: 9 }));
}
