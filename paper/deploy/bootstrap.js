try {
  require('./runtime').bootstrap(process.env.RUNTIME_DIR || '/var/lib/whalefollow', process.env);
  console.log('Persistent credentials ready. Read administrator login with docker compose exec api node deploy/show-login.js');
} catch (err) { console.error('Credential initialization failed:', err.message); process.exitCode = 1; }
