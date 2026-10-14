const path = require('node:path');
try {
  require('./runtime').load(process.env.RUNTIME_DIR || '/var/lib/whalefollow');
  const programs = { migrate: '../scripts/db-init.js', api: '../server/index.js', worker: '../server/worker.js' };
  const role = process.argv[2];
  if (!Object.hasOwn(programs, role)) throw new Error('Expected migrate, api or worker');
  require(path.join(__dirname, programs[role]));
} catch (err) { console.error('Container startup failed:', err.message); process.exitCode = 1; }
