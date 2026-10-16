'use strict';
const { spawn } = require('child_process');
const path = require('path');
const groups = {
  unit: ['deploy', 'supervisor-lifecycle', 'file-transfer', 'refactor-contracts', 'detector', 'terminal-snapshot', 'native-tui', 'screen-relay-scroll', 'analyzer'],
  protocol: ['local', 'stable-resume', 'snapshot-protocol', 'offline-queue', 'register-query', 'multiproc-update', 'running-hash'],
  screen: ['service-restart', 'restart', 'staging-shell'],
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
        let timer;
        const finish = error => {
          clearTimeout(timer); process.off('SIGINT', stop);
          error ? reject(error) : resolve();
        };
        timer = setTimeout(() => {
          child.kill('SIGTERM');
          const force = setTimeout(() => child.kill('SIGKILL'), 2000);
          force.unref();
          finish(Error(`${test} timed out`));
        }, 180000);
        child.once('error', finish);
        child.once('exit', code => finish(code === 0 ? null : Error(`${test} exited with ${code}`)));
      });
    }
  }
  console.log('\nPASS selected test groups');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
