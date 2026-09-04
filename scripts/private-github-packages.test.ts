import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

type CommandResult = {
  readonly error?: Error;
  readonly status: number;
  readonly stderr: string;
  readonly stdout: string;
};

type CommandEnvironment = NodeJS.ProcessEnv & {
  readonly NPM_CONFIG_SCRIPT_SHELL?: string;
  readonly NPM_CONFIG_USERCONFIG?: string;
};

type SpawnOptions = {
  readonly env: CommandEnvironment;
};

type SpawnFunction = (
  command: string,
  args: string[],
  options: SpawnOptions
) => CommandResult;

type WorkflowStep = {
  readonly env?: Record<string, string>;
  readonly name?: string;
};

type WorkflowJob = {
  readonly permissions?: Record<string, string>;
  readonly steps?: WorkflowStep[];
};

type Workflow = {
  readonly jobs?: Record<string, WorkflowJob>;
  readonly permissions?: Record<string, string>;
};

type PrivatePackagePolicy = {
  readonly AUTH_PLACEHOLDER: string;
  readonly PRIVATE_INTEGRITY: string;
  readonly PRIVATE_PACKAGE_NAME: string;
  readonly PRIVATE_PACKAGE_SPEC: string;
  readonly PRIVATE_PACKAGE_VERSION: string;
  readonly PRIVATE_REGISTRY: string;
  readonly PRIVATE_TARBALL: string;
  readonly REPOSITORY_ROOT: string;
  readonly buildPrivateNpmrc: () => string;
  readonly buildTokenFreeScriptShell: () => string;
  readonly resolveAuthenticationToken: (options: {
    readonly environment: NodeJS.ProcessEnv;
    readonly spawn: SpawnFunction;
  }) => string;
  readonly runPrivatePackageCommand: (options: {
    readonly args: string[];
    readonly corepackPath: string;
    readonly environment: NodeJS.ProcessEnv;
    readonly output: {
      readonly stderr: (value: string) => void;
      readonly stdout: (value: string) => void;
    };
    readonly repositoryRoot?: string;
    readonly spawn: SpawnFunction;
  }) => number;
  readonly sanitizeEnvironment: (
    environment: NodeJS.ProcessEnv
  ) => NodeJS.ProcessEnv;
  readonly validateArguments: (args: string[]) => void;
  readonly validateRepositoryPolicy: (repositoryRoot?: string) => void;
};

const policy = jest.requireActual<PrivatePackagePolicy>(
  './private-github-packages.cjs'
);

