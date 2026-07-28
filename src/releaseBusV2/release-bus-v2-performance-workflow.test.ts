import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const yaml = require('js-yaml') as {
  load(source: string): unknown;
};

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('Release Bus v2 backend critical-path contract', () => {
  const preflight = read('.github/workflows/release-bus-v2-preflight.yml');
  const deploy = read('.github/workflows/deploy.yml');
  const reconciler = read('src/releaseBusV2/release-bus-v2.reconciler.ts');

  it('keeps normal preflight on one runner without repository quality matrices', () => {
    const contract = JSON.parse(
      read('ops/deployment-bus/release-bus-performance-contract.v1.json')
    ) as {
      critical_path: {
        normal_preflight_jobs: string[];
        normal_preflight_steps: string[];
      };
    };
    const parsed = yaml.load(preflight) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    expect(Object.keys(parsed.jobs)).toEqual(
      contract.critical_path.normal_preflight_jobs
    );
    const steps = parsed.jobs.preflight.steps;
    expect(steps.map(({ name }) => name)).toEqual(
      contract.critical_path.normal_preflight_steps
    );
    const commands = steps
      .map(({ run }) => run ?? '')
      .filter(Boolean)
      .join('\n');
    for (const forbiddenCommand of [
      /\bnpm\s+test\b/,
      /\bnpm\s+run\s+(?:lint|lint:check|typecheck|tsc|check|build)\b/,
      /\bjest(?:\s|$)/,
      /\beslint(?:\s|$)/,
      /\btsc(?:\s|$)/
    ])
      expect(commands).not.toMatch(forbiddenCommand);
    for (const forbidden of [
      'matrix:',
      'jest --listTests',
      'tests-1',
      'tests-2',
      'tests-3',
      'tests-4',
      'eslint "src/**/*.ts"',
      'tsc -p tsconfig.json'
    ])
      expect(preflight).not.toContain(forbidden);
    expect(preflight).toContain('Install frozen shared dependencies once');
    expect(preflight).toContain('test "$(npm --version)" = "10.9.8"');
    expect(preflight).toContain('release-bus-package-backend.mjs');
  });

  it('authorizes before candidate checkout or cache and verifies the exact live source tip', () => {
    const parsed = yaml.load(preflight) as {
      jobs: Record<
        string,
        {
          steps: Array<{
            name?: string;
            uses?: string;
            run?: string;
            if?: string;
          }>;
        }
      >;
    };
    const steps = parsed.jobs.preflight.steps;
    const index = (name: string) =>
      steps.findIndex((step) => step.name === name);
    const syntax = index('Validate dispatch syntax without candidate checkout');
    const authorize = index('Authorize exact v2 operation');
    const evidence = index('Verify exact green PR CI evidence');
    const checkout = index('Check out exact fresh composition');
    const composition = index('Verify exact composition and deployment graph');
    const install = index('Install Node.js');

    expect(syntax).toBe(0);
    expect(authorize).toBeGreaterThan(syntax);
    expect(evidence).toBeGreaterThan(authorize);
    expect(checkout).toBeGreaterThan(evidence);
    expect(composition).toBeGreaterThan(checkout);
    expect(install).toBeGreaterThan(composition);
    for (const step of steps.slice(0, authorize)) {
      expect(step.uses).toBeUndefined();
      expect(step.run ?? '').not.toMatch(
        /\b(?:npm|node)\b|git\s+(?:checkout|fetch|rev-parse|status)|(?:^|[\s/])(?:src|scripts|package(?:-lock)?\.json)(?:[\s/]|$)/m
      );
    }
    expect(steps[checkout]).toMatchObject({
      if: "steps.evidence.outcome == 'success'",
      uses: expect.stringMatching(/^actions\/checkout@[a-f0-9]{40}$/)
    });
    expect(steps[composition].run).toContain(
      'test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"'
    );
    expect(steps[composition].run).toContain(
      'gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$SOURCE_REF"'
    );
    expect(steps[composition].run).toContain('.object.sha == $expected_sha');
    expect(steps[composition].run).toContain('src/config/deploy-services.json');
  });

  it('keeps legacy authorization old-API-shaped and binds strict authorization to its source ref', () => {
    const parsed = yaml.load(preflight) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const authorize = parsed.jobs.preflight.steps.find(
      ({ name }) => name === 'Authorize exact v2 operation'
    );
    expect(authorize?.run).toBeTruthy();
    const fixture = mkdtempSync(path.join(tmpdir(), 'rb2-authorize-'));
    const capture = path.join(fixture, 'payload.json');
    const fakeCurl = path.join(fixture, 'curl');
    writeFileSync(
      fakeCurl,
      `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--data" ]; then
    printf '%s' "$2" > "$CAPTURE_PAYLOAD"
    exit 0
  fi
  shift
done
exit 1
`
    );
    chmodSync(fakeCurl, 0o755);
    const execute = (candidateEvidenceMode: string) => {
      rmSync(capture, { force: true });
      execFileSync('bash', ['-c', authorize?.run ?? 'exit 1'], {
        cwd: root,
        env: {
          ...process.env,
          AGGREGATE_CANDIDATE_EVIDENCE_DIGEST:
            candidateEvidenceMode === 'strict-aggregate' ? 'b'.repeat(64) : '',
          CANDIDATE_EVIDENCE_MODE: candidateEvidenceMode,
          CAPTURE_PAYLOAD: capture,
          EXPECTED_SHA: 'a'.repeat(40),
          GITHUB_RUN_ID: '12345',
          OPERATION_KEY: 'rb2:train-id:prepare:backend:a1',
          PATH: `${fixture}:${process.env.PATH ?? ''}`,
          RELEASE_BUS_API_URL: 'https://release-bus.invalid',
          RELEASE_BUS_WORKFLOW_AUTH_TOKEN: 'test-token',
          SOURCE_REF: 'release-bus-v2/train-id/backend',
          TRAIN_ID: 'train-id'
        }
      });
      return JSON.parse(readFileSync(capture, 'utf8')) as Record<
        string,
        unknown
      >;
    };
    try {
      expect(execute('legacy-whole-train')).toEqual({
        train_id: 'train-id',
        operation_key: 'rb2:train-id:prepare:backend:a1',
        workflow_run_id: '12345',
        artifact_run_id: null,
        repository: 'backend',
        environment: 'orchestration',
        service: null,
        expected_sha: 'a'.repeat(40),
        artifact_digest: null
      });
      expect(execute('strict-aggregate')).toEqual(
        expect.objectContaining({
          source_ref: 'release-bus-v2/train-id/backend',
          candidate_evidence_mode: 'strict-aggregate',
          aggregate_candidate_evidence_digest: 'b'.repeat(64)
        })
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('serializes old-producer deploy units and preserves explicit new-producer DAG layers', () => {
    const marker =
      'effective_layers="$(jq -c --argjson units "$DEPLOY_UNITS" \'';
    const start = preflight.indexOf(marker);
    const end = preflight.indexOf(
      '\' <<< "$DEPLOY_LAYERS")"',
      start + marker.length
    );
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const filter = preflight
      .slice(start + marker.length, end)
      .replace(/^ {12}/gm, '');
    const execute = (units: string[], layers: string[][]) =>
      JSON.parse(
        execFileSync(
          'jq',
          ['-c', '--argjson', 'units', JSON.stringify(units), filter],
          {
            cwd: root,
            encoding: 'utf8',
            input: JSON.stringify(layers)
          }
        )
      ) as string[][];
    expect(execute(['api', 'releaseBus'], [])).toEqual([
      ['api'],
      ['releaseBus']
    ]);
    expect(
      execute(['dbMigrationsLoop', 'api'], [['dbMigrationsLoop'], ['api']])
    ).toEqual([['dbMigrationsLoop'], ['api']]);
    expect(preflight).toContain(
      "deploy_layers: { type: string, required: false, default: '[]' }"
    );
    for (const dispatch of reconciler
      .split("workflow: 'release-bus-v2-preflight.yml'")
      .slice(1)) {
      expect(dispatch.slice(0, 1800)).toContain('deploy_layers');
    }
  });

  it('uses PR CI artifacts as evidence and never as train deploy bytes', () => {
    expect(preflight).toContain('Verify exact green PR CI evidence');
    expect(preflight).not.toContain('Download exact green PR artifact');
    expect(preflight).not.toContain('reused_exact_pr_artifact:true');
    const pullRequest = read('.github/workflows/on-pull-request.yml');
    expect(pullRequest).toContain('exact-merge-tree-pr-ci-v1');
    expect(pullRequest).not.toContain(
      'release-bus-v2-pr-artifact/packages/api'
    );
    expect(pullRequest).toContain('--expected-git-ref "$EXPECTED_MERGE_SHA"');
    expect(pullRequest).toContain('policy-bundle.txt');
  });

  it('records exact Node and npm provenance in immutable PR CI evidence', () => {
    const policy = require('../../scripts/pr-ci-policy-bundle.cjs') as {
      buildPolicyBundle(input: { root: string }): { canonical: string };
    };
    const { canonical } = policy.buildPolicyBundle({ root });
    expect(canonical).toContain('runtime-pin\tnode\t"22.17.1"\n');
    expect(canonical).toContain(
      'package-field\tpackage.json#packageManager\t"npm@10.9.8"\n'
    );
    expect(canonical).toContain(
      'package-field\tsrc/api-serverless/package.json#packageManager\t"npm@10.9.8"\n'
    );
    const pullRequest = read('.github/workflows/on-pull-request.yml');
    expect(pullRequest).toContain('corepack install');
    expect(pullRequest).toContain('resolved="$(npm --version)"');
    expect(pullRequest).toContain(
      'Corepack did not activate the pinned npm (expected ${expected}, got ${resolved})'
    );
  });

  it('attributes source-ref transport, movement, and candidate graph failures separately', () => {
    const parsed = yaml.load(preflight) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const composition = parsed.jobs.preflight.steps.find(
      ({ name }) => name === 'Verify exact composition and deployment graph'
    );
    expect(composition?.run).toBeTruthy();
    const fixture = mkdtempSync(path.join(tmpdir(), 'rb2-source-ref-'));
    const output = path.join(fixture, 'github-output');
    const fakeGh = path.join(fixture, 'gh');
    writeFileSync(
      fakeGh,
      `#!/bin/sh
if [ "$GH_MODE" = transport ]; then
  exit 1
fi
printf '{"ref":"refs/heads/%s","object":{"type":"commit","sha":"%s"}}\\n' "$SOURCE_REF" "$GH_RESPONSE_SHA"
`
    );
    chmodSync(fakeGh, 0o755);
    const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim();
    const execute = (
      mode: 'transport' | 'moved' | 'candidate'
    ): Record<string, string> => {
      writeFileSync(output, '');
      try {
        execFileSync('bash', ['-c', composition?.run ?? 'exit 1'], {
          cwd: root,
          env: {
            ...process.env,
            DEPLOY_LAYERS: '[["notAService"]]',
            DEPLOY_UNITS: '["notAService"]',
            EXPECTED_SHA: expectedSha,
            GH_MODE: mode,
            GH_RESPONSE_SHA: mode === 'moved' ? '0'.repeat(40) : expectedSha,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: '6529/backend',
            PATH: `${fixture}:${process.env.PATH ?? ''}`,
            SOURCE_REF: 'release-bus-v2/train-id/backend'
          },
          stdio: 'pipe'
        });
        throw new Error('composition failure fixture unexpectedly succeeded');
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'composition failure fixture unexpectedly succeeded'
        )
          throw error;
      }
      return Object.fromEntries(
        readFileSync(output, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const separator = line.indexOf('=');
            return [line.slice(0, separator), line.slice(separator + 1)];
          })
      );
    };
    try {
      expect(execute('transport')).toMatchObject({
        failure_class: 'INFRASTRUCTURE',
        failure_phase: 'source_ref_transport',
        retryable: 'true'
      });
      expect(execute('moved')).toMatchObject({
        failure_class: 'INTERACTION',
        failure_phase: 'source_ref_moved',
        retryable: 'false'
      });
      expect(execute('candidate')).toMatchObject({
        failure_class: 'CANDIDATE',
        failure_phase: 'source_composition',
        retryable: 'false'
      });
      expect(preflight).toContain(
        'failure_class="${COMPOSITION_FAILURE_CLASS:-CANDIDATE}"'
      );
      expect(preflight).toContain(
        'failure_phase="${COMPOSITION_FAILURE_PHASE:-source_composition}"'
      );
      expect(preflight).toContain(
        'retryable="${COMPOSITION_RETRYABLE:-false}"'
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('separates retryable transport faults from immutable candidate evidence mismatches', () => {
    expect(preflight).toContain(
      'echo "failure_class=INFRASTRUCTURE" >> "$GITHUB_OUTPUT"'
    );
    expect(preflight).toContain(
      'echo "failure_class=CANDIDATE" >> "$GITHUB_OUTPUT"'
    );
    expect(preflight).toContain(
      'failure_class="${EVIDENCE_FAILURE_CLASS:-CANDIDATE}"'
    );
    expect(preflight).toContain(
      'failure_class="${ROOT_INSTALL_FAILURE_CLASS:-CANDIDATE}"'
    );
    expect(preflight).toContain(
      'failure_class="${PACKAGE_FAILURE_CLASS:-CANDIDATE}"'
    );
    expect(preflight).toContain(
      'test "$failure_class" != INFRASTRUCTURE || retryable=true'
    );
    expect(read('scripts/release-bus-package-backend.mjs')).toContain(
      '.release-bus-package-failure-class'
    );
  });

  it('binds policy bytes to the exact commit and rejects mutable action tags', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'rb2-policy-'));
    try {
      mkdirSync(path.join(fixture, '.github/workflows'), { recursive: true });
      writeFileSync(
        path.join(fixture, '.github/workflows/ci.yml'),
        'steps:\n  - uses: actions/checkout@v6\n'
      );
      execFileSync('git', ['init', '-q'], { cwd: fixture });
      execFileSync('git', ['add', '.'], { cwd: fixture });
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Release Bus Test',
          '-c',
          'user.email=release-bus-test@example.invalid',
          'commit',
          '-qm',
          'fixture'
        ],
        { cwd: fixture }
      );
      const exactRef = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: fixture,
        encoding: 'utf8'
      }).trim();
      const policy = require('../../scripts/pr-ci-policy-bundle.cjs') as {
        assertExactGitRef(
          root: string,
          expectedGitRef: string,
          filePaths: readonly string[]
        ): void;
        buildPolicyBundle(input: Record<string, unknown>): unknown;
      };
      expect(() =>
        policy.assertExactGitRef(fixture, exactRef, [
          '.github/workflows/ci.yml'
        ])
      ).not.toThrow();
      expect(() =>
        policy.buildPolicyBundle({
          root: fixture,
          filePaths: ['.github/workflows/ci.yml'],
          packagePolicies: {},
          runtimePins: {},
          nodePinWorkflows: [],
          pinnedActionWorkflows: ['.github/workflows/ci.yml']
        })
      ).toThrow('external action is not pinned to a 40-hex SHA');
      writeFileSync(
        path.join(fixture, '.github/workflows/ci.yml'),
        'steps:\n  - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10\n'
      );
      expect(() =>
        policy.assertExactGitRef(fixture, exactRef, [
          '.github/workflows/ci.yml'
        ])
      ).toThrow('working bytes differ from exact Git ref');
      rmSync(path.join(fixture, '.github/workflows/ci.yml'));
      symlinkSync(
        path.join(fixture, 'package.json'),
        path.join(fixture, '.github/workflows/ci.yml')
      );
      expect(() =>
        policy.assertExactGitRef(fixture, exactRef, [
          '.github/workflows/ci.yml'
        ])
      ).toThrow(
        'protected path .github/workflows/ci.yml is not a regular file'
      );
      expect(() =>
        policy.buildPolicyBundle({
          root: fixture,
          filePaths: ['.github/workflows/ci.yml'],
          packagePolicies: {},
          runtimePins: {},
          nodePinWorkflows: [],
          pinnedActionWorkflows: []
        })
      ).toThrow(
        'protected path .github/workflows/ci.yml is not a regular file'
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('has one fail-closed install strategy for every deploy unit', () => {
    const config = JSON.parse(read('src/config/deploy-services.json')) as {
      services: Array<{ name: string }>;
    };
    const packager = read('scripts/release-bus-package-backend.mjs');
    expect(packager).toContain('MAX_PARALLEL_UNIT_TASKS = 3');
    expect(packager).toContain('RELEASE_BUS_BACKEND_INSTALL_STRATEGIES');
    for (const { name } of config.services) {
      const directory = name === 'api' ? 'api-serverless' : name;
      const packageJson = JSON.parse(read(`src/${directory}/package.json`)) as {
        scripts?: Record<string, string>;
      };
      expect(() => read(`src/${directory}/package-lock.json`)).not.toThrow();
      const packagePathCommands = [
        packageJson.scripts?.prebuild,
        packageJson.scripts?.build,
        packageJson.scripts?.postbuild
      ]
        .filter(Boolean)
        .join('\n');
      expect(packagePathCommands).not.toMatch(
        /\b(?:jest|eslint|tsc)\b|\bnpm\s+(?:test|run\s+(?:lint|lint:check|typecheck|tsc|check))\b/
      );
      expect(packagePathCommands).toMatch(/\bzip\b/);
    }
    expect(packager).toContain('has no frozen local dependency strategy');
    const coverage = execFileSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        `
          import fs from 'node:fs';
          import semver from 'semver';
          import {
            RELEASE_BUS_BACKEND_INSTALL_STRATEGIES as strategies,
            validateReleaseBusBackendInstallStrategyCoverage as validate
          } from './scripts/release-bus-backend-package-strategies.mjs';
          const config = JSON.parse(fs.readFileSync('./src/config/deploy-services.json'));
          validate(config.services.map(({name}) => name));
          const rootPackage = JSON.parse(fs.readFileSync('./package.json'));
          const rootDependencies = {
            ...(rootPackage.dependencies ?? {}),
            ...(rootPackage.devDependencies ?? {})
          };
          for (const {name} of config.services) {
            if (strategies[name] !== 'root-bundled') continue;
            const directory = name === 'api' ? 'api-serverless' : name;
            const unitPackage = JSON.parse(
              fs.readFileSync(\`./src/\${directory}/package.json\`)
            );
            const required = {
              ...(unitPackage.dependencies ?? {}),
              ...(unitPackage.devDependencies?.esbuild
                ? {esbuild: unitPackage.devDependencies.esbuild}
                : {})
            };
            for (const [dependency, range] of Object.entries(required)) {
              const rootRange = rootDependencies[dependency];
              if (!rootRange || !semver.intersects(String(range), rootRange)) {
                throw new Error(
                  \`\${name} root-bundled dependency \${dependency}@\${range} is not supplied by root \${rootRange ?? 'missing'}\`
                );
              }
            }
          }
          process.stdout.write(JSON.stringify(strategies));
        `
      ],
      { cwd: root, encoding: 'utf8' }
    );
    const strategies = JSON.parse(coverage) as Record<string, string>;
    expect(strategies.api).toBe('local-frozen');
    expect(strategies.dbMigrationsLoop).toBe('local-frozen');
    expect(strategies.rememesLoop).toBe('local-frozen');
    expect(strategies.s3Uploader).toBe('local-frozen');
    expect(strategies.tdhLoop).toBe('local-frozen');
    expect(strategies.attachmentsOrchestrator).toBe('local-frozen');
    expect(strategies.dropMediaSanitizer).toBe('self-install-native');
    expect(strategies.mediaResizerLoop).toBe('self-install-native');
    expect(strategies.nftLinkMediaPreviewLoop).toBe('self-install-native');
    for (const [unit, strategy] of Object.entries(strategies)) {
      if (strategy !== 'self-install-native') continue;
      const packageJson = JSON.parse(read(`src/${unit}/package.json`)) as {
        scripts?: Record<string, string>;
      };
      expect(packageJson.scripts?.build).toContain('npm ci ');
      expect(packageJson.scripts?.build).not.toContain('npm i ');
    }
    expect(
      Object.values(strategies).filter((value) => value === 'local-frozen')
        .length
    ).toBeGreaterThan(4);
  });

  it('accepts only explicit dependency frontiers for multi-unit packaging', () => {
    const result = execFileSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        `
          import {validateReleaseBusBackendLayers as validate}
            from './scripts/release-bus-backend-package-strategies.mjs';
          const independent = validate(
            ['dbMigrationsLoop', 'ethPriceLoop'],
            [['dbMigrationsLoop', 'ethPriceLoop']]
          );
          const dependent = validate(
            ['dbMigrationsLoop', 'api'],
            [['dbMigrationsLoop'], ['api']]
          );
          let flattenedRejected = false;
          try {
            validate(
              ['dbMigrationsLoop', 'api'],
              [['dbMigrationsLoop', 'api'], ['api']]
            );
          } catch {
            flattenedRejected = true;
          }
          process.stdout.write(JSON.stringify({
            independent,
            dependent,
            flattenedRejected
          }));
        `
      ],
      { cwd: root, encoding: 'utf8' }
    );
    expect(JSON.parse(result)).toEqual({
      independent: [['dbMigrationsLoop', 'ethPriceLoop']],
      dependent: [['dbMigrationsLoop'], ['api']],
      flattenedRejected: true
    });
    const packager = read('scripts/release-bus-package-backend.mjs');
    expect(packager).toContain('for (const layer of layers)');
    expect(packager).toContain("layer.filter((unit) => unit !== 'api')");
  });

  it('requires v3 target binding while keeping a named same-train v2 bridge', () => {
    expect(preflight).toContain('default: legacy-v2');
    expect(preflight).toContain('environment-bound-v3');
    expect(deploy).toContain('.schema_version == 3');
    expect(deploy).toContain('.environment == $environment');
    expect(deploy).toContain('.source_evidence_reused == true');
    expect(deploy).toContain('.artifact_bytes_reused == false');
    expect(deploy).toContain('test "$artifact_train_id" = "$INPUT_TRAIN_ID"');
    expect(deploy).toContain('.schema_version == 2');
    expect(deploy).toContain('artifact_contract:"legacy-v2"');
    expect(deploy).toContain('environment:"portable"');
    expect(deploy).toContain('deployment_environment:$deployment_environment');
  });

  it('executes the exact terminal summary projection from preflight', () => {
    const marker = `summary="$(jq -c --arg digest "$digest" '`;
    const start = preflight.indexOf(marker);
    const end = preflight.indexOf(`' <<< "$manifest")"`, start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const projection = preflight
      .slice(start + marker.length, end)
      .replace(/^ {12}/gm, '');
    const projected = execFileSync(
      'jq',
      ['-c', '--arg', 'digest', 'f'.repeat(64), projection],
      {
        cwd: root,
        encoding: 'utf8',
        input: JSON.stringify({
          schema_version: 3,
          artifact_contract: 'environment-bound-v1',
          artifact_contract_version: 'environment-bound-v3',
          repository: 'backend',
          source_sha: 'a'.repeat(40),
          environment: 'production',
          units: ['api'],
          ci_evidence: {
            mode: 'strict-aggregate',
            aggregate_candidate_evidence_digest: 'b'.repeat(64)
          },
          packages: {
            api: { path: 'packages/api/index.zip', sha256: 'c'.repeat(64) }
          }
        })
      }
    );
    expect(JSON.parse(projected)).toEqual(
      expect.objectContaining({
        artifact_digest: 'f'.repeat(64),
        schema_version: 3,
        environment: 'production',
        package_digests: { api: 'c'.repeat(64) }
      })
    );
  });

  it('never rebuilds a Release Bus artifact in deploy', () => {
    expect(deploy).toContain(
      "if: github.event.inputs.service != 'api' && github.event.inputs.operation_key == ''"
    );
    expect(deploy).toContain(
      "if: github.event.inputs.service == 'api' && github.event.inputs.operation_key == ''"
    );
    expect(deploy).toContain('Install immutable package');
    expect(deploy).not.toContain(
      "if: github.event.inputs.operation_key != ''\n        run: pushd src/"
    );
    expect(deploy).toContain('consumed_preflight_artifact:true');
    expect(deploy).toContain('rebuilt:false');
  });

  it('passes environment-bound v3 inputs on every prepare and deploy path', () => {
    for (const workflow of [
      'release-bus-v2-preflight.yml',
      'deploy.yml',
      'release-bus-deploy-staging.yml'
    ]) {
      const dispatches = reconciler.split(`workflow: '${workflow}'`).slice(1);
      expect(dispatches.length).toBeGreaterThan(0);
      for (const dispatch of dispatches) {
        const inputs = dispatch.slice(0, 1800);
        expect(inputs).toMatch(
          /artifact_contract_version|\.\.\.artifactBinding/
        );
        expect(inputs).toMatch(/artifact_environment|\.\.\.artifactBinding/);
      }
    }
    expect(reconciler).toContain('function candidateArtifactDeployBinding(');
    expect(reconciler).toContain("artifact_contract_version: 'legacy-v2'");
    expect(reconciler).toContain(
      'artifact_contract_version: ENVIRONMENT_BOUND_ARTIFACT_CONTRACT'
    );
    expect(reconciler).not.toContain('EXACT_STAGING_MANIFEST_REUSED');
    expect(reconciler).not.toContain('findExactValidatedProductionManifest');
  });

  it('does not escalate a lane-local train failure to ALL', () => {
    const failTrain = reconciler
      .split('private async failTrain(')[1]
      ?.split('private async deferTrainForInfrastructure(')[0];
    expect(failTrain).toBeTruthy();
    expect(failTrain).not.toContain("'ALL'");
    expect(failTrain).toContain("current.lane === 'STAGING'");
    expect(failTrain).toContain("'PRODUCTION'");
  });

  it('tracks the measured baselines and target ranges as a stable fixture', () => {
    const contract = JSON.parse(
      read('ops/deployment-bus/release-bus-performance-contract.v1.json')
    ) as {
      baselines: Array<Record<string, unknown>>;
      critical_path: {
        excluded_train_gates: string[];
        normal_preflight_jobs: string[];
        normal_preflight_steps: string[];
      };
      targets: Record<string, { minimum: number; maximum: number }>;
    };
    expect(contract.baselines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workflow_run_id: '30298700708' }),
        expect.objectContaining({
          preflight_workflow_run_id: '30353236225'
        })
      ])
    );
    expect(contract.critical_path.excluded_train_gates).toHaveLength(7);
    expect(contract.critical_path.normal_preflight_jobs).toEqual(['preflight']);
    expect(contract.critical_path.normal_preflight_steps).toHaveLength(12);
    expect(
      contract.targets
        .healthy_one_unit_backend_production_minutes_excluding_runner_queue
    ).toEqual({ minimum: 6, maximum: 10 });
  });
});
