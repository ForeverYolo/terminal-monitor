'use strict';
const assert = require('assert');
const { createSupervisor } = require('../supervisor');
  const timers = new Map(); let next = 0;
  const fakeTimers = {
    setInterval: callback => { const id = ++next; timers.set(id, callback); return id; },
    setTimeout: callback => { const id = ++next; timers.set(id, callback); return id; },
    clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id)
  };
  const supervisor = createSupervisor({ analyzerAgentName: 'fixture' }, {
    timers: fakeTimers, getAgents: () => [], broadcastToBrowsers: () => {}
  });
  supervisor.start(); supervisor.start();
  assert.equal(timers.size, 5, 'start must be idempotent');
  supervisor.stop(); assert.equal(timers.size, 0, 'stop must cancel every owned timer');
  supervisor.start(); supervisor.stop(); assert.equal(timers.size, 0);
  console.log('PASS supervisor start/stop owns all timers and supports restart');
