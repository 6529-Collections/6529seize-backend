import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

type CommandResult = {
  readonly status: number | null;
  readonly stderr: string;
  readonly stdout: string;
};

const repoRoot = path.resolve(__dirname, '..');
const repoBin = path.join(repoRoot, 'bin');

function envWithoutAuthorization(
  additions: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const { SEIZE_6529_COMMAND: _authorization, ...environment } = process.env;
  return { ...environment, ...additions };
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: options.env ?? envWithoutAuthorization(),
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

describe('6529 package command', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function createFakeCorepack(): {
    readonly directory: string;
    readonly environment: NodeJS.ProcessEnv;
  } {
    const directory = mkdtempSync(path.join(tmpdir(), 'fake-corepack-'));
    temporaryDirectories.push(directory);
    const corepackPath = path.join(directory, 'corepack');
    writeFileSync(
      corepackPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "npm" && "\${2:-}" == "--version" ]]; then
  echo "10.9.8"
  exit 0
fi
printf 'authorized=%s\\n' "\${SEIZE_6529_COMMAND:-0}"
printf 'arg=%s\\n' "$@"
`
    );
    chmodSync(corepackPath, 0o755);
    return {
      directory,
      environment: envWithoutAuthorization({
        PATH: `${repoBin}:${directory}:${process.env.PATH ?? ''}`
      })
    };
  }

  function createPackageManagerFixture(manifest: object): void {
    const directory = mkdtempSync(
      path.join(repoRoot, 'package-manager-fixture-')
    );
    temporaryDirectories.push(directory);
    writeFileSync(
      path.join(directory, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
  }

  it.each([
    ['npm', ['ci'], '6529 ci'],
    ['npm', ['run', 'build'], '6529 run build'],
    ['npm', ['exec', '--', 'eslint'], '6529 exec eslint'],
    ['npm', ['audit', 'fix'], '6529 audit:fix'],
    ['corepack', ['npm', 'ci'], '6529 ci'],
    ['corepack', ['npm', 'run', 'build'], '6529 run build'],
    ['corepack', ['npm', 'exec', '--', 'eslint'], '6529 exec eslint'],
    ['corepack', ['npm', 'audit', 'fix'], '6529 audit:fix'],
    ['npx', ['eslint'], '6529 exec eslint']
  ])(
    'rejects direct %s usage with exact wrapper guidance',
    (binary, args, expectedGuidance) => {
      const result = run(path.join(repoBin, binary), args);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expectedGuidance);
      expect(result.stderr).toContain('./bin/6529 bootstrap');
    }
  );

  it('rejects lifecycle installs that bypass the PATH shims', () => {
    const result = run(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'require-6529-command.cjs')],
      {
        env: envWithoutAuthorization({ npm_command: 'ci' })
      }
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Use `6529 ci` from the package directory.'
    );
  });

  it('allows lifecycle installs authorized by the wrapper', () => {
    const result = run(
      process.execPath,
      [path.join(repoRoot, 'scripts', 'require-6529-command.cjs')],
      {
        env: envWithoutAuthorization({ SEIZE_6529_COMMAND: '1' })
      }
    );

    expect(result).toMatchObject({ status: 0, stderr: '' });
  });

  it.each([
    [repoRoot, 'prebuild', '6529 run build'],
    [
      path.join(repoRoot, 'src', 'api-serverless'),
      'generate:openapi',
      '6529 run generate:openapi'
    ]
  ])(
    'rejects a direct package script in %s with exact guidance',
    (cwd, lifecycleEvent, expectedGuidance) => {
      const result = run(
        process.execPath,
        [path.join(repoRoot, 'scripts', 'require-6529-command.cjs')],
        {
          cwd,
          env: envWithoutAuthorization({
            npm_command: 'run-script',
            npm_lifecycle_event: lifecycleEvent
          })
        }
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expectedGuidance);
    }
  );

  it.each([
    [
      ['ci', '--ignore-scripts'],
      ['npm', 'ci', '--ignore-scripts']
    ],
    [
      ['add', '-D', 'example-package'],
      ['npm', 'install', '-D', 'example-package']
    ],
    [
      ['remove', 'example-package'],
      ['npm', 'uninstall', 'example-package']
    ],
    [
      ['run', 'generate:openapi'],
      ['npm', 'run', 'generate:openapi']
    ],
    [
      ['exec', 'eslint', '--version'],
      ['npm', 'exec', '--', 'eslint', '--version']
    ]
  ])(
    'forwards 6529 %s through authorized Corepack npm',
    (args, expectedArgs) => {
      const fakeCorepack = createFakeCorepack();
      const result = run(path.join(repoBin, '6529'), args, {
        env: fakeCorepack.environment
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('authorized=1');
      expect(
        result.stdout
          .split('\n')
          .filter((line) => line.startsWith('arg='))
          .map((line) => line.slice('arg='.length))
      ).toEqual(expectedArgs);
    }
  );

  it('uses the API package when run from src/api-serverless', () => {
    const fakeCorepack = createFakeCorepack();
    const result = run(
      path.join(repoBin, '6529'),
      ['run', 'generate:openapi'],
      {
        cwd: path.join(repoRoot, 'src', 'api-serverless'),
        env: fakeCorepack.environment
      }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('arg=generate:openapi');
  });

  it('reports npm explicitly through npm:version', () => {
    const fakeCorepack = createFakeCorepack();
    const result = run(path.join(repoBin, '6529'), ['npm:version'], {
      env: fakeCorepack.environment
    });

    expect(result).toMatchObject({ status: 0, stdout: '10.9.8\n' });
  });

  it('does not present the npm version as the wrapper version', () => {
    const fakeCorepack = createFakeCorepack();
    const result = run(path.join(repoBin, '6529'), ['version'], {
      env: fakeCorepack.environment
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'The 6529 wrapper does not currently publish its own version.'
    );
    expect(result.stderr).toContain('Use `6529 npm:version`');
  });

  it('rejects package names passed to 6529 ci', () => {
    const fakeCorepack = createFakeCorepack();
    const result = run(path.join(repoBin, '6529'), ['ci', 'example-package'], {
      env: fakeCorepack.environment
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Use `6529 add <package>`');
  });

  it('prints a repo-scoped bootstrap hook without changing shell files', () => {
    const fakeCorepack = createFakeCorepack();
    const result = run(
      path.join(repoBin, '6529'),
      ['bootstrap', '--print-export'],
      { env: fakeCorepack.environment }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(repoBin);
    expect(result.stdout).toContain('add-zsh-hook');
    expect(result.stdout).toContain('PROMPT_COMMAND');
  });

  it('keeps every package root pinned and guarded', () => {
    const result = run(process.execPath, [
      path.join(repoRoot, 'scripts', 'check-package-manager.mjs')
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('58 package.json files');
    expect(result.stdout).toContain('guarded by 6529');
  });

  it('rejects a package manifest whose scripts omit preinstall', () => {
    createPackageManagerFixture({
      name: 'missing-preinstall-fixture',
      packageManager: 'npm@10.9.8',
      scripts: {}
    });

    const result = run(process.execPath, [
      path.join(repoRoot, 'scripts', 'check-package-manager.mjs')
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unguarded: preinstall');
  });

  it('rejects nested package-manager commands that bypass 6529', () => {
    const guard = 'node ../scripts/require-6529-command.cjs';
    createPackageManagerFixture({
      name: 'direct-package-manager-fixture',
      packageManager: 'npm@10.9.8',
      scripts: {
        preinstall: guard,
        build: `${guard} && npm ci`
      }
    });

    const result = run(process.execPath, [
      path.join(repoRoot, 'scripts', 'check-package-manager.mjs')
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Direct package-manager commands: build');
    expect(result.stderr).toContain('../bin/6529');
  });
});
