try {
  const credentials = require('./runtime').load(process.env.RUNTIME_DIR || '/var/lib/whalefollow', {});
  console.log('Username:', credentials.ADMIN_USERNAME);
  console.log('Password:', credentials.ADMIN_PASSWORD);
} catch (err) { console.error('Cannot read administrator login:', err.message); process.exitCode = 1; }
