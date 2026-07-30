import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type RunResult = {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
};

const checkerPath = path.join(process.cwd(), 'scripts/check-package-lock.mjs');

function writeLockfile(
  packages: Record<string, Record<string, unknown>>
): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'package-lock-check-'));
  const lockfilePath = path.join(directory, 'package-lock.json');
  writeFileSync(
    lockfilePath,
    JSON.stringify({
      name: 'fixture',
      lockfileVersion: 3,
      packages
    })
  );
  return lockfilePath;
}

function runChecker(lockfilePath: string): RunResult {
  const result = spawnSync(process.execPath, [checkerPath, lockfilePath], {
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

describe('package lock optional dependency check', () => {
  const fixtureDirectories: string[] = [];

  afterEach(() => {
    for (const directory of fixtureDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function fixture(packages: Record<string, Record<string, unknown>>): string {
    const lockfilePath = writeLockfile(packages);
    fixtureDirectories.push(path.dirname(lockfilePath));
    return lockfilePath;
  }

  it('accepts optional dependencies resolved at the repository root', () => {
    const lockfilePath = fixture({
      '': {},
      'node_modules/parent': {
        optionalDependencies: {
          '@scope/native-binding': '1.0.0'
        }
      },
      'node_modules/@scope/native-binding': {
        version: '1.0.0',
        optional: true
      }
    });

    const result = runChecker(lockfilePath);

    expect(result).toMatchObject({
      status: 0,
      stderr: ''
    });
    expect(result.stdout).toContain('1 optional dependency edge resolved');
  });

  it('accepts an optional dependency resolved beside a nested package', () => {
    const lockfilePath = fixture({
      '': {},
      'node_modules/parent': {},
      'node_modules/parent/node_modules/child': {
        optionalDependencies: {
          native: '2.0.0'
        }
      },
      'node_modules/parent/node_modules/native': {
        version: '2.0.0',
        optional: true
      }
    });

    expect(runChecker(lockfilePath).status).toBe(0);
  });

  it('accepts an optional dependency hoisted above a three-level nested package', () => {
    const lockfilePath = fixture({
      '': {},
      'node_modules/a': {},
      'node_modules/a/node_modules/b': {},
      'node_modules/a/node_modules/b/node_modules/c': {
        optionalDependencies: {
          native: '3.0.0'
        }
      },
      'node_modules/a/node_modules/native': {
        version: '3.0.0',
        optional: true
      }
    });

    expect(runChecker(lockfilePath).status).toBe(0);
  });

  it('rejects an optional dependency without a package record', () => {
    const lockfilePath = fixture({
      '': {},
      'node_modules/unrs-resolver': {
        optionalDependencies: {
          '@unrs/resolver-binding-linux-x64-gnu': '1.11.1'
        }
      }
    });

    const result = runChecker(lockfilePath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Package lock check failed');
    expect(result.stderr).toContain(
      '@unrs/resolver-binding-linux-x64-gnu@1.11.1'
    );
  });

  it('rejects lockfiles without package metadata', () => {
    const lockfilePath = fixture({});
    writeFileSync(lockfilePath, JSON.stringify({ lockfileVersion: 2 }));

    const result = runChecker(lockfilePath);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('lockfile has no packages object');
  });
});
