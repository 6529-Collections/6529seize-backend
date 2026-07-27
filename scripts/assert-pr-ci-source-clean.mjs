/* eslint-env node */
import { spawnSync } from 'node:child_process';

const result = spawnSync(
  '/usr/bin/git',
  ['status', '--porcelain=v1', '--untracked-files=all', '--', 'src'],
  {
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  }
);

if (result.error) {
  console.error(
    `Could not inspect the source worktree: ${result.error.message}`
  );
  process.exit(1);
}

if (result.status !== 0) {
  const detail = result.stderr.trim();
  console.error(detail || 'Could not inspect the source worktree.');
  process.exit(result.status ?? 1);
}

const changedSourceFiles = result.stdout.trim();
if (changedSourceFiles) {
  console.error(
    'Source files changed during CI. Check-only lint and format commands must not mutate the workspace, and generated source must be committed.'
  );
  console.error(changedSourceFiles);
  process.exit(1);
}

console.log('Source worktree is clean.');
