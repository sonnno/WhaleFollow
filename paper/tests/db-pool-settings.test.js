const test = require('node:test');
const assert = require('node:assert/strict');
test('all project pool connections avoid parallel shared-memory allocation', function (t) {
  let options;
  const modulePath = require.resolve('typeorm'), real = require('typeorm');
  require('../server/db/entities');
  require.cache[modulePath].exports = { ...real, DataSource: function (value) { options = value; this.manager = {}; } };
  const path = require.resolve('../server/db/adapter'); delete require.cache[path];
  t.after(function () { require.cache[modulePath].exports = real; delete require.cache[path]; });
  require(path).create();
  assert.match(options.extra.options || '', /-c max_parallel_workers_per_gather=0/);
});
