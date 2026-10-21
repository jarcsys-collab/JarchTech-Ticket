const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createServer } = require('../server.cjs');
test('static server serves the prototype and blocks source traversal', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method }, res => {
      let body = ''; res.on('data', b => body += b); res.on('end', () => resolve({ status: res.statusCode, body, type: res.headers['content-type'] }));
    }); req.on('error', reject); req.end();
  });
  try {
    const index = await request('/'); assert.equal(index.status, 200); assert.match(index.body, /JarcTech Ticket/);
    const js = await request('/projects.js'); assert.equal(js.status, 200); assert.match(js.type, /javascript/);
    assert.equal((await request('/%2e%2e%2fpackage.json')).status, 403);
    assert.equal((await request('/missing.js')).status, 404);
    assert.equal((await request('/%ZZ')).status, 400);
    assert.equal((await request('/', 'POST')).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
