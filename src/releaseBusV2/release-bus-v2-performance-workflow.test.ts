import {
  chmodSync,
  existsSync,
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
import YAML from 'yaml';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');
const LEGACY_PR_CI_WORKFLOW_BLOB = '0cc8865dbb869b5156b46cc45e8581b259052916';

describe('Release Bus v2 backend critical-path contract', () => {
  const preflight = read('.github/workflows/release-bus-v2-preflight.yml');
  const deploy = read('.github/workflows/deploy.yml');
  const pullRequestCi = read('.github/workflows/on-pull-request.yml');
  const pullRequestCiBlob = execFileSync(
    'git',
    ['hash-object', '.github/workflows/on-pull-request.yml'],
    { cwd: root, encoding: 'utf8' }
  ).trim();
  const legacyPullRequestCi = pullRequestCiBlob === LEGACY_PR_CI_WORKFLOW_BLOB;
  const reconciler = read('src/releaseBusV2/release-bus-v2.reconciler.ts');

  it('keeps one candidate build runner without repository quality matrices', () => {
    const contract = JSON.parse(
      read('ops/deployment-bus/release-bus-performance-contract.v1.json')
    ) as {
      critical_path: {
        normal_preflight_jobs: string[];
        normal_preflight_steps: string[];
      };
    };
    const parsed = YAML.parse(preflight) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    expect(Object.keys(parsed.jobs)).toEqual(
      contract.critical_path.normal_preflight_jobs
    );
    const steps = contract.critical_path.normal_preflight_jobs.flatMap(
      (job) => parsed.jobs[job].steps
    );
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

  it('guards every deploy before checkout, caches, cloud credentials, or mutation', () => {
    const parsed = YAML.parse(deploy) as {
      concurrency: { group: string; 'cancel-in-progress': boolean };
      jobs: Record<
        string,
        {
          steps: Array<{
            name?: string;
            if?: string;
            uses?: string;
            run?: string;
          }>;
        }
      >;
    };
    const steps = parsed.jobs['build-and-deploy'].steps;
    const syntax = steps.findIndex(
      ({ name }) => name === 'Validate dispatch inputs before using credentials'
    );
    const authorize = steps.findIndex(
      ({ name }) => name === 'Authorize exact deployment operation'
    );
    const checkout = steps.findIndex(({ name }) => name === 'Checkout');
    const verifySource = steps.findIndex(
      ({ name }) => name === 'Verify immutable source'
    );
    const setupNode = steps.findIndex(({ name }) =>
      name?.startsWith('Install Node.js')
    );
    const aws = steps.findIndex(
      ({ name }) => name === 'Configure AWS credentials'
    );
    const emergencyRevalidation = steps.findIndex(
      ({ name }) =>
        name ===
        'Revalidate emergency API bootstrap immediately before cloud credentials'
    );
    const deployStep = steps.findIndex(({ name }) => name === 'Deploy API');

    expect(syntax).toBe(0);
    expect(authorize).toBe(1);
    expect(checkout).toBeGreaterThan(authorize);
    expect(verifySource).toBe(checkout + 1);
    expect(setupNode).toBeGreaterThan(checkout);
    expect(setupNode).toBeGreaterThan(verifySource);
    expect(aws).toBeGreaterThan(setupNode);
    expect(emergencyRevalidation).toBe(aws - 1);
    expect(deployStep).toBeGreaterThan(aws);
    for (const step of steps.slice(0, authorize)) {
      expect(step.uses).toBeUndefined();
      expect(step.run ?? '').not.toMatch(
        /actions\/checkout|actions\/setup-node|configure-aws-credentials|git\s+(?:fetch|checkout)|npm\s+(?:ci|i|run)/
      );
    }
    const syntaxScript = steps[syntax]?.run ?? '';
    for (const manualOnlyEmpty of [
      'INPUT_TRAIN_ID',
      'INPUT_TRAIN_REVISION',
      'INPUT_EXPECTED_SHA',
      'INPUT_ARTIFACT_RUN_ID',
      'INPUT_ARTIFACT_TRAIN_ID',
      'INPUT_ARTIFACT_DIGEST',
      'INPUT_ARTIFACT_ENVIRONMENT'
    ])
      expect(syntaxScript).toContain(`test -z "$${manualOnlyEmpty}"`);
    expect(syntaxScript).toContain(
      'test "$INPUT_ARTIFACT_CONTRACT_VERSION" = legacy-v2'
    );

    const guard = steps[authorize]?.run ?? '';
    expect(steps[authorize]?.if).toBeUndefined();
    expect(guard).toContain('if [ -n "$INPUT_OPERATION_KEY" ]');
    expect(guard).toContain('release-bus-v2/authorize');
    expect(guard).toContain('release-bus-v2/manual-deployment-readiness');
    expect(guard).toContain('--connect-timeout 10');
    expect(guard).toContain('--max-time 60');
    expect(guard).toContain('--argjson workflow_run_attempt');
    expect(guard).toContain('--arg source_ref "$GITHUB_REF_NAME"');
    expect(guard).toContain('--arg source_sha "$GITHUB_SHA"');
    expect(guard).toContain('.ready == true and .mode == "manual"');
    expect(guard).toContain('.authorized == true and .train_id == $train_id');
    expect(guard).toContain('if [ "$INPUT_EMERGENCY_API_BOOTSTRAP" = true ]');
    expect(guard).toContain(
      'Manual backend deployment workflow identity is invalid'
    );
    expect(guard).toContain('emergency-api-bootstrap-readiness.sh');
    expect(guard).toContain('EMERGENCY_API_BOOTSTRAP_AUTHORIZED');
    expect(guard).toContain('>> "$GITHUB_STEP_SUMMARY"');
    expect(guard).toContain('.name == "production-environment" and');
    expect(guard).toContain('.lane == "PRODUCTION" and');
    expect(guard).toContain(
      '$RELEASE_BUS_API_URL/deploy/release-bus-v2/trains'
    );
    expect(guard).not.toContain('head -c 4000');
    expect(steps[verifySource]?.if).toBeUndefined();
    expect(steps[verifySource]?.run).toContain(
      'expected_source_sha="$GITHUB_SHA"'
    );
    expect(steps[verifySource]?.run).toContain(
      'expected_source_sha="$INPUT_EXPECTED_SHA"'
    );
    expect(deploy).not.toContain('Authorize immutable Release Bus operation');
    expect(JSON.stringify(steps[checkout])).toContain('github.sha');
    expect(parsed.concurrency.group).toContain("|| 'manual'");
    expect(parsed.concurrency.group).not.toContain('manual-production');
    expect(parsed.concurrency['cancel-in-progress']).toBe(false);
  });

  it('executes the early guard with exact manual and Release Bus payloads', () => {
    const parsed = YAML.parse(deploy) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const guard = parsed.jobs['build-and-deploy'].steps.find(
      ({ name }) => name === 'Authorize exact deployment operation'
    )?.run;
    expect(guard).toBeTruthy();
    const fixture = mkdtempSync(path.join(tmpdir(), 'deploy-guard-'));
    const fakeCurl = path.join(fixture, 'curl');
    const capturePayload = path.join(fixture, 'payload.json');
    const captureUrl = path.join(fixture, 'url.txt');
    const response = path.join(fixture, 'response.json');
    writeFileSync(
      fakeCurl,
      `#!/bin/sh
output=
payload=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --data) payload="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s' "$payload" > "$CAPTURE_PAYLOAD"
printf '%s' "$url" > "$CAPTURE_URL"
cp "$CAPTURE_RESPONSE" "$output"
printf '200'
`
    );
    chmodSync(fakeCurl, 0o755);
    const execute = (operationKey: string) => {
      const manual = operationKey.length === 0;
      writeFileSync(
        response,
        `${JSON.stringify(
          manual
            ? {
                ready: true,
                mode: 'manual',
                lane: 'STAGING',
                repository: 'backend',
                environment: 'staging',
                service: 'api',
                workflow_run_id: '12345',
                workflow_run_attempt: 2,
                source_ref: '1a-staging',
                source_sha: 'a'.repeat(40)
              }
            : {
                authorized: true,
                train_id: 'train-id',
                operation_key: operationKey
              }
        )}\n`
      );
      execFileSync('bash', ['-c', guard ?? 'exit 1'], {
        cwd: root,
        env: {
          ...process.env,
          CAPTURE_PAYLOAD: capturePayload,
          CAPTURE_RESPONSE: response,
          CAPTURE_URL: captureUrl,
          GITHUB_REF_NAME: '1a-staging',
          GITHUB_RUN_ATTEMPT: '2',
          GITHUB_RUN_ID: '12345',
          GITHUB_SHA: 'a'.repeat(40),
          INPUT_ARTIFACT_DIGEST: 'b'.repeat(64),
          INPUT_ARTIFACT_RUN_ID: '54321',
          INPUT_EMERGENCY_API_BOOTSTRAP: 'false',
          INPUT_EMERGENCY_API_BOOTSTRAP_EXPECTED_SHA: '',
          INPUT_EMERGENCY_API_BOOTSTRAP_REASON: '',
          INPUT_ENVIRONMENT: 'staging',
          INPUT_EXPECTED_SHA: 'a'.repeat(40),
          INPUT_OPERATION_KEY: operationKey,
          INPUT_SERVICE: 'api',
          INPUT_TRAIN_ID: 'train-id',
          PATH: `${fixture}:${process.env.PATH ?? ''}`,
          RELEASE_BUS_API_URL: 'https://release-bus.invalid',
          RELEASE_BUS_WORKFLOW_AUTH_TOKEN: 'test-token'
        }
      });
      return {
        payload: JSON.parse(readFileSync(capturePayload, 'utf8')) as Record<
          string,
          unknown
        >,
        url: readFileSync(captureUrl, 'utf8')
      };
    };
    try {
      expect(execute('')).toEqual({
        payload: {
          repository: 'backend',
          environment: 'staging',
          service: 'api',
          workflow_run_id: '12345',
          workflow_run_attempt: 2,
          source_ref: '1a-staging',
          source_sha: 'a'.repeat(40)
        },
        url: 'https://release-bus.invalid/deploy/release-bus-v2/manual-deployment-readiness'
      });
      expect(execute('rb2:train-id:deploy:api:a1')).toEqual({
        payload: {
          train_id: 'train-id',
          operation_key: 'rb2:train-id:deploy:api:a1',
          workflow_run_id: '12345',
          artifact_run_id: '54321',
          repository: 'backend',
          environment: 'staging',
          service: 'api',
          expected_sha: 'a'.repeat(40),
          artifact_digest: 'b'.repeat(64)
        },
        url: 'https://release-bus.invalid/deploy/release-bus-v2/authorize'
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('keeps emergency API bootstrap exact, opt-out only, and default-off', () => {
    const parsed = YAML.parse(deploy) as {
      on: {
        workflow_dispatch: {
          inputs: Record<string, { default?: boolean; type?: string }>;
        };
      };
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    expect(
      parsed.on.workflow_dispatch.inputs.emergency_api_bootstrap
    ).toMatchObject({
      type: 'boolean',
      default: false
    });
    const validation = parsed.jobs['build-and-deploy'].steps.find(
      ({ name }) => name === 'Validate dispatch inputs before using credentials'
    )?.run;
    expect(validation).toBeTruthy();
    const baseEnv = {
      ...process.env,
      GITHUB_ACTOR: 'prxt6529',
      GITHUB_REF_NAME: 'main',
      GITHUB_SHA: 'a'.repeat(40),
      INPUT_ARTIFACT_CONTRACT_VERSION: 'legacy-v2',
      INPUT_ARTIFACT_DIGEST: '',
      INPUT_ARTIFACT_ENVIRONMENT: '',
      INPUT_ARTIFACT_RUN_ID: '',
      INPUT_ARTIFACT_TRAIN_ID: '',
      INPUT_EMERGENCY_API_BOOTSTRAP: 'true',
      INPUT_EMERGENCY_API_BOOTSTRAP_EXPECTED_SHA: 'a'.repeat(40),
      INPUT_EMERGENCY_API_BOOTSTRAP_REASON: 'manual-authorizer-self-bootstrap',
      EMERGENCY_API_BOOTSTRAP_ACTORS: '["prxt6529"]',
      INPUT_ENVIRONMENT: 'prod',
      INPUT_EXPECTED_SHA: '',
      INPUT_OPERATION_KEY: '',
      INPUT_RELEASE_CONTRIBUTORS: '[]',
      INPUT_RELEASE_GROUP_SERVICES: '',
      INPUT_RELEASE_NOTE_GROUPS: '',
      INPUT_RELEASE_NOTE_OPT_OUT: 'true',
      INPUT_RELEASE_NOTE_PUBLISH: 'false',
      INPUT_RELEASE_PULL_REQUEST: '',
      INPUT_SERVICE: 'api',
      INPUT_TRAIN_ID: '',
      INPUT_TRAIN_REVISION: ''
    };
    const execute = (overrides: NodeJS.ProcessEnv = {}) =>
      execFileSync('bash', ['-c', validation ?? 'exit 1'], {
        cwd: root,
        env: { ...baseEnv, ...overrides },
        stdio: 'pipe'
      });

    expect(() => execute()).not.toThrow();
    for (const invalid of [
      { GITHUB_ACTOR: 'other-user' },
      { GITHUB_REF_NAME: '1a-staging' },
      { GITHUB_SHA: 'b'.repeat(40) },
      { INPUT_ENVIRONMENT: 'staging' },
      { INPUT_SERVICE: 'transactionsLoop' },
      { INPUT_EMERGENCY_API_BOOTSTRAP_REASON: 'short' },
      { INPUT_RELEASE_NOTE_OPT_OUT: 'false' },
      { INPUT_RELEASE_NOTE_PUBLISH: 'true' },
      { INPUT_RELEASE_PULL_REQUEST: '1861' }
    ])
      expect(() => execute(invalid)).toThrow();
    expect(() =>
      execute({
        INPUT_EMERGENCY_API_BOOTSTRAP: 'false',
        INPUT_EMERGENCY_API_BOOTSTRAP_EXPECTED_SHA: '',
        INPUT_EMERGENCY_API_BOOTSTRAP_REASON: '',
        INPUT_RELEASE_NOTE_OPT_OUT: 'false'
      })
    ).not.toThrow();
  });

  it('executes the authenticated emergency compatibility guard and durable audit', () => {
    const parsed = YAML.parse(deploy) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const steps = parsed.jobs['build-and-deploy'].steps;
    const authorize = steps.find(
      ({ name }) => name === 'Authorize exact deployment operation'
    )?.run;
    const revalidate = steps.find(
      ({ name }) =>
        name ===
        'Revalidate emergency API bootstrap immediately before cloud credentials'
    )?.run;
    expect(authorize).toBeTruthy();
    expect(revalidate).toBeTruthy();

    const fixture = mkdtempSync(path.join(tmpdir(), 'emergency-bootstrap-'));
    const fakeCurl = path.join(fixture, 'curl');
    const callLog = path.join(fixture, 'calls.txt');
    const argumentLog = path.join(fixture, 'arguments.txt');
    const githubOutput = path.join(fixture, 'github-output.txt');
    const githubSummary = path.join(fixture, 'github-summary.md');
    writeFileSync(
      fakeCurl,
      `#!/bin/sh
output=
headers=
url=
printf '%s\\n' "$*" >> "$ARGUMENT_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --dump-header) headers="$2"; shift 2 ;;
    --data) shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$url" >> "$CALL_LOG"
if [ -n "$headers" ]; then
  printf 'HTTP/1.1 200 OK\\r\\nCache-Control: no-cache, no-store, must-revalidate\\r\\n\\r\\n' > "$headers"
fi
case "$url" in
  */manual-deployment-readiness)
    printf '{"error":"Manual backend deployment workflow identity is invalid"}' > "$output"
    printf '409'
    ;;
  */release-bus-v2/controls)
    if [ "$FAKE_BLOCKED" = true ]; then
      printf '%s' '{"mode":"PRODUCTION","controls":[{"scope":"ALL","paused":false}],"lanes":[{"lane":"PRODUCTION","status":"OFF","changeable":true}],"locks":[{"name":"production-environment","owner_train_id":"active-train","lease_owner":"worker","lease_token":"held"}]}' > "$output"
    else
      printf '%s' '{"mode":"PRODUCTION","controls":[{"scope":"ALL","paused":false}],"lanes":[{"lane":"PRODUCTION","status":"OFF","changeable":true}],"locks":[{"name":"production-environment","owner_train_id":null,"lease_owner":null,"lease_token":null}]}' > "$output"
    fi
    printf '200'
    ;;
  */release-bus-v2/trains)
    printf '%s' '{"mode":"PRODUCTION","trains":[]}' > "$output"
    printf '200'
    ;;
  */git/ref/heads/main)
    printf '%s' '{"object":{"sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}' > "$output"
    printf '200'
    ;;
  */actions/runs/12345)
    printf '%s' '{"id":12345,"run_attempt":2,"actor":{"login":"prxt6529"},"event":"workflow_dispatch","path":".github/workflows/deploy.yml","status":"in_progress","conclusion":null,"head_branch":"main","head_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","name":"Deploy api to prod [manual]","display_title":"Deploy api to prod [manual]"}' > "$output"
    printf '200'
    ;;
  */contents/.github/workflows/*)
    if [ "$FAKE_MISSING_WORKFLOW" = true ]; then
      printf '%s' '{"message":"Not Found"}' > "$output"
      printf '404'
    else
      printf '%s' '{"type":"file","sha":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' > "$output"
      printf '200'
    fi
    ;;
  */actions/runs?*)
    if [ "$FAKE_INCOMPLETE_RUN_PAGE" = true ]; then
      printf '%s' '{"total_count":101,"workflow_runs":[]}' > "$output"
    else
      printf '%s' '{"total_count":0,"workflow_runs":[]}' > "$output"
    fi
    printf '200'
    ;;
  *)
    printf '%s' '{"error":"unexpected fake curl URL"}' > "$output"
    printf '500'
    ;;
esac
`
    );
    chmodSync(fakeCurl, 0o755);
    const env = {
      ...process.env,
      ARGUMENT_LOG: argumentLog,
      CALL_LOG: callLog,
      FAKE_BLOCKED: 'false',
      FAKE_INCOMPLETE_RUN_PAGE: 'false',
      FAKE_MISSING_WORKFLOW: 'false',
      GITHUB_ACTOR: 'prxt6529',
      GITHUB_API_URL: 'https://api.github.invalid',
      GITHUB_OUTPUT: githubOutput,
      GITHUB_REF_NAME: 'main',
      GITHUB_REPOSITORY: '6529-Collections/6529seize-backend',
      GITHUB_REPOSITORY_OWNER: '6529-Collections',
      GITHUB_RUN_ATTEMPT: '2',
      GITHUB_RUN_ID: '12345',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_SHA: 'a'.repeat(40),
      GITHUB_STEP_SUMMARY: githubSummary,
      GITHUB_TOKEN: 'github-token',
      INPUT_ARTIFACT_DIGEST: '',
      INPUT_ARTIFACT_RUN_ID: '',
      INPUT_EMERGENCY_API_BOOTSTRAP: 'true',
      INPUT_EMERGENCY_API_BOOTSTRAP_EXPECTED_SHA: 'a'.repeat(40),
      INPUT_EMERGENCY_API_BOOTSTRAP_REASON: 'manual-authorizer-self-bootstrap',
      INPUT_ENVIRONMENT: 'prod',
      INPUT_EXPECTED_SHA: '',
      INPUT_OPERATION_KEY: '',
      INPUT_SERVICE: 'api',
      INPUT_TRAIN_ID: '',
      PATH: `${fixture}:${process.env.PATH ?? ''}`,
      RELEASE_BUS_API_URL: 'https://release-bus.invalid',
      RELEASE_BUS_WORKFLOW_AUTH_TOKEN: 'workflow-token',
      RUNNER_TEMP: fixture
    };
    try {
      expect(() =>
        execFileSync('bash', ['-c', authorize ?? 'exit 1'], {
          cwd: root,
          env,
          stdio: 'pipe'
        })
      ).not.toThrow();
      expect(readFileSync(githubOutput, 'utf8')).toContain(
        'emergency_compatibility_fallback=true'
      );
      expect(readFileSync(githubSummary, 'utf8')).toContain(
        '"authorization_mode":"legacy-identity-compatibility"'
      );
      expect(readFileSync(githubSummary, 'utf8')).toContain(
        '"reason":"manual-authorizer-self-bootstrap"'
      );
      expect(() =>
        execFileSync('bash', ['-c', revalidate ?? 'exit 1'], {
          cwd: root,
          env,
          stdio: 'pipe'
        })
      ).not.toThrow();
      const calls = readFileSync(callLog, 'utf8');
      expect(calls).toContain('/manual-deployment-readiness');
      expect(calls).toContain('/release-bus-v2/controls');
      expect(calls).toContain('/release-bus-v2/trains');
      expect(calls).toContain('/git/ref/heads/main');
      expect(calls).toContain('/actions/runs/12345');
      expect(calls).toContain(
        '/contents/.github/workflows/build-upload-deploy-prod.yml?ref=main'
      );
      expect(calls).toContain(
        '/repos/6529-Collections/6529seize-frontend/actions/runs?'
      );
      expect(authorize).toContain('.total_count');
      expect(authorize).toContain(
        'deploy-control-prod-manual concurrency group'
      );
      expect(readFileSync(argumentLog, 'utf8')).toContain(
        'Authorization: Bearer workflow-token'
      );
      expect(() =>
        execFileSync('bash', ['-c', authorize ?? 'exit 1'], {
          cwd: root,
          env: { ...env, FAKE_BLOCKED: 'true' },
          stdio: 'pipe'
        })
      ).toThrow();
      expect(() =>
        execFileSync('bash', ['-c', authorize ?? 'exit 1'], {
          cwd: root,
          env: { ...env, FAKE_INCOMPLETE_RUN_PAGE: 'true' },
          stdio: 'pipe'
        })
      ).toThrow();
      expect(readFileSync(callLog, 'utf8')).toContain('page=2');
      expect(() =>
        execFileSync('bash', ['-c', authorize ?? 'exit 1'], {
          cwd: root,
          env: { ...env, FAKE_MISSING_WORKFLOW: 'true' },
          stdio: 'pipe'
        })
      ).toThrow();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('rejects cross-train v3 artifacts before authorization or checkout', () => {
    const parsed = YAML.parse(deploy) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const validation = parsed.jobs['build-and-deploy'].steps.find(
      ({ name }) => name === 'Validate dispatch inputs before using credentials'
    )?.run;
    const execute = (artifactTrainId: string) =>
      execFileSync('bash', ['-c', validation ?? 'exit 1'], {
        cwd: root,
        env: {
          ...process.env,
          INPUT_ARTIFACT_CONTRACT_VERSION: 'environment-bound-v3',
          INPUT_ARTIFACT_DIGEST: 'b'.repeat(64),
          INPUT_ARTIFACT_ENVIRONMENT: 'production',
          INPUT_ARTIFACT_RUN_ID: '54321',
          INPUT_ARTIFACT_TRAIN_ID: artifactTrainId,
          INPUT_EMERGENCY_API_BOOTSTRAP: 'false',
          INPUT_EMERGENCY_API_BOOTSTRAP_EXPECTED_SHA: '',
          INPUT_EMERGENCY_API_BOOTSTRAP_REASON: '',
          INPUT_ENVIRONMENT: 'prod',
          INPUT_EXPECTED_SHA: 'a'.repeat(40),
          INPUT_OPERATION_KEY: 'rb2:train-id:deploy:api:a1',
          INPUT_RELEASE_CONTRIBUTORS: '[]',
          INPUT_SERVICE: 'api',
          INPUT_TRAIN_ID: 'train-id',
          INPUT_TRAIN_REVISION: '1'
        },
        stdio: 'pipe'
      });

    expect(() => execute('other-train')).toThrow();
    expect(() => execute('train-id')).not.toThrow();
    expect(() => execute('')).not.toThrow();
  });

  it('keeps full tests in exact merge-tree PR CI before evidence is emitted', () => {
    const parsed = YAML.parse(pullRequestCi) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const steps = parsed.jobs.build.steps;
    if (legacyPullRequestCi) {
      expect(pullRequestCiBlob).toBe(LEGACY_PR_CI_WORKFLOW_BLOB);
      expect(steps.find(({ name }) => name === 'Build backend')?.run).toContain(
        'npm run build'
      );
      expect(steps.find(({ name }) => name === 'Lint')?.run).toContain(
        'npm run lint:check'
      );
      expect(steps.find(({ name }) => name === 'Format')?.run).toContain(
        'npm run format:check'
      );
      expect(steps.find(({ name }) => name === 'Build API')?.run).toContain(
        'npm run build'
      );
      return;
    }
    const test = steps.findIndex(({ name }) => name === 'Test backend');
    const build = steps.findIndex(({ name }) => name === 'Build backend');
    const bind = steps.findIndex(
      ({ name }) => name === 'Bind exact PR merge-tree CI evidence'
    );
    expect(test).toBeGreaterThan(0);
    expect(steps[test]).toMatchObject({ 'timeout-minutes': 30 });
    expect(steps[test].run).toContain('jest --listTests');
    expect(steps[test].run).toContain('--shard="$shard/4"');
    expect(steps[test].run).toContain('jest --maxWorkers=2');
    expect(steps[test].run).toContain('diff -u complete.sorted shards.sorted');
    expect(steps[test].run).toContain('npm run ci:assert-source-clean');
    expect(build).toBeGreaterThan(test);
    expect(bind).toBeGreaterThan(build);
    expect(steps[bind].run).toContain('"backend-test-and-typecheck"');
  });

  it('isolates secret-bearing authorization and reporting from candidate-controlled code', () => {
    const parsed = YAML.parse(preflight) as {
      jobs: Record<
        string,
        {
          needs?: string | string[];
          steps: Array<{ name?: string; run?: string; uses?: string }>;
        }
      >;
    };
    expect(Object.keys(parsed.jobs)).toEqual([
      'authorize',
      'preflight',
      'report'
    ]);
    expect(parsed.jobs.preflight.needs).toBe('authorize');
    expect(parsed.jobs.report.needs).toEqual(['authorize', 'preflight']);
    const candidateJob = JSON.stringify(parsed.jobs.preflight);
    expect(candidateJob).not.toContain('RELEASE_BUS_WORKFLOW_AUTH_TOKEN');
    expect(candidateJob).toContain('actions/checkout@');
    expect(candidateJob).toContain('release-bus-package-backend.mjs');
    for (const trustedJob of ['authorize', 'report']) {
      const serialized = JSON.stringify(parsed.jobs[trustedJob]);
      expect(serialized).toContain('RELEASE_BUS_WORKFLOW_AUTH_TOKEN');
      expect(serialized).not.toContain('actions/checkout@');
      expect(serialized).not.toContain('release-bus-package-backend.mjs');
      expect(serialized).not.toMatch(/\bnpm\s+(?:ci|run)\b/);
    }
    const buildJobs = Object.values(parsed.jobs).filter((job) =>
      JSON.stringify(job).includes('Install frozen shared dependencies once')
    );
    expect(buildJobs).toHaveLength(1);
  });

  it('authorizes before candidate checkout or cache and verifies the exact live source tip', () => {
    const parsed = YAML.parse(preflight) as {
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
    const steps = [
      ...parsed.jobs.authorize.steps,
      ...parsed.jobs.preflight.steps,
      ...parsed.jobs.report.steps
    ];
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
      uses: expect.stringMatching(/^actions\/checkout@[a-f0-9]{40}$/)
    });
    expect(steps[checkout].if).toBe("steps.evidence.outcome == 'success'");
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
    const parsed = YAML.parse(preflight) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const authorize = parsed.jobs.authorize.steps.find(
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
          REUSE_ARTIFACT_DIGEST:
            candidateEvidenceMode === 'strict-single' ? '9'.repeat(64) : '',
          REUSE_ARTIFACT_NAME:
            candidateEvidenceMode === 'strict-single'
              ? `release-bus-v2-pr-${'a'.repeat(40)}`
              : '',
          REUSE_ARTIFACT_RUN_ID:
            candidateEvidenceMode === 'strict-single' ? '54321' : '',
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
      expect(execute('strict-single')).toEqual(
        expect.objectContaining({
          source_ref: 'release-bus-v2/train-id/backend',
          candidate_evidence_mode: 'strict-single',
          aggregate_candidate_evidence_digest: null,
          reuse_artifact_run_id: '54321',
          reuse_artifact_name: `release-bus-v2-pr-${'a'.repeat(40)}`,
          reuse_artifact_digest: '9'.repeat(64)
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

  it('uses every PR CI artifact only as evidence and always builds fresh train bytes', () => {
    expect(preflight).toContain('Verify exact green PR CI evidence');
    expect(preflight).toContain('.head_sha == $expected_sha');
    expect(preflight).not.toContain('Download exact green PR artifact');
    expect(preflight).toContain('is_exact_evidence_archive=false');
    expect(preflight).toContain(
      '# bytes are never promoted into a staging or production train.'
    );
    expect(preflight).not.toContain('artifact_bytes_reused=true');
    expect(preflight).not.toContain(
      "steps.evidence.outputs.artifact_bytes_reused == 'true'"
    );
    expect(preflight).not.toContain(
      'mv legacy-deploy-artifact release-bus-artifact'
    );
    expect(preflight).toContain(
      '((.artifact_bytes_reused // false) == false) and'
    );
    expect(preflight).toContain(
      '((.reused_exact_pr_artifact // false) == false)'
    );
    expect(preflight).toContain("if: steps.package.outcome == 'success'");
    const pullRequest = read('.github/workflows/on-pull-request.yml');
    if (legacyPullRequestCi) {
      expect(pullRequestCiBlob).toBe(LEGACY_PR_CI_WORKFLOW_BLOB);
      expect(pullRequest).toContain('npm run lint:check');
      expect(pullRequest).toContain('npm run build');
      expect(pullRequest).not.toContain('policy-bundle.txt');
      return;
    }
    expect(pullRequest).toContain('exact-merge-tree-pr-ci-v1');
    expect(pullRequest).not.toContain(
      'release-bus-v2-pr-artifact/packages/api'
    );
    expect(pullRequest).toContain('--expected-git-ref "$EXPECTED_MERGE_SHA"');
    expect(pullRequest).toContain('policy-bundle.txt');
  });

  it('treats an old-producer schema-v1 PR artifact as evidence and still builds fresh bytes', () => {
    const parsed = YAML.parse(preflight) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const evidence = parsed.jobs.preflight.steps.find(
      ({ name }) => name === 'Verify exact green PR CI evidence'
    );
    const fixture = mkdtempSync(path.join(tmpdir(), 'rb2-old-new-evidence-'));
    const artifactDirectory = path.join(fixture, 'artifact');
    const artifactZip = path.join(fixture, 'artifact.zip');
    const output = path.join(fixture, 'github-output');
    const fakeGh = path.join(fixture, 'gh');
    const expectedSha = 'a'.repeat(40);
    mkdirSync(artifactDirectory);
    writeFileSync(
      path.join(artifactDirectory, 'policy-bundle.txt'),
      'policy\n'
    );
    const policyDigest = execFileSync(
      'sha256sum',
      [path.join(artifactDirectory, 'policy-bundle.txt')],
      { encoding: 'utf8' }
    ).split(' ')[0];
    writeFileSync(
      path.join(artifactDirectory, 'manifest.json'),
      JSON.stringify({
        schema_version: 1,
        evidence_contract: 'exact-merge-tree-pr-ci-v1',
        repository: 'backend',
        merge_sha: expectedSha,
        workflow: '.github/workflows/on-pull-request.yml',
        policy_bundle_contract: 'pr-ci-policy-bundle-v1',
        policy_bundle_digest: policyDigest,
        policy_bundle_line_count: 1
      })
    );
    const sums = execFileSync(
      'sha256sum',
      ['manifest.json', 'policy-bundle.txt'],
      { cwd: artifactDirectory, encoding: 'utf8' }
    );
    writeFileSync(path.join(artifactDirectory, 'SHA256SUMS'), sums);
    execFileSync(
      'zip',
      ['-q', artifactZip, 'SHA256SUMS', 'manifest.json', 'policy-bundle.txt'],
      { cwd: artifactDirectory }
    );
    writeFileSync(
      fakeGh,
      `#!/bin/sh
case "$*" in
  *actions/runs/54321/artifacts*)
    printf '{"artifacts":[{"id":777,"expired":false,"name":"release-bus-v2-pr-${expectedSha}","digest":"sha256:%s"}]}\\n' "${'9'.repeat(64)}"
    ;;
  *actions/runs/54321)
    printf '{"event":"pull_request","status":"completed","conclusion":"success","head_sha":"${expectedSha}","path":".github/workflows/on-pull-request.yml"}\\n'
    ;;
  *actions/artifacts/777/zip)
    cat "$ARTIFACT_ZIP"
    ;;
  *) exit 1 ;;
esac
`
    );
    chmodSync(fakeGh, 0o755);
    writeFileSync(output, '');
    try {
      execFileSync('bash', ['-c', evidence?.run ?? 'exit 1'], {
        cwd: fixture,
        env: {
          ...process.env,
          ARTIFACT_ZIP: artifactZip,
          CANDIDATE_EVIDENCE_MODE: 'legacy-whole-train',
          DEPLOY_LAYERS: '[]',
          DEPLOY_UNITS: '["api"]',
          EXPECTED_SHA: expectedSha,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: '6529/backend',
          PATH: `${fixture}:${process.env.PATH ?? ''}`,
          REUSE_ARTIFACT_DIGEST: '9'.repeat(64),
          REUSE_ARTIFACT_NAME: `release-bus-v2-pr-${expectedSha}`,
          REUSE_ARTIFACT_RUN_ID: '54321',
          TRAIN_ID: 'train-id'
        },
        stdio: 'pipe'
      });
      expect(readFileSync(output, 'utf8')).toContain(
        'legacy_artifact_kind=evidence'
      );
      expect(readFileSync(output, 'utf8')).not.toContain(
        'artifact_bytes_reused=true'
      );
      expect(existsSync(path.join(fixture, 'release-bus-artifact'))).toBe(
        false
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('accepts old schema-v2 archives only as exact-SHA evidence', () => {
    const parsed = YAML.parse(preflight) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const evidence = parsed.jobs.preflight.steps.find(
      ({ name }) => name === 'Verify exact green PR CI evidence'
    );
    const fixture = mkdtempSync(path.join(tmpdir(), 'rb2-old-deploy-bytes-'));
    const artifactDirectory = path.join(fixture, 'artifact');
    const artifactZip = path.join(fixture, 'artifact.zip');
    const output = path.join(fixture, 'github-output');
    const fakeGh = path.join(fixture, 'gh');
    const expectedSha = 'a'.repeat(40);
    mkdirSync(path.join(artifactDirectory, 'packages/api'), {
      recursive: true
    });
    writeFileSync(
      path.join(artifactDirectory, 'packages/api/index.zip'),
      'immutable-api-package'
    );
    writeFileSync(
      path.join(artifactDirectory, 'manifest.json'),
      JSON.stringify({
        schema_version: 2,
        repository: 'backend',
        source_sha: expectedSha,
        units: ['api'],
        reused_exact_pr_artifact: false
      })
    );
    const sums = execFileSync(
      'sha256sum',
      ['packages/api/index.zip', 'manifest.json'],
      { cwd: artifactDirectory, encoding: 'utf8' }
    );
    writeFileSync(path.join(artifactDirectory, 'SHA256SUMS'), sums);
    execFileSync(
      'zip',
      [
        '-q',
        artifactZip,
        'SHA256SUMS',
        'manifest.json',
        'packages/api/index.zip'
      ],
      { cwd: artifactDirectory }
    );
    writeFileSync(
      fakeGh,
      `#!/bin/sh
case "$*" in
  *actions/runs/54321/artifacts*)
    printf '{"artifacts":[{"id":777,"expired":false,"name":"release-bus-v2-pr-${expectedSha}","digest":"sha256:%s"}]}\\n' "${'9'.repeat(64)}"
    ;;
  *actions/runs/54321)
    printf '{"event":"pull_request","status":"completed","conclusion":"success","head_sha":"${expectedSha}","path":".github/workflows/on-pull-request.yml"}\\n'
    ;;
  *actions/artifacts/777/zip)
    cat "$ARTIFACT_ZIP"
    ;;
  *) exit 1 ;;
esac
`
    );
    chmodSync(fakeGh, 0o755);
    const execute = (deployUnits: string[]) => {
      writeFileSync(output, '');
      rmSync(path.join(fixture, 'release-bus-artifact'), {
        recursive: true,
        force: true
      });
      execFileSync('bash', ['-c', evidence?.run ?? 'exit 1'], {
        cwd: fixture,
        env: {
          ...process.env,
          ARTIFACT_ZIP: artifactZip,
          CANDIDATE_EVIDENCE_MODE: 'legacy-whole-train',
          DEPLOY_LAYERS: '[]',
          DEPLOY_UNITS: JSON.stringify(deployUnits),
          EXPECTED_SHA: expectedSha,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: '6529/backend',
          PATH: `${fixture}:${process.env.PATH ?? ''}`,
          REUSE_ARTIFACT_DIGEST: '9'.repeat(64),
          REUSE_ARTIFACT_NAME: `release-bus-v2-pr-${expectedSha}`,
          REUSE_ARTIFACT_RUN_ID: '54321',
          TRAIN_ID: 'train-id'
        },
        stdio: 'pipe'
      });
      return readFileSync(output, 'utf8');
    };
    try {
      const incomplete = execute(['api', 'releaseBus']);
      expect(incomplete).toContain('legacy_artifact_kind=deploy-evidence');
      expect(incomplete).not.toContain('artifact_bytes_reused=true');
      expect(existsSync(path.join(fixture, 'release-bus-artifact'))).toBe(
        false
      );

      const exact = execute(['api']);
      expect(exact).toContain('legacy_artifact_kind=deploy-evidence');
      expect(exact).not.toContain('artifact_bytes_reused=true');
      expect(existsSync(path.join(fixture, 'release-bus-artifact'))).toBe(
        false
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('records exact Node and npm provenance in immutable PR CI evidence', () => {
    const policy = require('../../scripts/pr-ci-policy-bundle.cjs') as {
      FILE_PATHS: readonly string[];
      buildPolicyBundle(input: Record<string, unknown>): {
        canonical: string;
        digest: string;
      };
    };
    if (legacyPullRequestCi) {
      const modernOnly = new Set([
        'scripts/pr-ci-policy-bundle.cjs',
        'scripts/release-bus-backend-package-strategies.mjs',
        'scripts/release-bus-package-backend.mjs',
        'src/releaseBusV2/release-bus-v2-performance-workflow.test.ts'
      ]);
      const bridge = policy.buildPolicyBundle({
        root,
        filePaths: policy.FILE_PATHS.filter((file) => !modernOnly.has(file)),
        runtimePins: {},
        nodePinWorkflows: [],
        pinnedActionWorkflows: []
      });
      expect(bridge.digest).toBe(
        '12ee0bd6c718124c80ce3cd9c09d1287677027cb653db0ffeab21af1cd785143'
      );
      expect(pullRequestCiBlob).toBe(LEGACY_PR_CI_WORKFLOW_BLOB);
      return;
    }
    const { canonical } = policy.buildPolicyBundle({ root });
    expect(canonical).toContain('runtime-pin\tnode\t"22.17.1"\n');
    expect(canonical).toContain(
      'package-field\tpackage.json#packageManager\t"npm@10.9.8"\n'
    );
    expect(canonical).toContain(
      'package-field\tsrc/api-serverless/package.json#packageManager\t"npm@10.9.8"\n'
    );
    expect(canonical).toContain(
      'package-field\tpackage.json#dependencies.adm-zip\t"0.6.0"\n'
    );
    expect(canonical).toContain(
      'package-field\tsrc/api-serverless/package.json#dependencies.adm-zip\t"0.6.0"\n'
    );
    expect(canonical).toContain(
      'package-field\tpackage.json#devDependencies.yaml\t"2.9.0"\n'
    );
    const pullRequest = read('.github/workflows/on-pull-request.yml');
    expect(pullRequest).toContain('corepack install');
    expect(pullRequest).toContain('resolved="$(npm --version)"');
    expect(pullRequest).toContain(
      'Corepack did not activate the pinned npm (expected ${expected}, got ${resolved})'
    );
  });

  it('attributes source-ref transport, movement, and candidate graph failures separately', () => {
    const parsed = YAML.parse(preflight) as {
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
            CANDIDATE_EVIDENCE_MODE: 'strict-aggregate',
            EXPECTED_SHA: expectedSha,
            GH_MODE: mode,
            GH_RESPONSE_SHA: mode === 'moved' ? '0'.repeat(40) : expectedSha,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: '6529/backend',
            PATH: `${fixture}:${process.env.PATH ?? ''}`,
            SOURCE_REF: 'release-bus-v2/train-id/backend',
            TRAIN_ID: 'train-id'
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

  it('accepts old-producer empty portable identity and requires v3 environment binding', () => {
    const parsed = YAML.parse(preflight) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const validation = parsed.jobs.authorize.steps.find(
      ({ name }) =>
        name === 'Validate dispatch syntax without candidate checkout'
    );
    const execute = (
      candidateEvidenceMode: string,
      artifactContractVersion: string,
      artifactEnvironment: string
    ) =>
      execFileSync('bash', ['-c', validation?.run ?? 'exit 1'], {
        cwd: root,
        env: {
          ...process.env,
          AGGREGATE_CANDIDATE_EVIDENCE_DIGEST:
            candidateEvidenceMode === 'strict-aggregate' ? 'b'.repeat(64) : '',
          ARTIFACT_CONTRACT_VERSION: artifactContractVersion,
          ARTIFACT_ENVIRONMENT: artifactEnvironment,
          CANDIDATE_EVIDENCE_MODE: candidateEvidenceMode,
          DEPLOY_LAYERS: '[]',
          DEPLOY_UNITS: '["api"]',
          EXPECTED_SHA: 'a'.repeat(40),
          OPERATION_KEY: 'rb2:train-id:prepare:backend:a1',
          RELEASE_TRAIN_REVISION: '1',
          REUSE_ARTIFACT_DIGEST: '',
          REUSE_ARTIFACT_NAME: '',
          REUSE_ARTIFACT_RUN_ID: '',
          SOURCE_REF: 'feature/old-producer',
          TRAIN_ID: 'train-id'
        },
        stdio: 'pipe'
      });

    expect(() => execute('legacy-whole-train', 'legacy-v2', '')).not.toThrow();
    expect(() =>
      execute('legacy-whole-train', 'legacy-v2', 'portable')
    ).not.toThrow();
    expect(() =>
      execute('strict-aggregate', 'environment-bound-v3', '')
    ).toThrow();
    expect(() =>
      execute('strict-aggregate', 'environment-bound-v3', 'production')
    ).not.toThrow();
  });

  it('binds an old fast-path producer branch to one exact immutable train ref', () => {
    const parsed = YAML.parse(preflight) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const composition = parsed.jobs.preflight.steps.find(
      ({ name }) => name === 'Verify exact composition and deployment graph'
    );
    const fixture = mkdtempSync(path.join(tmpdir(), 'rb2-legacy-source-ref-'));
    const output = path.join(fixture, 'github-output');
    const fakeGh = path.join(fixture, 'gh');
    writeFileSync(
      fakeGh,
      `#!/bin/sh
case "$*" in
  *git/ref/heads/feature/old-producer)
    printf '{"ref":"refs/heads/feature/old-producer","object":{"type":"commit","sha":"%s"}}\\n' "${'0'.repeat(40)}"
    ;;
  *git/ref/heads/release-bus-v2/staging-train-train-id-backend)
    printf '{"ref":"refs/heads/release-bus-v2/staging-train-train-id-backend","object":{"type":"commit","sha":"%s"}}\\n' "$EXPECTED_SHA"
    ;;
  *)
    printf '{"status":"404"}\\n'
    exit 1
    ;;
esac
`
    );
    chmodSync(fakeGh, 0o755);
    const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim();
    writeFileSync(output, '');
    try {
      execFileSync('bash', ['-c', composition?.run ?? 'exit 1'], {
        cwd: root,
        env: {
          ...process.env,
          CANDIDATE_EVIDENCE_MODE: 'legacy-whole-train',
          DEPLOY_LAYERS: '[]',
          DEPLOY_UNITS: '["api"]',
          EXPECTED_SHA: expectedSha,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: '6529/backend',
          PATH: `${fixture}:${process.env.PATH ?? ''}`,
          SOURCE_REF: 'feature/old-producer',
          TRAIN_ID: 'train-id'
        },
        stdio: 'pipe'
      });
      expect(readFileSync(output, 'utf8')).toContain(
        'legacy_source_ref_bridge=true'
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('bridges legacy missing refs only through one exact lane ref and classifies ambiguity and transport', () => {
    const parsed = YAML.parse(preflight) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const composition = parsed.jobs.preflight.steps.find(
      ({ name }) => name === 'Verify exact composition and deployment graph'
    );
    const fixture = mkdtempSync(path.join(tmpdir(), 'rb2-missing-source-ref-'));
    const output = path.join(fixture, 'github-output');
    const fakeGh = path.join(fixture, 'gh');
    writeFileSync(
      fakeGh,
      `#!/bin/sh
case "$*" in
  *git/ref/heads/feature/missing)
    printf '{"status":"404"}\\n'
    exit 1
    ;;
  *git/ref/heads/release-bus-v2/staging-train-train-id-backend)
    if [ "$GH_CASE" = missing-success ] || [ "$GH_CASE" = ambiguous ]; then
      printf '{"ref":"refs/heads/release-bus-v2/staging-train-train-id-backend","object":{"type":"commit","sha":"%s"}}\\n' "$EXPECTED_SHA"
    else
      printf '{"status":"404"}\\n'
      exit 1
    fi
    ;;
  *git/ref/heads/release-bus-v2/production-train-train-id-backend)
    if [ "$GH_CASE" = ambiguous ]; then
      printf '{"ref":"refs/heads/release-bus-v2/production-train-train-id-backend","object":{"type":"commit","sha":"%s"}}\\n' "$EXPECTED_SHA"
    else
      printf '{"status":"404"}\\n'
      exit 1
    fi
    ;;
  *git/ref/heads/release-bus-v2/qualification-train-train-id-backend)
    if [ "$GH_CASE" = transport ]; then
      printf 'upstream gateway unavailable\\n' >&2
      exit 1
    fi
    printf '{"status":"404"}\\n'
    exit 1
    ;;
  *) exit 1 ;;
esac
`
    );
    chmodSync(fakeGh, 0o755);
    const expectedSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8'
    }).trim();
    const execute = (
      scenario: 'missing-success' | 'ambiguous' | 'transport'
    ) => {
      writeFileSync(output, '');
      let succeeded = true;
      try {
        execFileSync('bash', ['-c', composition?.run ?? 'exit 1'], {
          cwd: root,
          env: {
            ...process.env,
            CANDIDATE_EVIDENCE_MODE: 'legacy-whole-train',
            DEPLOY_LAYERS: '[]',
            DEPLOY_UNITS: '["api"]',
            EXPECTED_SHA: expectedSha,
            GH_CASE: scenario,
            GITHUB_OUTPUT: output,
            GITHUB_REPOSITORY: '6529/backend',
            PATH: `${fixture}:${process.env.PATH ?? ''}`,
            SOURCE_REF: 'feature/missing',
            TRAIN_ID: 'train-id'
          },
          stdio: 'pipe'
        });
      } catch {
        succeeded = false;
      }
      return {
        succeeded,
        output: readFileSync(output, 'utf8')
      };
    };
    try {
      expect(execute('missing-success')).toMatchObject({
        succeeded: true,
        output: expect.stringContaining('legacy_source_ref_bridge=true')
      });
      expect(execute('ambiguous')).toMatchObject({
        succeeded: false,
        output: expect.stringContaining(
          'failure_phase=legacy_source_ref_unbound'
        )
      });
      const transport = execute('transport');
      expect(transport).toMatchObject({
        succeeded: false,
        output: expect.stringContaining(
          'failure_phase=legacy_source_ref_transport'
        )
      });
      expect(transport.output).toContain('failure_class=INFRASTRUCTURE');
      expect(transport.output).toContain('retryable=true');
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

  it('reports a missing or cancelled candidate runner as retryable infrastructure', () => {
    const parsed = YAML.parse(preflight) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const terminal = parsed.jobs.report.steps.find(
      ({ name }) => name === 'Report structured terminal result'
    );
    const fixture = mkdtempSync(path.join(tmpdir(), 'rb2-terminal-report-'));
    const capture = path.join(fixture, 'payload.json');
    const output = path.join(fixture, 'github-output');
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
    const execute = (
      preflightResult: 'failure' | 'cancelled',
      evidenceOutcome: '' | 'failure'
    ) => {
      rmSync(capture, { force: true });
      writeFileSync(output, '');
      execFileSync('bash', ['-c', terminal?.run ?? 'exit 1'], {
        cwd: fixture,
        env: {
          ...process.env,
          ARTIFACT_BYTES_REUSED: '',
          CAPTURE_PAYLOAD: capture,
          COMPOSITION_FAILURE_CLASS: '',
          COMPOSITION_FAILURE_PHASE: '',
          COMPOSITION_OUTCOME: '',
          COMPOSITION_RETRYABLE: '',
          DOWNLOAD_OUTCOME: 'skipped',
          EVIDENCE_FAILURE_CLASS:
            evidenceOutcome === 'failure' ? 'CANDIDATE' : '',
          EVIDENCE_OUTCOME: evidenceOutcome,
          GITHUB_RUN_ID: '12345',
          GITHUB_OUTPUT: output,
          OPERATION_KEY: 'rb2:train-id:prepare:backend:a1',
          PACKAGE_FAILURE_CLASS: '',
          PACKAGE_OUTCOME: '',
          PATH: `${fixture}:${process.env.PATH ?? ''}`,
          PREFLIGHT_RESULT: preflightResult,
          RELEASE_BUS_API_URL: 'https://release-bus.invalid',
          RELEASE_BUS_WORKFLOW_AUTH_TOKEN: 'test-token',
          ROOT_INSTALL_FAILURE_CLASS: '',
          ROOT_INSTALL_OUTCOME: '',
          SOURCE_OUTCOME: '',
          TRAIN_ID: 'train-id',
          UPLOAD_OUTCOME: ''
        }
      });
      return JSON.parse(readFileSync(capture, 'utf8')) as {
        failure_class: string;
        failure_phase: string;
        retryable: boolean;
      };
    };
    try {
      expect(execute('cancelled', '')).toMatchObject({
        failure_class: 'INFRASTRUCTURE',
        failure_phase: 'preflight_runner',
        retryable: true
      });
      expect(execute('failure', 'failure')).toMatchObject({
        failure_class: 'CANDIDATE',
        failure_phase: 'ci_evidence',
        retryable: false
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('reports trusted artifact corruption instead of losing the terminal callback', () => {
    const parsed = YAML.parse(preflight) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const terminal = parsed.jobs.report.steps.find(
      ({ name }) => name === 'Report structured terminal result'
    );
    const fixture = mkdtempSync(path.join(tmpdir(), 'rb2-corrupt-report-'));
    const capture = path.join(fixture, 'payload.json');
    const output = path.join(fixture, 'github-output');
    const fakeCurl = path.join(fixture, 'curl');
    mkdirSync(path.join(fixture, 'release-bus-artifact'));
    writeFileSync(
      path.join(fixture, 'release-bus-artifact/manifest.json'),
      '{not-valid-json'
    );
    writeFileSync(
      path.join(fixture, 'release-bus-artifact/SHA256SUMS'),
      `${'0'.repeat(64)}  manifest.json\n`
    );
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
    writeFileSync(output, '');
    try {
      execFileSync('bash', ['-c', terminal?.run ?? 'exit 1'], {
        cwd: fixture,
        env: {
          ...process.env,
          ARTIFACT_BYTES_REUSED: 'false',
          CAPTURE_PAYLOAD: capture,
          COMPOSITION_FAILURE_CLASS: 'CANDIDATE',
          COMPOSITION_FAILURE_PHASE: 'source_composition',
          COMPOSITION_OUTCOME: 'success',
          COMPOSITION_RETRYABLE: 'false',
          DOWNLOAD_OUTCOME: 'success',
          EVIDENCE_FAILURE_CLASS: 'CANDIDATE',
          EVIDENCE_OUTCOME: 'success',
          GITHUB_RUN_ID: '12345',
          GITHUB_OUTPUT: output,
          OPERATION_KEY: 'rb2:train-id:prepare:backend:a1',
          PACKAGE_FAILURE_CLASS: 'CANDIDATE',
          PACKAGE_OUTCOME: 'success',
          PATH: `${fixture}:${process.env.PATH ?? ''}`,
          PREFLIGHT_RESULT: 'success',
          RELEASE_BUS_API_URL: 'https://release-bus.invalid',
          RELEASE_BUS_WORKFLOW_AUTH_TOKEN: 'test-token',
          ROOT_INSTALL_FAILURE_CLASS: 'CANDIDATE',
          ROOT_INSTALL_OUTCOME: 'success',
          SOURCE_OUTCOME: 'success',
          TRAIN_ID: 'train-id',
          UPLOAD_OUTCOME: 'success'
        },
        stdio: 'pipe'
      });
      expect(JSON.parse(readFileSync(capture, 'utf8'))).toMatchObject({
        status: 'FAILED',
        failure_class: 'INFRASTRUCTURE',
        failure_phase: 'artifact_integrity',
        retryable: true,
        summary: null
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('self-clears the package marker and gives concurrent infrastructure evidence deterministic precedence', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'rb2-package-marker-'));
    const marker = path.join(fixture, 'failure-class');
    const result = execFileSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        `
          import fs from 'node:fs/promises';
          import {
            clearInfrastructureFailureMarker as clear,
            hasUnmistakableTransportFailure as transport,
            markInfrastructureFailure as mark
          } from './scripts/release-bus-package-backend.mjs';
          const marker = process.argv[1];
          await fs.writeFile(marker, 'CANDIDATE\\n');
          await clear(marker);
          const cleared = await fs.access(marker).then(() => false, () => true);
          await Promise.all(Array.from({length: 8}, () => mark(marker)));
          const value = await fs.readFile(marker, 'utf8');
          process.stdout.write(JSON.stringify({
            cleared,
            value,
            transportCode: transport('npm error ETIMEDOUT'),
            transportStatus: transport('npm ERR! 503 Service Unavailable'),
            candidateNumber: transport('package status 503 is invalid'),
            hardHttp: transport('npm error 404 Not Found')
          }));
        `,
        marker
      ],
      { cwd: root, encoding: 'utf8' }
    );
    try {
      expect(JSON.parse(result)).toEqual({
        cleared: true,
        value: 'INFRASTRUCTURE\n',
        transportCode: true,
        transportStatus: true,
        candidateNumber: false,
        hardHttp: false
      });
      expect(read('scripts/release-bus-package-backend.mjs')).toContain(
        "child.once('close'"
      );
      expect(read('scripts/release-bus-package-backend.mjs')).not.toContain(
        "child.once('exit'"
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('keeps portable legacy packaging environment-agnostic and validates exact candidate evidence modes', () => {
    const result = execFileSync(
      'node',
      [
        '--input-type=module',
        '--eval',
        `
          import {
            concreteDeployEnvironment as concrete,
            validateCandidateEvidence as validate
          } from './scripts/release-bus-package-backend.mjs';
          const sourceSha = '${'a'.repeat(40)}';
          validate({
            aggregateCandidateEvidenceDigest: '',
            candidateEvidenceMode: 'legacy-whole-train',
            contractVersion: 'legacy-v2',
            reuseArtifactDigest: '',
            reuseArtifactName: '',
            reuseArtifactRunId: '',
            sourceSha
          });
          validate({
            aggregateCandidateEvidenceDigest: '',
            candidateEvidenceMode: 'strict-single',
            contractVersion: 'environment-bound-v3',
            reuseArtifactDigest: '${'b'.repeat(64)}',
            reuseArtifactName: \`release-bus-v2-pr-\${sourceSha}\`,
            reuseArtifactRunId: '123',
            sourceSha
          });
          validate({
            aggregateCandidateEvidenceDigest: '${'c'.repeat(64)}',
            candidateEvidenceMode: 'strict-aggregate',
            contractVersion: 'environment-bound-v3',
            reuseArtifactDigest: '',
            reuseArtifactName: '',
            reuseArtifactRunId: '',
            sourceSha
          });
          let incompleteRejected = false;
          try {
            validate({
              aggregateCandidateEvidenceDigest: '',
              candidateEvidenceMode: 'strict-single',
              contractVersion: 'environment-bound-v3',
              reuseArtifactDigest: '',
              reuseArtifactName: '',
              reuseArtifactRunId: '',
              sourceSha
            });
          } catch {
            incompleteRejected = true;
          }
          process.stdout.write(JSON.stringify({
            portable: concrete('portable'),
            production: concrete('production'),
            staging: concrete('staging'),
            incompleteRejected
          }));
        `
      ],
      { cwd: root, encoding: 'utf8' }
    );

    expect(JSON.parse(result)).toEqual({
      portable: null,
      production: 'prod',
      staging: 'staging',
      incompleteRejected: true
    });
  });

  it('binds policy bytes to the exact commit and rejects mutable action tags', () => {
    const fixture = mkdtempSync(path.join(tmpdir(), 'rb2-policy-'));
    try {
      mkdirSync(path.join(fixture, '.github/workflows'), { recursive: true });
      writeFileSync(
        path.join(fixture, '.github/workflows/ci.yml'),
        'steps:\n  - { uses: actions/checkout@v6 }\n'
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
        'steps:\n  - { uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 }\n'
      );
      expect(() =>
        policy.buildPolicyBundle({
          root: fixture,
          filePaths: ['.github/workflows/ci.yml'],
          packagePolicies: {},
          runtimePins: {},
          nodePinWorkflows: [],
          pinnedActionWorkflows: ['.github/workflows/ci.yml']
        })
      ).not.toThrow();
      writeFileSync(
        path.join(fixture, '.github/workflows/ci.yml'),
        'steps:\n  - { uses: 42 }\n'
      );
      expect(() =>
        policy.buildPolicyBundle({
          root: fixture,
          filePaths: ['.github/workflows/ci.yml'],
          packagePolicies: {},
          runtimePins: {},
          nodePinWorkflows: [],
          pinnedActionWorkflows: ['.github/workflows/ci.yml']
        })
      ).toThrow('malformed uses');
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
    expect(deploy).toContain(
      'test -z "$INPUT_ARTIFACT_TRAIN_ID" -o "$INPUT_ARTIFACT_TRAIN_ID" = "$INPUT_TRAIN_ID"'
    );
    expect(deploy).toContain('.schema_version == 2');
    expect(deploy).toContain('artifact_contract:"legacy-v2"');
    expect(deploy).toContain('environment:"portable"');
    expect(deploy).toContain('deployment_environment:$deployment_environment');
  });

  it('executes the exact terminal summary projection from preflight', () => {
    const marker = `summary="$(jq -ce --arg digest "$digest" '`;
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
    expect(deploy).toContain(
      'PACKAGE_DIGEST: ${{ steps.release_bus_artifact.outputs.package_digest }}'
    );
    expect(deploy).toContain('--arg package_digest "$PACKAGE_DIGEST"');
    expect(deploy).not.toContain(
      '--arg package_digest "${{ steps.release_bus_artifact.outputs.package_digest }}"'
    );
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
          /artifact_contract_version|\.\.\.(?:artifactBinding|artifactSource\.binding)/
        );
        expect(inputs).toMatch(
          /artifact_environment|\.\.\.(?:artifactBinding|artifactSource\.binding)/
        );
      }
    }
    expect(reconciler).toContain(
      'export function preparedArtifactDeployBinding('
    );
    expect(reconciler).toContain(
      'Production deployment requires a freshly prepared same-train artifact'
    );
    expect(reconciler).toContain(
      "train.lane === 'PRODUCTION' ? 'prod' : 'staging'"
    );
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
      rollout: {
        phases: string[];
        producer_cutover: {
          backend_only: boolean;
          dag: string[][];
          release_bus_last: boolean;
          require_old_trust_drain: boolean;
        };
      };
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
    expect(contract.critical_path.normal_preflight_jobs).toEqual([
      'authorize',
      'preflight',
      'report'
    ]);
    expect(contract.critical_path.normal_preflight_steps).toHaveLength(14);
    expect(
      contract.targets
        .healthy_one_unit_backend_production_minutes_excluding_runner_queue
    ).toEqual({ minimum: 6, maximum: 10 });
    expect(contract.rollout.phases).toEqual([
      'api-trust-compatibility',
      'legacy-consumer-compatibility',
      'v3-evidence-producer-and-performance'
    ]);
    expect(contract.rollout.producer_cutover).toEqual({
      backend_only: true,
      dag: [['api'], ['releaseBus']],
      release_bus_last: true,
      require_old_trust_drain: true
    });
  });
});
