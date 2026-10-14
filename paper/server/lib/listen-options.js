function listenOptions(env) {
  env = env || process.env;
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer between1 and65535');
  return { host: env.HOST || '127.0.0.1', port };
}
module.exports = { listenOptions };
