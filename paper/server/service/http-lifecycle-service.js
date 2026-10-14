function registerRefreshStream(streams, response, closing) {
  if (closing) { response.statusCode = 503; response.setHeader('Connection', 'close'); response.end(); return false; }
  streams.add(response); return true;
}
function closeServer(server, streams, callback) {
  // SSE stays open indefinitely; end it before waiting for server.close.
  streams.forEach(function (response) { response.end(); });
  if (!server) return callback();
  server.close(function (err) { callback(err && err.code !== 'ERR_SERVER_NOT_RUNNING' ? err : null); });
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
}
module.exports = { closeServer, registerRefreshStream };
