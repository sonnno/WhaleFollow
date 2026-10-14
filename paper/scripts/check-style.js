const fs = require('node:fs');
const path = require('node:path');
const errors = [];
function scan(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) { if (name !== 'db') scan(file); continue; }
    if (!name.endsWith('.js')) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (/\basync\s+function|\bawait\s|\bnew\s+Promise|\.then\s*\(/.test(text)) errors.push(file);
  }
}
scan(path.join(__dirname, '../server'));
if (errors.length) { console.error('Promise style outside database boundary:', errors.join(', ')); process.exitCode = 1; }
else console.log('Callback service style verified');
