const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const target = path.join(__dirname, '../.env');
if (fs.existsSync(target)) { console.log('.env already exists; preserving configuration'); }
else {
  let content = fs.readFileSync(path.join(__dirname, '../.env.example'), 'utf8');
  content = content.replace('ADMIN_PASSWORD=\n', 'ADMIN_PASSWORD=' + crypto.randomBytes(12).toString('base64url') + '\n');
  content = content.replace('SESSION_SECRET=\n', 'SESSION_SECRET=' + crypto.randomBytes(32).toString('hex') + '\n');
  fs.writeFileSync(target, content, { mode: 0o600, flag: 'wx' });
  console.log('Local .env created. Administrator credentials are stored in .env.');
}
