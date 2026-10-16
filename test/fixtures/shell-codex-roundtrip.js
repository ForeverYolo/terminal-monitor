'use strict';
const assert=require('assert');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=30000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await delay(150);}throw Error('shell/Codex transition timed out');}
const allLines=()=>Array.from({length:term.buffer.active.length},(_,i)=>term.buffer.active.getLine(i).translateToString(true)).join('\n');
const visible=()=>Array.from({length:term.rows},(_,i)=>term.buffer.active.getLine(term.buffer.active.baseY+i)?.translateToString(true)||'').join('\n');
module.exports=async function roundtrip(page,argv,pass){
 async function exitCodex(){
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Control+c');await delay(400);await page.keyboard.press('Control+c');
  await until(async()=>await page.evaluate(()=>term.modes.mouseTrackingMode==='none'));
  await until(async()=>(await page.evaluate(visible)).includes('staging-2080:'));
  assert.equal(await page.evaluate(()=>term.buffer.active.type),'normal');
  await until(async()=>await page.locator('#btn-scroll-latest').isEnabled());
 }
 async function run(command){await page.evaluate(s=>send(s+'\r'),command);}
 async function scrollShell(){
  await page.evaluate(()=>document.getElementById('btn-scroll-latest').click());
  const before=await page.evaluate(()=>term.buffer.active.viewportY);
  const box=await page.locator('#term-container .xterm-screen').boundingBox();
  await page.mouse.move(box.x+80,box.y+80);await page.mouse.wheel(0,-600);
  await until(async()=>await page.evaluate(y=>term.buffer.active.viewportY<y,before));
  const wheel=await page.evaluate(()=>term.buffer.active.viewportY);
  await page.evaluate(()=>scrollTermPages(-1));
  await until(async()=>await page.evaluate(y=>term.buffer.active.viewportY<y,wheel));
  await page.evaluate(()=>document.getElementById('btn-scroll-latest').click());
  assert.equal(await page.evaluate(()=>term.buffer.active.viewportY),await page.evaluate(()=>term.buffer.active.baseY));
 }
 async function stylesMatch(){
  return page.evaluate(()=>{
   const b=term.buffer.active;
   for(let i=0;i<b.length;i++){
    const line=b.getLine(i),text=line.translateToString(true);
    if(!text.startsWith('STYLE-ITALIC')||!text.includes('STYLE-PLAIN'))continue;
    return [['STYLE-ITALIC',true,false],['STYLE-INVERSE',false,true],['STYLE-BOTH',true,true],['STYLE-PLAIN',false,false]].every(([word,italic,inverse])=>{
     const cell=line.getCell(text.indexOf(word));
     return !!cell.isItalic()===italic && !!cell.isInverse()===inverse;
    });
   }
   return false;
  });
 }
 await exitCodex();
 await run("printf 'SHELL-HISTORY-%03d\\n' {0..239}");
 await until(async()=>(await page.evaluate(allLines)).includes('SHELL-HISTORY-239'));
 await run("printf '\\033[3mSTYLE-ITALIC\\033[23m \\033[7mSTYLE-INVERSE\\033[27m \\033[3;7mSTYLE-BOTH\\033[0m STYLE-PLAIN\\n'");
 await until(stylesMatch);pass('shell preserves italic, inverse, combined and reset styles through the actual client');
 await scrollShell();pass('Codex exits to shell: wheel, page controls and Latest scroll browser history');
 const oldBase=await page.evaluate(()=>term.buffer.active.baseY);
 await page.reload();await page.locator('.agent-card').first().click();
 await until(async()=>(await page.evaluate(allLines)).includes('SHELL-HISTORY-020'));
 await until(stylesMatch);pass('fresh snapshot preserves shell italic and inverse styles');
 assert.equal(await page.evaluate(()=>term.modes.mouseTrackingMode),'none');await scrollShell();
 pass('shell history and scrolling survive a fresh browser snapshot');
 // Quote every argument as POSIX shell text; no prompt/model request is made.
 const command=argv.map(s=>"'"+s.replace(/'/g,"'\\''")+"'").join(' ');
 await run(command);
 await until(async()=>await page.evaluate(()=>term.modes.mouseTrackingMode!=='none'));
 await until(async()=>(await page.evaluate(visible)).includes('history line 49:4'));
 assert(await page.locator('#btn-scroll-latest').isDisabled());
 assert((await page.evaluate(allLines)).includes('SHELL-HISTORY-020'));
 const box=await page.locator('#term-container .xterm-screen').boundingBox();await page.mouse.move(box.x+80,box.y+80);await page.mouse.wheel(0,-600);
 await until(async()=>{const text=await page.evaluate(visible);return /ANSWER-\d+/.test(text)&&!text.includes('history line 49:4');});
 pass('shell re-enters real Codex: wheel pages application history while shell history is retained');
 await exitCodex();assert((await page.evaluate(allLines)).includes('SHELL-HISTORY-020'));
 assert(await page.evaluate(y=>term.buffer.active.baseY>=y,oldBase));await scrollShell();
 pass('second Codex exit restores shell scrolling and preserves earlier shell output');
 await run(command);
 await until(async()=>await page.evaluate(()=>term.modes.mouseTrackingMode!=='none'));
 await until(async()=>(await page.evaluate(visible)).includes('history line 49:4'));
};
