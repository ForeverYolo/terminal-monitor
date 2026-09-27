'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFileSync } = require('child_process');
// Optional browser smoke test: set PLAYWRIGHT_MODULE and XTERM_FIT_JS to
// temporary installs so production dependencies remain unchanged.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const project = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swt-real-screen-'));
const session = `swt-isolated-${process.pid}`;
let server, client, browser;
let serverLog = '', clientLog = '';
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
async function until(fn, ms = 20000) { const end = Date.now() + ms; while (Date.now() < end) { try { if (await fn()) return; } catch {} await delay(150); } throw new Error('timeout'); }
function freePort() { return new Promise(resolve => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); }); }); }
function lines() { return Array.from({length: term.buffer.active.length}, (_, i) => term.buffer.active.getLine(i).translateToString(true)); }
(async () => {
  const port = await freePort();
  const generator = path.join(dir, 'generator.sh');
  fs.writeFileSync(generator, `#!/bin/bash\nsleep 4\nfor i in $(seq 1 240); do printf 'HIST-%04d\\r\\n' "$i"; sleep 0.01; done\nprintf '\\033[2A\\033[10C X'\ni=0\nwhile true; do i=$((i+1)); printf 'LIVE-%04d\\r\\n' "$i"; sleep 0.03; done\n`, {mode:0o755});
  execFileSync('screen', ['-dmS', session, 'bash', generator]);
  const serverCfg = path.join(dir, 'server.json');
  const clientCfg = path.join(dir, 'client.json');
  fs.writeFileSync(serverCfg, JSON.stringify({mode:'server',server:{host:'127.0.0.1',port,password:'isolated-pw',tokens:{'isolated-token':{user:'test'}},supervisor:{enabled:false}}}));
  fs.writeFileSync(clientCfg, JSON.stringify({mode:'client',client:{serverUrl:`ws://127.0.0.1:${port}`,token:'isolated-token',name:'isolated',screen:session,screenMode:'auto',clientId:'isolated-client'}}));
  server = spawn(process.execPath, [path.join(project, 'server.js'), `--config=${serverCfg}`], {cwd:project});
  server.stdout.on('data', x => serverLog += x); server.stderr.on('data', x => serverLog += x);
  await until(async () => (await fetch(`http://127.0.0.1:${port}/api/agents`)).ok);
  client = spawn(process.execPath, [path.join(project, 'client.js'), `--config=${clientCfg}`], {cwd:project});
  client.stdout.on('data', x => clientLog += x); client.stderr.on('data', x => clientLog += x);
  await until(async () => (await (await fetch(`http://127.0.0.1:${port}/api/agents`)).json()).agents.some(a => a.screen === session));
  await delay(5000);
  browser = await chromium.launch({headless:true, args:['--no-sandbox']});
  const page = await browser.newPage({viewport:{width:1200,height:800}});
  const pageErrors = []; page.on('pageerror', e => pageErrors.push(e.message));
  async function routeAssets(target) { await target.route('https://cdn.jsdelivr.net/**', route => {
    const url = route.request().url();
    let file, contentType;
    if (url.includes('xterm-addon-fit')) {file=process.env.XTERM_FIT_JS || require.resolve('xterm-addon-fit/lib/xterm-addon-fit.js');contentType='application/javascript';}
    else if (url.endsWith('/xterm.js')) {file=path.join(project,'node_modules/xterm/lib/xterm.js');contentType='application/javascript';}
    else if (url.endsWith('/xterm.css')) {file=path.join(project,'node_modules/xterm/css/xterm.css');contentType='text/css';}
    else return route.abort();
    return route.fulfill({path:file,contentType});
  }); }
  await routeAssets(page);
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('#username-input').fill('test');
  await page.locator('#password-input').fill('isolated-pw');
  await page.locator('.login-box button').click();
  await page.locator('.agent-card').first().waitFor();
  await page.locator('.agent-card').first().click();
  await page.waitForFunction(() => { if (typeof term === 'undefined' || !term) return false; return Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i).translateToString(true)).some(s=>s.includes('HIST-0020')); }, {timeout:15000});
  let first = await page.evaluate(lines);
  if (!first.some(s=>s.includes('HIST-0230')) || first.length < 150) throw new Error(`history short: ${first.length}, tail=${first.slice(-8).join('|')}`);
  console.log(`browser initial: ${first.length} buffer lines; early and late history visible`);
  const follower = await browser.newPage({viewport:{width:760,height:560}});
  follower.on('pageerror', e => pageErrors.push(e.message));
  await routeAssets(follower);
  await follower.goto(`http://127.0.0.1:${port}/`);
  await follower.locator('#username-input').fill('test');
  await follower.locator('#password-input').fill('isolated-pw');
  await follower.locator('.login-box button').click();
  await follower.locator('.agent-card').first().waitFor();
  await follower.locator('.agent-card').first().click();
  const secondSize = await follower.evaluate(() => fitAddon.proposeDimensions());
  await until(async () => await page.evaluate(size => term && term.cols === size.cols && term.rows === size.rows && !pendingSizeSnapshot.has(currentAgentId), secondSize));
  console.log(`second browser claimed ${secondSize.cols}x${secondSize.rows}; first followed`);
  const firstSize = await page.evaluate(() => fitAddon.proposeDimensions());
  await page.locator('#term-container .xterm').click();
  await page.keyboard.type('x');
  await until(async () => await follower.evaluate(size => term && term.cols === size.cols && term.rows === size.rows && !pendingSizeSnapshot.has(currentAgentId), firstSize));
  await delay(800);
  const stillFirstOwner = await follower.evaluate(size => term && term.cols === size.cols && term.rows === size.rows, firstSize);
  if (!stillFirstOwner) throw new Error('idle follower reclaimed terminal size after first browser input');
  console.log(`first browser input claimed ${firstSize.cols}x${firstSize.rows}; second followed`);
  await follower.setViewportSize({width:900,height:600});
  await follower.waitForFunction(size => {
    const next = fitAddon.proposeDimensions();
    return next && (next.cols !== size.cols || next.rows !== size.rows);
  }, secondSize);
  await delay(900);
  const resizedSecond = await follower.evaluate(() => fitAddon.proposeDimensions());
  await until(async () => await page.evaluate(size => term && term.cols === size.cols && term.rows === size.rows && !pendingSizeSnapshot.has(currentAgentId), resizedSecond));
  console.log(`second browser resize claimed ${resizedSecond.cols}x${resizedSecond.rows}; first followed`);
  await follower.close();
  await until(async () => await page.evaluate(size => term && term.cols === size.cols && term.rows === size.rows && !pendingSizeSnapshot.has(currentAgentId), firstSize));
  console.log('closing size owner restored remaining browser size');
  const multiPage = await browser.newPage({viewport:{width:680,height:500}});
  multiPage.on('pageerror', e => pageErrors.push(e.message));
  await routeAssets(multiPage);
  await multiPage.goto(`http://127.0.0.1:${port}/`);
  await multiPage.locator('#username-input').fill('test');
  await multiPage.locator('#password-input').fill('isolated-pw');
  await multiPage.locator('.login-box button').click();
  await multiPage.locator('.agent-card').first().waitFor();
  await multiPage.evaluate(() => { selectedAgents.add(lastAgents[0].id); openMultiTerminal(); });
  await multiPage.waitForFunction(() => Object.values(multiTerms).length === 1 &&
    lastSeqByAgent.has(Object.values(multiTerms)[0].agentId) &&
    !pendingSizeSnapshot.has(Object.values(multiTerms)[0].agentId));
  const multiSize = await multiPage.evaluate(() => {
    const entry = Object.values(multiTerms)[0];
    return { cols: entry.term.cols, rows: entry.term.rows };
  });
  await until(async () => await page.evaluate(size => term && term.cols === size.cols && term.rows === size.rows && !pendingSizeSnapshot.has(currentAgentId), multiSize));
  await multiPage.close();
  await until(async () => await page.evaluate(size => term && term.cols === size.cols && term.rows === size.rows && !pendingSizeSnapshot.has(currentAgentId), firstSize));
  console.log('multi-terminal browser claimed size and released ownership');
  for (let n=0;n<12;n++) { await page.setViewportSize({width: 800 + (n%3)*160, height: 520 + (n%2)*140}); await delay(80); }
  await delay(1200);
  const afterResize = await page.evaluate(lines);
  if (!afterResize.some(s=>s.includes('HIST-0020'))) throw new Error('history lost on resize');
  console.log(`after resize: ${afterResize.length} buffer lines; early history retained`);
  const oldLive = await page.evaluate(() => Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i).translateToString(true)).filter(s=>s.includes('LIVE-')).slice(-1)[0]);
  await page.evaluate(() => ws.close());
  await page.waitForFunction(old => { const a = Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i).translateToString(true)).filter(s=>s.includes('LIVE-')).slice(-1)[0]; return a && a !== old; }, oldLive, {timeout:12000});
  console.log('browser reconnect: live output resumed');
  if (pageErrors.length) throw new Error('page errors: ' + pageErrors.join('; '));
  console.log('PASS real GNU Screen + Chromium, all temporary');
})().catch(e => { console.error('FAIL',e.stack || e); console.error('SERVER',serverLog.slice(-1500)); console.error('CLIENT',clientLog.slice(-1500)); process.exitCode=1; }).finally(async () => {
  try { if(browser) await browser.close(); } catch {}
  try { if(client) client.kill(); } catch {}
  try { if(server) server.kill(); } catch {}
  try { execFileSync('screen',['-S',session,'-X','quit']); } catch {}
  fs.rmSync(dir,{recursive:true,force:true});
});
