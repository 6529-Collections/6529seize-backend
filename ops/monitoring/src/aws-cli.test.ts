import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('deployment CLI resolves an approved absolute installation and rejects PATH and checkout binaries', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'monitoring-cli-'));
  const executable = join(scratch, 'aws');
  const artifactDir = fileURLToPath(new URL('../dist/', import.meta.url));
  const localExecutable = join(artifactDir, 'aws');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(executable, 'validation fixture; never executed', {
    mode: 0o700,
    flag: 'wx'
  });
  writeFileSync(localExecutable, 'validation fixture; never executed', {
    mode: 0o700,
    flag: 'wx'
  });
  const helperUrl = new URL(
    '../scripts/aws-cli.mjs',
    import.meta.url
  ).toString();
  const script = `import { approvedAwsCli } from ${JSON.stringify(helperUrl)};
    try { approvedAwsCli(); process.stdout.write('accepted'); }
    catch { process.stdout.write('rejected'); }`;
  try {
    for (const [path, expected] of [
      [executable, 'accepted'],
      ['', 'rejected'],
      ['aws', 'rejected'],
      [localExecutable, 'rejected'],
      [join(scratch, 'missing-aws'), 'rejected']
    ]) {
      const result = spawnSync(
        process.execPath,
        ['--input-type=module', '-e', script],
        {
          shell: false,
          encoding: 'utf8',
          env: { ...process.env, AWS_CLI_PATH: path }
        }
      );
      assert.equal(result.status, 0);
      assert.equal(result.stdout, expected);
    }
  } finally {
    unlinkSync(localExecutable);
    unlinkSync(executable);
    rmdirSync(scratch);
  }
});
