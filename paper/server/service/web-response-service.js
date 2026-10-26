const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');

function sendPrepared(res, error, data) {
  if (error) return res.status(error.status || 500).json({ error: error.message });
  sendBody(res, JSON.stringify(data), 'json');
}
function sendBody(res, body, type) {
  res.vary('Accept-Encoding');
  if (body.length < 2048 || !res.req.get('Accept-Encoding') || !res.req.acceptsEncodings('gzip')) return res.type(type).send(body);
  zlib.gzip(body, function (err, compressed) {
    if (err) return res.type(type).send(body);
    res.set('Content-Encoding', 'gzip').type(type).send(compressed);
  });
}
function assets(root) {
  const directory = path.join(root, 'assets'), files = new Map();
  if (fs.existsSync(directory)) fs.readdirSync(directory).filter(function (name) { return /\.(js|css)\.gz$/.test(name); }).forEach(function (name) {
    files.set('/assets/' + name.slice(0, -3), path.join(directory, name));
  });
  return function (req, res, next) {
    res.vary('Accept-Encoding');
    const file = files.get(req.path);
    if (!['GET','HEAD'].includes(req.method) || !file || !req.get('Accept-Encoding') || !req.acceptsEncodings('gzip')) return next();
    res.set('Content-Encoding', 'gzip').set('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(path.extname(req.path)); res.sendFile(file);
  };
}
module.exports = { sendPrepared, assets, sendHtml: function (res, html) { sendBody(res, html, 'html'); } };
