import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type RunResult = {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
};

const guardPath = path.join(
  process.cwd(),
  'scripts/assert-pr-ci-source-clean.mjs'
);

function run(command: string, args: readonly string[], cwd: string): RunResult {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (result.error) {
    throw result.error;
  }

  return {
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout
  };
}

function runGit(repoRoot: string, ...args: string[]): void {
  const result = run('git', args, repoRoot);
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
}

function createFixtureRepository(): string {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'pr-ci-source-guard-'));
  mkdirSync(path.join(repoRoot, 'src/nested'), { recursive: true });
  writeFileSync(
    path.join(repoRoot, 'src/alchemy-sdk.ts'),
    'export const direct = true;\n'
  );
  writeFileSync(
    path.join(repoRoot, 'src/nested/example.ts'),
    'export const nested = true;\n'
  );
  runGit(repoRoot, 'init', '--quiet');
  runGit(repoRoot, 'config', 'user.name', 'CI Source Guard');
  runGit(repoRoot, 'config', 'user.email', 'ci-source-guard@example.com');
  runGit(repoRoot, 'add', 'src');
  runGit(repoRoot, 'commit', '--quiet', '-m', 'fixture');
  return repoRoot;
}

function runGuard(repoRoot: string): RunResult {
  return run(process.execPath, [guardPath], repoRoot);
}

describe('PR CI source worktree guard', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = createFixtureRepository();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('accepts a clean source worktree', () => {
    expect(runGuard(repoRoot)).toMatchObject({
      status: 0,
      stderr: '',
      stdout: 'Source worktree is clean.\n'
    });
  });

  it.each(['src/alchemy-sdk.ts', 'src/nested/example.ts'])(
    'rejects a tracked change at %s',
    (fileName) => {
      writeFileSync(
        path.join(repoRoot, fileName),
        'export const changed = true;\n'
      );

      const result = runGuard(repoRoot);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Source files changed during CI.');
      expect(result.stderr).toContain(fileName);
    }
  );

  it.each(['src/direct-untracked.ts', 'src/nested/untracked.ts'])(
    'rejects an untracked source file at %s',
    (fileName) => {
      writeFileSync(
        path.join(repoRoot, fileName),
        'export const untracked = true;\n'
      );

      const result = runGuard(repoRoot);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Source files changed during CI.');
      expect(result.stderr).toContain(fileName);
    }
  );
});
