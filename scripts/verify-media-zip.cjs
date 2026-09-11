const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const archive = path.resolve(process.argv[2]);
const extracted = fs.mkdtempSync(path.join(os.tmpdir(), 'media-zip-'));
try {
  execFileSync('unzip', ['-q', archive, '-d', extracted]);
  execFileSync(
    process.execPath,
    [path.join(__dirname, 'verify-media-runtime.cjs'), extracted, '--lambda'],
    {
      stdio: 'inherit',
      timeout: 60000
    }
  );
} finally {
  fs.rmSync(extracted, { recursive: true, force: true });
}
