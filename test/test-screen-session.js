'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { startScreenSession } = require('../screen-terminal');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm screen session '));
const managed = `tm-managed-${process.pid}`;
const ordinary = `tm-ordinary-${process.pid}`;
const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function command(file) {
  return [process.execPath, '-e', `
    require('fs').writeFileSync(process.argv[1], JSON.stringify({
      colorterm: process.env.COLORTERM ?? null, term: process.env.TERM, parent: process.ppid
    }));
    process.stdout.write('A─B·C✻D');
    setInterval(() => {}, 1000);
  `, file];
}
async function info(name, file, expectedColumn) {
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(file)) {
      const output = execFileSync('screen', ['-S', name, '-Q', 'info'], { encoding: 'utf8' });
      if (output.startsWith(`(${expectedColumn},1)`)) return JSON.parse(fs.readFileSync(file));
    }
    await delay(50);
  }
  throw Error(`Session ${name} did not reach column ${expectedColumn}`);
}
(async () => {
  const ordinaryFile = path.join(directory, 'ordinary.json');
  execFileSync('screen', ['-c', '/dev/null', '-dmS', ordinary, ...command(ordinaryFile)], { env });
  const before = await info(ordinary, ordinaryFile, 10);
  assert.equal(before.colorterm, 'truecolor');

  const managedFile = path.join(directory, 'managed.json');
  startScreenSession(managed, command(managedFile), env);
  const result = await info(managed, managedFile, 8);
  assert.equal(result.colorterm, null);
  assert.equal(result.term, 'screen');
  const serverEnv = fs.readFileSync(`/proc/${result.parent}/environ`).toString().split('\0');
  assert(!serverEnv.some(entry => entry.startsWith('COLORTERM=')), 'Screen server inherited COLORTERM');
  assert.equal(env.COLORTERM, 'truecolor', 'caller environment changed');
  await info(ordinary, ordinaryFile, 10);
  console.log('PASS new managed Screen clears COLORTERM before server startup and uses narrow symbols; ordinary session unchanged');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  for (const name of [managed, ordinary]) {
    try { execFileSync('screen', ['-S', name, '-X', 'quit'], { stdio: 'ignore' }); } catch {}
  }
  fs.rmSync(directory, { recursive: true, force: true });
});