describe('private GitHub Packages install policy', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function temporaryDirectory(prefix: string): string {
    const directory = mkdtempSync(path.join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
  }

  function repositoryFixture(): string {
    const directory = temporaryDirectory('private-package-policy-');
    for (const filename of ['package.json', 'package-lock.json']) {
      writeFileSync(
        path.join(directory, filename),
        readFileSync(path.join(policy.REPOSITORY_ROOT, filename))
      );
    }
    return directory;
  }

  function readWorkflow(filename: string): Workflow {
    return parseYaml(
      readFileSync(
        path.join(policy.REPOSITORY_ROOT, '.github', 'workflows', filename),
        'utf8'
      )
    ) as Workflow;
  }

  function workflowTokenSteps(workflow: Workflow) {
    return Object.entries(workflow.jobs ?? {}).flatMap(([jobName, job]) =>
      (job.steps ?? [])
        .filter((step) => step.env?.NODE_AUTH_TOKEN !== undefined)
        .map((step) => ({
          jobName,
          stepName: step.name,
          token: step.env?.NODE_AUTH_TOKEN
        }))
    );
  }

  function expectRootInstallCredentialScope(
    workflow: Workflow,
    jobName: string,
    stepName: string
  ): void {
    expect(workflow.permissions).toBeUndefined();
    const jobsWithPackageRead = Object.entries(workflow.jobs ?? {})
      .filter(([, job]) => job.permissions?.packages === 'read')
      .map(([name]) => name);
    expect(jobsWithPackageRead).toEqual([jobName]);
    expect(workflow.jobs?.[jobName]?.permissions?.contents).toBe('read');
    expect(workflowTokenSteps(workflow)).toEqual([
      {
        jobName,
        stepName,
        token: '${{ github.token }}'
      }
    ]);
  }

  it('pins the approved CLI version and immutable package artifact', () => {
    expect(() => policy.validateRepositoryPolicy()).not.toThrow();

    const manifest = JSON.parse(
      readFileSync(path.join(policy.REPOSITORY_ROOT, 'package.json'), 'utf8')
    );
    const lockfile = JSON.parse(
      readFileSync(
        path.join(policy.REPOSITORY_ROOT, 'package-lock.json'),
        'utf8'
      )
    );
    const packageRecord =
      lockfile.packages[`node_modules/${policy.PRIVATE_PACKAGE_NAME}`];

    expect(manifest.devDependencies[policy.PRIVATE_PACKAGE_NAME]).toBe(
      policy.PRIVATE_PACKAGE_VERSION
    );
    expect(packageRecord).toMatchObject({
      dev: true,
      integrity: policy.PRIVATE_INTEGRITY,
      resolved: policy.PRIVATE_TARBALL,
      version: policy.PRIVATE_PACKAGE_VERSION
    });
  });

  it('routes only the approved scope and host through a temporary npm config', () => {
    const npmrc = policy.buildPrivateNpmrc();

    expect(npmrc).toBe(
      [
        `@6529-collections:registry=${policy.PRIVATE_REGISTRY}`,
        `//npm.pkg.github.com/:_authToken=${policy.AUTH_PLACEHOLDER}`,
        ''
      ].join('\n')
    );
    expect(npmrc).not.toMatch(/^registry=/m);
    expect(npmrc).not.toContain('registry.npmjs.org');
  });

  it('rejects any version other than the exact approved version', () => {
    const directory = repositoryFixture();
    const manifestPath = path.join(directory, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.devDependencies[policy.PRIVATE_PACKAGE_NAME] = '^0.0.3';
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => policy.validateRepositoryPolicy(directory)).toThrow(
      policy.PRIVATE_PACKAGE_SPEC
    );
  });

  it('rejects another package resolved through the private registry', () => {
    const directory = repositoryFixture();
    const lockfilePath = path.join(directory, 'package-lock.json');
    const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
    lockfile.packages['node_modules/public-alias'] = {
      integrity: 'sha512-test',
      resolved: 'https://npm.pkg.github.com/download/public-alias/1.0.0/test',
      version: '1.0.0'
    };
    writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

    expect(() => policy.validateRepositoryPolicy(directory)).toThrow(
      'routes an unapproved package'
    );
  });

  it('rejects a malformed tarball reference for the approved private record', () => {
    const directory = repositoryFixture();
    const lockfilePath = path.join(directory, 'package-lock.json');
    const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
    const packagePath = `node_modules/${policy.PRIVATE_PACKAGE_NAME}`;
    lockfile.packages[packagePath].resolved = 'not-a-registry-url';
    writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);

    expect(() => policy.validateRepositoryPolicy(directory)).toThrow(
      'approved tarball'
    );
  });

  it('reuses a GitHub CLI token only when read:packages is present', () => {
    const token = 'test-token-with-read-packages';
    const withScope = jest
      .fn<ReturnType<SpawnFunction>, Parameters<SpawnFunction>>()
      .mockReturnValueOnce({
        status: 0,
        stderr: "Token scopes: 'repo', 'read:packages'\n",
        stdout: ''
      })
      .mockReturnValueOnce({ status: 0, stderr: '', stdout: `${token}\n` });

    expect(
      policy.resolveAuthenticationToken({ environment: {}, spawn: withScope })
    ).toBe(token);

    const withoutScope = jest
      .fn<ReturnType<SpawnFunction>, Parameters<SpawnFunction>>()
      .mockReturnValue({
        status: 0,
        stderr: "Token scopes: 'repo'\n",
        stdout: ''
      });
    expect(() =>
      policy.resolveAuthenticationToken({
        environment: {},
        spawn: withoutScope
      })
    ).toThrow('read:packages');
    expect(withoutScope).toHaveBeenCalledTimes(1);
  });

  it('fails without prompting when CI has no token', () => {
    const spawn = jest.fn<
      ReturnType<SpawnFunction>,
      Parameters<SpawnFunction>
    >();

    expect(() =>
      policy.resolveAuthenticationToken({
        environment: { CI: 'true', GITHUB_ACTIONS: 'true' },
        spawn
      })
    ).toThrow('CI is non-interactive');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('does not treat an explicitly disabled CI flag as CI', () => {
    const token = 'test-token-for-local-fallback';
    const spawn = jest
      .fn<ReturnType<SpawnFunction>, Parameters<SpawnFunction>>()
      .mockReturnValueOnce({
        status: 0,
        stderr: "Token scopes: 'read:packages'\n",
        stdout: ''
      })
      .mockReturnValueOnce({ status: 0, stderr: '', stdout: `${token}\n` });

    expect(
      policy.resolveAuthenticationToken({
        environment: { CI: 'false' },
        spawn
      })
    ).toBe(token);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('explains that the approved private package is pinned on uninstall', () => {
    expect(() =>
      policy.validateArguments(['uninstall', policy.PRIVATE_PACKAGE_NAME])
    ).toThrow('pinned by repository policy');
  });

  it('keeps the token out of package arguments, lifecycle scripts, and output', () => {
    const token = 'test-token-that-must-not-print';
    const calls: Array<{
      readonly args: string[];
      readonly environment: CommandEnvironment;
      readonly npmrc: string;
      readonly scriptShell: string;
    }> = [];
    const spawn = jest.fn<ReturnType<SpawnFunction>, Parameters<SpawnFunction>>(
      (_command, args, options) => {
        const userConfigPath = options.env.NPM_CONFIG_USERCONFIG;
        const scriptShellPath = options.env.NPM_CONFIG_SCRIPT_SHELL;
        if (!userConfigPath || !scriptShellPath) {
          throw new Error('authenticated npm config was not supplied');
        }
        calls.push({
          args,
          environment: options.env,
          npmrc: readFileSync(userConfigPath, 'utf8'),
          scriptShell: readFileSync(scriptShellPath, 'utf8')
        });
        return {
          status: 0,
          stderr: `stderr accidentally included ${token}`,
          stdout: `stdout accidentally included ${token}`
        };
      }
    );
    let stdout = '';
    let stderr = '';

    const result = policy.runPrivatePackageCommand({
      args: ['ci'],
      corepackPath: '/trusted/corepack',
      environment: {
        CI: 'true',
        NODE_AUTH_TOKEN: token,
        npm_config_registry: 'https://untrusted.example'
      },
      output: {
        stderr: (value) => {
          stderr += value;
        },
        stdout: (value) => {
          stdout += value;
        }
      },
      spawn
    });

    expect(result).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual(['npm', 'ci']);
    expect(calls[0]?.args.join(' ')).not.toContain(token);
    expect(calls[0]?.environment.NODE_AUTH_TOKEN).toBe(token);
    expect(calls[0]?.environment).not.toHaveProperty('npm_config_registry');
    expect(calls[0]?.npmrc).toContain(policy.AUTH_PLACEHOLDER);
    expect(calls[0]?.npmrc).not.toContain(token);
    expect(calls[0]?.scriptShell).toContain('unset NODE_AUTH_TOKEN');
    expect(`${stdout}\n${stderr}`).not.toContain(token);
    expect(`${stdout}\n${stderr}`).toContain('[redacted]');
  });

  it('removes the token before an install lifecycle command runs', () => {
    const directory = temporaryDirectory('token-free-script-shell-');
    const scriptShellPath = path.join(directory, 'shell');
    writeFileSync(scriptShellPath, policy.buildTokenFreeScriptShell());
    chmodSync(scriptShellPath, 0o700);

    const result = spawnSync(
      scriptShellPath,
      ['-c', 'printf "%s" "${NODE_AUTH_TOKEN:-missing}"'],
      {
        encoding: 'utf8',
        env: { ...process.env, NODE_AUTH_TOKEN: 'must-not-reach-script' }
      }
    );

    expect(result).toMatchObject({ status: 0, stderr: '', stdout: 'missing' });
  });

  it('removes token and npm routing overrides from non-install environments', () => {
    expect(
      policy.sanitizeEnvironment({
        HOME: '/safe',
        NODE_AUTH_TOKEN: 'secret',
        NPM_CONFIG_REGISTRY: 'https://untrusted.example',
        npm_config_proxy: 'https://untrusted.example'
      })
    ).toEqual({ HOME: '/safe' });
  });

  it('limits GitHub workflow package access to root install steps', () => {
    expectRootInstallCredentialScope(
      readWorkflow('on-pull-request.yml'),
      'build',
      'Install root dependencies'
    );
    expectRootInstallCredentialScope(
      readWorkflow('deploy.yml'),
      'build-and-deploy',
      'Install root dependencies for manual build'
    );
  });
});
