'use strict';
const assert = require('assert');
const { stripAnsi } = require('../terminal-text');
const { validateSpawnRequest } = require('../spawn-validator');

assert.equal(stripAnsi('\x1b[1;32mhello\x1b[0m \x1b]0;title\x07world'), 'hello world');
assert.equal(stripAnsi('\x1b]0;title\x1b\\user@host:~$ \x1b[0m\r\n'), 'user@host:~$ \n');
assert.equal(stripAnsi(null), '');
assert.equal(stripAnsi(''), '');

for (const [input, ok] of [
  [{ screenName: 'my-node-1', cmd: 'bash' }, true],
  [{ screenName: 'my_node', cmd: 'claude' }, true],
  [{ screenName: 'a'.repeat(40), cmd: 'sh' }, true],
  [{ screenName: '', cmd: 'bash' }, false],
  [{ screenName: 'has space', cmd: 'bash' }, false],
  [{ screenName: 'a'.repeat(41), cmd: 'bash' }, false],
  [{ screenName: 'ok;rm', cmd: 'bash' }, false],
  [{ screenName: 'ok', cmd: 'rm' }, false],
  [{ screenName: 'ok', cmd: '' }, true],
  [{ screenName: 'ok', cmd: 'reboot' }, false],
  [{ screenName: undefined, cmd: undefined }, false]
]) assert.equal(validateSpawnRequest(input).ok, ok, JSON.stringify(input));
console.log('PASS plain-text terminal previews and spawn validation');

// Newer Node exposes navigator without a DOM. Exercise a cold dependency
// import in a separate process so this cannot pass through require caching.
const { spawnSync } = require('child_process');
const startup = spawnSync(process.execPath, ['-e', `
  const assert = require('assert');
  const expectedNavigator = { userAgent: 'Node.js/test', platform: 'Linux x86_64' };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: expectedNavigator });
  const { TerminalState } = require(process.argv[1]);
  assert.strictEqual(globalThis.navigator, expectedNavigator);
  const state = new TerminalState(80, 24, () => {});
  state.write(Buffer.from('Node runtime ready'));
  state.snapshot(() => {
    assert(state.readScreen()[0].includes('Node runtime ready'));
    state.dispose();
    console.log('PASS headless startup with Node navigator and global restoration');
  });
`, require.resolve('../terminal-state')], {encoding: 'utf8', timeout: 10000});
assert.equal(startup.status, 0, startup.stderr.split('\n').filter(line => line.length < 1000).join('\n'));
process.stdout.write(startup.stdout);
