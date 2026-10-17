'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCREEN_TERM = 'tm-web-256color';
// Screen 4.x interprets SGR 3 as standout, whose xterm default is inverse.
// A separate display type preserves that distinction without changing the
// task's TERM, another attached display, or the user's xterm capability entry.
const SOURCE = `${SCREEN_TERM}|Terminal Monitor web display,
  smso=\\E[3m, rmso=\\E[23m,
  use=xterm-256color,
`;

function prepareScreenTerminal(home = os.userInfo().homedir) {
  // An already-running Screen server looks up the attaching display's TERM
  // in its own environment. A client-only TERMINFO directory or -c screenrc
  // cannot configure that server, so install a uniquely named user entry.
  const database = path.join(home, '.terminfo');
  fs.mkdirSync(database, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(database, '.tm-web-'));
  try {
    // Use the compiler from Screen's system ncurses installation when present.
    const tic = fs.existsSync('/usr/bin/tic') ? '/usr/bin/tic' : 'tic';
    execFileSync(tic, ['-x', '-o', scratch, '-'], { input: SOURCE, stdio: ['pipe', 'pipe', 'pipe'] });
    // ncurses uses a character or hexadecimal directory, depending on build.
    const prefix = ['t', '74'].find(dir => fs.existsSync(path.join(scratch, dir, SCREEN_TERM)));
    if (!prefix) throw new Error('tic did not produce the terminal entry');
    const destination = path.join(database, prefix);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
    // Publish atomically even when several monitoring clients start together.
    fs.renameSync(path.join(scratch, prefix, SCREEN_TERM), path.join(destination, SCREEN_TERM));
    return SCREEN_TERM;
  } catch (error) {
    throw new Error(`Cannot prepare Screen terminal capabilities; install ncurses-bin (tic) and check ${database}: ${error.message}${error.signal ? ` (${error.signal})` : ''}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// Only sessions created by this project get these defaults. Attaching to an
// existing session must not change its environment or character-width rules.
function startScreenSession(name, command, environment = process.env) {
  // Share the exact startup path used by local/remote restart scripts.
  execFileSync('bash', ['-c',
    'source "$1" || exit; shift; start_managed_screen "$@"',
    'tm-screen-start', path.join(__dirname, 'service-runtime.sh'), name, '--', ...command],
  { env: { ...environment }, encoding: 'utf8' });
}

module.exports = { prepareScreenTerminal, startScreenSession, SCREEN_TERM };
