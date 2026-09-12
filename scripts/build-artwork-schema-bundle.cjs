const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const directory = path.join(__dirname, '../src/artwork-documentation/museum/export/schemas');
const lock = JSON.parse(fs.readFileSync(path.join(directory, 'schema-lock.json'), 'utf8'));
const files = {};
for (const item of Object.values(lock)) {
  if (typeof item.file !== 'string' || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(xsd|json)$/.test(item.file)) throw new Error('Invalid museum schema filename');
  const bytes = fs.readFileSync(path.join(directory, item.file));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('Pinned museum schema changed: '+item.file);
  files[item.file] = bytes.toString('base64');
}
const result = JSON.stringify({ lock, files }, null, 2)+'\n';
const target = path.join(directory, 'schema-bundle.json');
if (process.argv.includes('--check')) {
  if (fs.readFileSync(target, 'utf8') !== result) throw new Error('Museum schema bundle is stale');
} else fs.writeFileSync(target, result, 'utf8');
