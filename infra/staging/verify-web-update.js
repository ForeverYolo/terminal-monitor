'use strict';
// Exercise the actual management buttons on the explicitly marked test server.
// It only restarts staging monitor processes; it never sends terminal input.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');
const {chromium} = require('playwright');
const root = process.env.STAGING_ROOT || '/home/renhangqi/terminal-monitor-staging';
const access = JSON.parse(fs.readFileSync(path.join(root, 'runtime/access.json')));
const output = path.join(root, 'runtime/web-update-verification');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(200); }
  throw Error('Timed out: ' + label);
}
function taskPid() {
  return execFileSync('screen', ['-ls'], {encoding: 'utf8'}).match(/\b(\d+)\.swt-staging-codex\s/)?.[1];
}
let browser;
(async () => {
  const metadata = await (await fetch(new URL('staging.json', access.url))).json();
  assert.equal(metadata.environment, 'staging', 'refuse to operate on a production endpoint');
  const before = taskPid(); assert(before, 'existing task Screen must be present');
  fs.mkdirSync(output, {recursive: true, mode: 0o700});
  browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  const messages = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try {
      const message = JSON.parse(frame.payload);
      if (message.type === 'auth_ok' && message.releaseStatus) messages.push({type: 'release_server_status', ...message.releaseStatus});
      if (['pull_update_result', 'push_update_result', 'restart_server_result', 'release_server_status'].includes(message.type)) messages.push(message);
    } catch {}
  }));
  await page.goto(access.url);
  await page.locator('#username-input').fill(access.username);
  await page.locator('#password-input').fill(access.password);
  await page.locator('.login-box button').click();
  await page.waitForFunction(() => lastAgents.length === 1 && lastAgents[0].updateProtocol === 1);
  await page.locator('#mode-mgmt-btn').click();
  await page.locator('button[onclick^="pullUpdateFromClient"]').click();
  const pulled = await until(() => messages.find(m => m.type === 'pull_update_result'), 'GUI pull completes');
  assert(pulled.ok && pulled.prepared, pulled.error || 'full release was not prepared');
  await page.screenshot({path: path.join(output, 'prepared.png')});
  console.log('PASS actual browser management pull prepares a complete release');
  await page.locator('#mgmt-panel details summary').click();
  await page.locator('button[onclick="restartServer()"]').click();
  await page.waitForFunction(id => lastServerReleaseId === id, pulled.releaseId, {timeout: 90000});
  await until(() => messages.find(m => m.type === 'release_server_status' && m.updateState?.id === pulled.releaseId && m.updateState.phase === 'completed'), 'server health completed');
  console.log('PASS actual browser server apply reconnects and passes health checks');
  await page.waitForFunction(() => lastAgents.length === 1 && ws.readyState === WebSocket.OPEN);
  await page.locator('button[onclick^="pushUpdateToClient"]').click();
  const pushed = await until(() => messages.find(m => m.type === 'push_update_result'), 'GUI push completes');
  assert(pushed.ok, pushed.error);
  assert.equal(pushed.releaseId, pulled.releaseId);
  assert.equal(taskPid(), before, 'task Screen PID must survive monitor and broker updates');
  await page.screenshot({path: path.join(output, 'applied.png')});
  assert.deepEqual(errors, []);
  const report = {url: access.url, commit: metadata.commit, releaseId: pulled.releaseId, taskPidUnchanged: true, browserErrors: errors, verifiedAt: new Date().toISOString(), checks: ['GUI pull', 'GUI server apply and reconnect', 'GUI client push with health confirmation', 'task Screen unchanged']};
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
  console.log('PASS actual browser client push, task Screen preserved and no browser errors');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); });
