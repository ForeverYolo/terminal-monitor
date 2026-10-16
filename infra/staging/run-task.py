#!/usr/bin/env python3
import json, os, signal, subprocess, termios
from pathlib import Path
root = Path(__file__).resolve().parent.parent
settings = json.loads((root / 'runtime/settings.json').read_text())
os.environ['PATH'] = str(Path(settings['node']).parent) + ':/usr/local/bin:/usr/bin:/bin'
os.environ['LANG'] = os.environ['LC_ALL'] = 'C.UTF-8'
for key, value in settings.get('taskEnvironment', {}).items():
    if key in {'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'}:
        os.environ[key] = value
os.chdir(root / 'runtime/sandbox')
argv = json.loads((root / 'runtime/codex-command.json').read_text())
os.environ['CODEX_HOME'] = str(root / 'runtime/codex-home')
# Keep the Screen window alive when Codex exits or crashes. The wrapper stays
# in the foreground process group; let Codex handle Ctrl-C without terminating
# the wrapper itself. exec resets this caught handler in the child.
signal.signal(signal.SIGINT, lambda *_: None)
terminal_settings = termios.tcgetattr(0)
try:
    result = subprocess.run(argv)
    status = result.returncode
except OSError as error:
    print(f'Codex 启动失败：{error}', flush=True)
    status = 127
finally:
    termios.tcsetattr(0, termios.TCSANOW, terminal_settings)
print('\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?25h\x1b[0m', end='', flush=True)
print(f'\r\nCodex 已退出（状态 {status}），测试 Screen 会话保留。', flush=True)
print(f'重新进入：codex --no-daemon resume {argv[argv.index("resume") + 1]}', flush=True)
os.environ['PS1'] = 'staging-2080:\\w\\$ '
os.execvp('bash', ['bash', '--noprofile', '--norc', '-i'])
