'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFileTransfer } = require('../file-transfer');
const root = fs.mkdtempSync(path.join(os.homedir(), '.swt-file-test-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 150; i++) { if (fn()) return; await pause(20); } throw Error('transfer timed out'); }
const reports = [];
const socket = { readyState: 1, OPEN: 1, bufferedAmount: 0 };
const transfer = createFileTransfer({ send: msg => { reports.push(msg); return true; }, getSocket: () => socket, getShellCwd: () => root });
(async () => {
  const content = Buffer.alloc(700000, 'a');
  await transfer.handle({ type:'file_upload_start', agentId:'a', uploadId:'up', filename:'sample', size:content.length });
  assert(reports.find(m => m.type === 'file_upload_ack').ok);
  for (let offset = 0, index = 0; offset < content.length; offset += 262144, index++) {
    await transfer.handle({ type:'file_chunk', agentId:'a', uploadId:'up', index, data:content.subarray(offset,offset+262144).toString('base64') });
    await until(() => reports.some(m => m.type === 'file_chunk_ack' && m.index === index));
  }
  await transfer.handle({ type:'file_upload_end', agentId:'a', uploadId:'up' });
  await until(() => reports.some(m => m.type === 'file_upload_done' && m.ok));
  assert.deepStrictEqual(fs.readFileSync(path.join(root,'sample')),content);
  socket.bufferedAmount = 2 * 1024 * 1024;
  await transfer.handle({ type:'file_download_start', agentId:'a', downloadId:'dl', path:'sample' });
  await until(() => reports.some(m => m.type === 'file_download_chunk'));
  await pause(100);
  assert(!reports.some(m => m.type === 'file_download_end'), 'download must pause under backpressure');
  socket.bufferedAmount = 0;
  await until(() => reports.some(m => m.type === 'file_download_end' && m.ok));
  const chunks = reports.filter(m => m.type === 'file_download_chunk').map(m => Buffer.from(m.data,'base64'));
  assert.deepStrictEqual(Buffer.concat(chunks), content);
  await transfer.handle({ type:'file_ls', agentId:'a', reqId:'ls', dir:'.' });
  assert(reports.find(m => m.reqId === 'ls').entries.some(e => e.name === 'sample'));
  await transfer.handle({ type:'file_download_start', agentId:'a', downloadId:'bad', path:'/etc/passwd' });
  assert.equal(reports.find(m => m.downloadId === 'bad').ok,false);
  await transfer.handle({type:'file_upload_start',agentId:'a',uploadId:'short',filename:'short',size:5});
  await transfer.handle({type:'file_chunk',agentId:'a',uploadId:'short',index:0,data:Buffer.from('12').toString('base64')});
  await transfer.handle({type:'file_upload_end',agentId:'a',uploadId:'short'});
  assert(reports.some(m=>m.uploadId==='short'&&m.type==='file_upload_done'&&!m.ok));
  await transfer.handle({type:'file_upload_start',agentId:'a',uploadId:'long',filename:'long',size:2});
  await transfer.handle({type:'file_chunk',agentId:'a',uploadId:'long',index:0,data:Buffer.from('123').toString('base64')});
  assert(reports.some(m=>m.uploadId==='long'&&m.type==='file_upload_done'&&!m.ok));
  console.log('PASS upload/download contents, backpressure recovery, listing and path boundary');

  socket.bufferedAmount = 2 * 1024 * 1024;
  await transfer.handle({ type:'file_download_start', agentId:'a', downloadId:'cancel', path:'sample' });
  await until(() => reports.some(m => m.downloadId === 'cancel' && m.type === 'file_download_chunk'));
  transfer.dispose(); transfer.dispose(); const count = reports.length;
  socket.bufferedAmount = 0; await pause(100);
  assert.equal(reports.length,count,'disposed download resumed or emitted messages');
  await transfer.handle({ type:'file_ls',reqId:'after',dir:'.' }); assert.equal(reports.length,count);
  // Socket shutdown can race the asynchronous stream open or stat.
  for (const type of ['file_upload_start','file_download_start']) {
    const isolated = createFileTransfer({ send: () => { throw Error('sent after disposal'); }, getSocket: () => socket, getShellCwd: () => root });
    const pending = isolated.handle({type,agentId:'a',uploadId:'race',downloadId:'race',filename:'race',path:'sample',size:10});
    isolated.dispose(); await pending;
  }
  console.log('PASS paused-transfer cancellation and shutdown during asynchronous initialization');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { transfer.dispose(); fs.rmSync(root,{recursive:true,force:true}); });
