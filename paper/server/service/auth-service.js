const crypto = require('node:crypto');
const session = require('express-session');
const async = require('async');

class DatabaseSessionStore extends session.Store {
  constructor(db) { super(); this.db = db; }
  get(id, callback) {
    this.db.one('Setting', { where: { id: 'session:' + id } }, function (err, row) {
      if (err) return callback(err);
      if (!row || Number(row.value.expires) < Date.now()) return callback(null, null);
      callback(null, row.value.session);
    });
  }
  set(id, value, callback) { this.db.save('Setting', { id: 'session:' + id, value: { session: value, expires: Date.now() + 12 * 3600000 } }, function (err) { callback(err); }); }
  destroy(id, callback) { this.db.query('DELETE FROM paper_settings WHERE id=$1', ['session:' + id], function (err) { callback(err); }); }
  touch(id, value, callback) { this.set(id, value, callback); }
}

function create() {
  const attempts = new Map();
  function login(username, password, address, callback) {
    const now = Date.now();
    const recent = (attempts.get(address) || []).filter(function (time) { return now - time < 60000; });
    attempts.set(address, recent);
    if (recent.length >= 10) return callback(Object.assign(new Error('登录尝试过多，请稍后重试'), { status: 429 }));
    recent.push(now);
    if (attempts.size > 1000) attempts.clear();
    let expected, actual;
    async.waterfall([
      function (next) { crypto.pbkdf2(process.env.ADMIN_PASSWORD, 'paper-admin', 100000, 32, 'sha256', next); },
      function (result, next) { expected = result; crypto.pbkdf2(String(password || ''), 'paper-admin', 100000, 32, 'sha256', next); },
      function (result, next) {
        actual = result;
        if (username !== (process.env.ADMIN_USERNAME || 'admin') || !crypto.timingSafeEqual(expected, actual)) return next(Object.assign(new Error('用户名或密码错误'), { status: 401 }));
        attempts.delete(address); next(null, { username });
      }
    ], callback);
  }
  return { login };
}
module.exports = { create, DatabaseSessionStore };
