'use strict';
const assert=require('assert');
const {Terminal}=require('xterm-headless');
const {TerminalState}=require('../terminal-state');
const {createAltScreenFilter}=require('../terminal-filter');
const snapshot=state=>new Promise(r=>state.snapshot(r));
const lines=term=>Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i).translateToString(true));
(async()=>{
 const state=new TerminalState(50,8,()=>{});
 state.write('\x1b[?104');state.write('9h');
 for(let i=0;i<100;i++)state.write(`SHELL-${String(i).padStart(3,'0')}\r\n`);
 await snapshot(state);assert.equal(state.term.buffer.active.type,'normal');const base=state.term.buffer.active.baseY;
 assert(base>80);
 state.write('\x1b[?1049;1003;1006h\x1b[?25l\x1b[H\x1b[3J\x1b[2J\x1b[41;7mTUI-PAGE\x1b[0m');
 const tui=await snapshot(state);assert.equal(state.term.modes.mouseTrackingMode,'any');assert.equal(state.term.buffer.active.type,'normal');
 assert.equal(state.term.buffer.active.baseY,base);assert(lines(state.term).some(l=>l==='SHELL-020'),'TUI cleared shell history');
 const restored=new Terminal({allowProposedApi:true,cols:50,rows:8,scrollback:5000});await new Promise(r=>restored.write(Buffer.from(tui.payload,'base64'),r));
 assert.deepStrictEqual(lines(restored),lines(state.term));assert.equal(restored.modes.mouseTrackingMode,'any');
 assert(Buffer.from(tui.payload,'base64').toString().includes('\x1b[?1006h'));
 state.write('\x1b[?1003;1006l\x1b[?1049l\x1b[?25h\r\nSHELL-RETURN\r\n');
 for(let i=0;i<100;i++)state.write(`AFTER-${String(i).padStart(3,'0')}\r\n`);
 const shell=await snapshot(state);assert.equal(state.term.modes.mouseTrackingMode,'none');assert(state.term.buffer.active.baseY>base);
 assert(lines(state.term).some(l=>l==='SHELL-020'));assert(lines(state.term).some(l=>l==='AFTER-020'));
 restored.reset();await new Promise(r=>restored.write(Buffer.from(shell.payload,'base64'),r));assert.deepStrictEqual(lines(restored),lines(state.term));assert.equal(restored.modes.mouseTrackingMode,'none');
 for(const mode of ['47','1047','1049']){const filter=createAltScreenFilter();assert.equal(Buffer.from(filter(Buffer.from(`\x1b[?${mode}h\x1b[?${mode}l`))).length,0);}
 state.dispose();restored.dispose();console.log('PASS outer Screen virtualization, combined/split switches, native mouse, shell history before/after TUI, TUI/shell snapshot restores');
})().catch(e=>{console.error(e);process.exitCode=1;});
