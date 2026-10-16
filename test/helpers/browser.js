'use strict';
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const project = path.resolve(__dirname, '../..');

async function launchBrowser() {
  return chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] });
}

async function routeTerminalAssets(page) {
  await page.route('https://cdn.jsdelivr.net/**', route => {
    const url = route.request().url();
    let file;
    if (url.includes('xterm-addon-fit')) file = process.env.XTERM_FIT_JS || require.resolve('xterm-addon-fit/lib/xterm-addon-fit.js');
    else if (url.endsWith('/xterm.js')) file = path.join(project, 'node_modules/xterm/lib/xterm.js');
    else if (url.endsWith('/xterm.css')) file = path.join(project, 'node_modules/xterm/css/xterm.css');
    return file ? route.fulfill({ path: file, contentType: url.endsWith('.css') ? 'text/css' : 'application/javascript' }) : route.abort();
  });
}

async function login(page, url, { username = 'test', password = 'pw' } = {}) {
  await page.goto(url);
  await page.locator('#username-input').fill(username);
  await page.locator('#password-input').fill(password);
  await page.locator('.login-box button').click();
}
module.exports = { launchBrowser, routeTerminalAssets, login };
