'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createHttpHandler } = require('../server-http');
const inventory = require('../managed-files');
const root = path.resolve(__dirname, '..');
(async () => {

  for (const name of inventory.DEPLOY_FILES) assert(fs.existsSync(path.join(root, name)), `missing deployment file ${name}`);
  assert.equal(new Set(inventory.SERVER_FILES).size, inventory.SERVER_FILES.length);
  for (const match of fs.readFileSync(path.join(root, 'public/index.html'), 'utf8').matchAll(/(?:src|href)="\/([^"#]+)"/g)) {
    if (match[1] === 'favicon.ico') continue;
    const relative = inventory.SERVER_FILES.includes(match[1]) ? match[1] : 'public/' + match[1];
    assert(inventory.SERVER_FILES.includes(relative), `asset missing from update inventory: ${relative}`);
  }
  const { PendingRequests } = require('../pending-requests');
  const pending = new PendingRequests(20), owner = {};
  pending.set('one', owner); pending.set('two', {ws:owner}); pending.set('keep', {});
  pending.forgetSocket(owner); assert.equal(pending.size,1);
  await new Promise(resolve => setTimeout(resolve,40));
  assert.equal(pending.size,0); assert.equal(pending.expiry.size,0);
  console.log('PASS pending requests release owners on disconnect and timeout');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-install-'));
  try {
    const configPath = path.join(scratch, 'settings=value.json');
    fs.writeFileSync(configPath, '{"value":42}');
    const argv = process.argv;
    try {
      process.argv = ['node','fixture','--config='+configPath];
      assert.equal(require('../config-loader').loadConfig('unused',scratch).config.value,42);
      process.argv = ['node','fixture','--config'];
      assert.throws(() => require('../config-loader').loadConfig('unused',scratch), /requires a file path/);
    } finally { process.argv = argv; }
    fs.unlinkSync(configPath);

  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  console.log('PASS deployment inventory and configuration loading');

  const sent = [], socket = { readyState: 1, OPEN: 1, send: data => sent.push(JSON.parse(data)) };
  const config = { server: { tokens: { own: { user: 'test' }, other: { user: 'other' } } } };
  const handler = createHttpHandler({ root, config, agents: new Map([[socket, { id: 'a', user: 'test', lastOutput: '' }]]), getSupervisor: () => null, hasPrompt: () => false, maxActionBody: 100 });
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const action = (token, body) => fetch(url + '/api/action', { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
    assert.equal((await action(null, {agentId:'a',input:'x'})).status, 401);
    assert.equal((await action('other', {agentId:'a',input:'x'})).status, 404);
    assert.equal(sent.length, 0);
    assert.equal((await action('own', {agentId:'a',input:'你好\r'})).status, 200);
    assert.equal(Buffer.from(sent[0].payload, 'base64').toString(), '你好\r');
    assert.equal((await action('own', {agentId:'a',input:42})).status, 400);
    assert.equal((await action('own', null)).status, 400);
    assert.equal((await action('own', {agentId:'a',input:'x'.repeat(200)})).status, 413);
    for (const name of inventory.SERVER_FILES.filter(name => name.startsWith('public/'))) {
      const response = await fetch(url + '/' + name.slice(7) + '?version=test');
      assert.equal(response.status, 200, name); assert((await response.text()).length > 0);
    }
    assert.equal((await fetch(url + '/server.js')).status, 404);
    assert.equal((await fetch(url + '/config.json')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
  console.log('PASS HTTP authenticated input, user isolation, byte limits and allowlisted assets');
})().catch(error => { console.error(error); process.exitCode = 1; });
