const Redis = require('ioredis');
const settings = require('../../config/DBsettings');
module.exports = function createRedis() {
  const client = new Redis({ host: settings.REDIS_HOST, port: settings.REDIS_PORT, password: settings.REDIS_PASSWORD || undefined, connectTimeout: 5000, lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false });
  client.on('error', function () {});
  return client;
};
