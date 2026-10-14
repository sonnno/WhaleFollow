const { HttpsProxyAgent } = require('https-proxy-agent');
const proxy = process.env.POLYMARKET_PROXY_URL || process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
module.exports = proxy ? new HttpsProxyAgent(proxy, { keepAlive: true, maxSockets: 8, maxFreeSockets: 4 }) : undefined;
