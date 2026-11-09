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
