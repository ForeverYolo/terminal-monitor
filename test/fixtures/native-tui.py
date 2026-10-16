#!/usr/bin/env python3
"""Deterministic full-screen pager for testing the real terminal transport."""
import os, sys, tty, termios, select, re, json, signal
log = sys.argv[1]
old = termios.tcgetattr(0)
page, wheels, keys = 90, 0, 0
pending = b''
def emit(s): os.write(1, s.encode())
def draw():
    rows, cols = os.get_terminal_size(0).lines, os.get_terminal_size(0).columns
    emit('\x1b[H\x1b[2J' + f'NATIVE-PAGER page={page:04d} wheel={wheels} keys={keys}')
    for n in range(min(rows-3, 20)):
        emit(f'\x1b[{n+2};1HROW-{page+n:04d} ' + ('content ' * 3))
    emit(f'\x1b[{rows};1HPageUp/PageDown, wheel, q exits\x1b[?25l')
def record(kind, raw):
    with open(log, 'a') as f: f.write(json.dumps({'kind':kind,'hex':raw.hex(),'page':page})+'\n')
signal.signal(signal.SIGWINCH, lambda *args: draw())
try:
    tty.setraw(0)
    emit('NORMAL-BEFORE\r\n\x1b[?1049h\x1b[?1000h\x1b[?1006h')
    draw()
    while True:
        if not select.select([0], [], [], 0.1)[0]: continue
        pending += os.read(0, 4096)
        while pending:
            sgr = re.match(rb'\x1b\[<(\d+);(\d+);(\d+)([Mm])', pending)
            if sgr:
                raw = sgr[0]; button=int(sgr[1]);pending=pending[len(raw):]
                if button in (64,65):
                    page=max(0,page+(-3 if button==64 else 3));wheels+=1;record('wheel-sgr',raw);draw()
                continue
            if pending.startswith(b'\x1b[M'):
                if len(pending)<6: break
                raw=pending[:6];pending=pending[6:];button=raw[3]-32
                if button in (64,65):
                    page=max(0,page+(-3 if button==64 else 3));wheels+=1;record('wheel-x10',raw);draw()
                continue
            found=False
            for seq, delta in [(b'\x1b[5~',-10),(b'\x1b[6~',10),(b'\x1b[F',999),(b'\x1bOF',999)]:
                if pending.startswith(seq):
                    pending=pending[len(seq):];page=90 if delta==999 else max(0,page+delta);keys+=1;record('key',seq);draw();found=True;break
            if found: continue
            if pending.startswith(b'\x1b') and len(pending)<6: break
            raw=pending[:1];pending=pending[1:]
            if raw==b'q':
                emit('\x1b[?1000l\x1b[?1006l\x1b[?1049l\x1b[?25hNORMAL-AFTER\r\n')
                record('exit',raw)
                # Leave the shell/normal screen alive for exit/snapshot assertions.
                while True: select.select([0],[],[],1)
            record('other',raw)
finally:
    termios.tcsetattr(0, termios.TCSANOW, old)
