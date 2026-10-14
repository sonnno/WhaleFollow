const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const fields = { ADMIN_USERNAME: 'adminUsername', ADMIN_PASSWORD: 'adminPassword', SESSION_SECRET: 'sessionSecret', POSTGRES_PASSWORD: 'postgresPassword' };
function validate(value) {
  if (!value || value.version !== 1) throw new Error('Invalid runtime credentials version');
  if (typeof value.adminUsername !== 'string' || !value.adminUsername.trim() || value.adminUsername.length > 100) throw new Error('ADMIN_USERNAME is invalid');
  ['adminPassword', 'postgresPassword'].forEach(function (key) { if (typeof value[key] !== 'string' || !value[key] || /[\r\n\0]/.test(value[key])) throw new Error('Invalid runtime password'); });
  if (typeof value.sessionSecret !== 'string' || value.sessionSecret.length < 32) throw new Error('SESSION_SECRET requires at least32 characters');
  return value;
}
function read(dir) { return validate(JSON.parse(fs.readFileSync(path.join(dir, 'credentials.json'), 'utf8'))); }
function bootstrap(dir, env) {
  env = env || {};
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) throw new Error('SESSION_SECRET requires at least32 characters');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, 'credentials.json');
  let value;
  if (fs.existsSync(target)) {
    value = read(dir);
    Object.keys(fields).forEach(function (key) { if (env[key] && env[key] !== value[fields[key]]) throw new Error(key + ' mismatch: credentials already generated; preserve the runtime volume'); });
  } else {
    value = validate({ version: 1, adminUsername: env.ADMIN_USERNAME || 'admin', adminPassword: env.ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url'), sessionSecret: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), postgresPassword: env.POSTGRES_PASSWORD || crypto.randomBytes(32).toString('hex') });
    fs.writeFileSync(target, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  }
  const passwordFile = path.join(dir, 'postgres-password');
  if (fs.existsSync(passwordFile)) { if (fs.readFileSync(passwordFile, 'utf8') !== value.postgresPassword + '\n') throw new Error('PostgreSQL password file mismatch; existing state preserved'); }
  else fs.writeFileSync(passwordFile, value.postgresPassword + '\n', { flag: 'wx', mode: 0o600 });
  return value;
}
function load(dir, target) {
  const value = read(dir);
  target = target || process.env;
  Object.keys(fields).forEach(function (key) { target[key] = value[fields[key]]; });
  return target;
}
module.exports = { bootstrap, load };
