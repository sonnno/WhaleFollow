const async = require('async');
const { sendHtml } = require('./web-response-service');
function create(home, template) {
  return function (req, res) {
    const initial = { user: req.session?.user || null, data: {} };
    res.set('Cache-Control', 'private, no-store'); res.vary('Cookie');
    function send() {
      // Never let a trader name or other value terminate the inline JSON script.
      const json = JSON.stringify(initial).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      sendHtml(res, template.replace('</head>', function () { return '<script>window.__WHALE_BOOTSTRAP__=' + json + ';</script></head>'; }));
    }
    if (!initial.user) return send();
    async.each(['summary', 'settings'], function (name, next) {
      home[name](function (err, value) { if (!err) initial.data[name === 'summary' ? '/cash-summary' : '/settings'] = value; next(); });
    }, send);
  };
}
module.exports = { create };
