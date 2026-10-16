'use strict';
const { spawn } = require('child_process');
const path = require('path');
const groups = {
  unit: ['detector', 'terminal-snapshot', 'native-tui', 'screen-relay-scroll', 'analyzer'],
  protocol: ['local', 'stable-resume', 'snapshot-protocol', 'offline-queue', 'register-query', 'multiproc-update', 'running-hash'],
  screen: ['restart', 'staging-shell'],
  browser: ['real-screen-browser', 'native-tui-browser', 'scroll-region-browser'],
  codex: ['native-codex-browser'],
};
const selected = process.argv.slice(2);
if (!selected.length) selected.push('unit', 'protocol');
if (selected.includes('all')) selected.splice(0, selected.length, ...Object.keys(groups));
for (const name of selected) if (!groups[name]) { console.error('Unknown group:', name); process.exit(1); }
(async () => {
  for (const name of selected) {
    for (const test of groups[name]) {
      console.log(`\n[${name}] ${test}`);
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, `test-${test}.js`)], { stdio: 'inherit' });
        const stop = () => child.kill('SIGTERM');
        process.once('SIGINT', stop);
        const timer = setTimeout(() => { child.kill('SIGTERM'); reject(Error(`${test} timed out`)); }, 180000);
        child.once('error', reject);
        child.once('exit', code => {
          clearTimeout(timer); process.off('SIGINT', stop);
          code === 0 ? resolve() : reject(Error(`${test} exited with ${code}`));
        });
      });
    }
  }
  console.log('\nPASS selected test groups');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
