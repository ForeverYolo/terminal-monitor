'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
async function buildFileManifest(root, names) {
  const entries = await Promise.all(names.map(async name => {
    try { return [name, await sha256File(path.join(root, name))]; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  return Object.fromEntries(entries.filter(Boolean));
}

// Validate the complete batch before touching disk. Unique sibling temp files
// prevent concurrent monitor processes from clobbering each other's staging.
// Each rename is atomic; this does not claim a multi-file transaction.
function installFiles(root, files, allowed) {
  if (!Array.isArray(files)) throw Error('files must be an array');
  const seen = new Set();
  const decoded = files.map(file => {
    if (!file || !allowed.includes(file.name)) throw Error(`file not allowed: ${file && file.name}`);
    if (seen.has(file.name)) throw Error(`duplicate file: ${file.name}`);
    seen.add(file.name);
    const content = Buffer.from(file.content, 'base64');
    if (crypto.createHash('sha256').update(content).digest('hex') !== file.sha256) throw Error(`checksum mismatch: ${file.name}`);
    return { name: file.name, content };
  });
  const staged = [];
  try {
    for (const file of decoded) {
      const target = path.join(root, file.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.swt-new`;
      staged.push({ target, temporary });
      fs.writeFileSync(temporary, file.content, { flag: 'wx', mode: 0o644 });
    }
    for (const file of staged) fs.renameSync(file.temporary, file.target);
  } finally {
    for (const file of staged) fs.rmSync(file.temporary, { force: true });
  }
  return decoded.map(file => file.name);
}
module.exports = { sha256File, buildFileManifest, installFiles };
