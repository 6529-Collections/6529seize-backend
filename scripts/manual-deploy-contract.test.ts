import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const workflowPath = path.join(process.cwd(), '.github/workflows/deploy.yml');
const ghdeployPath = path.join(process.cwd(), 'bin/ghdeploy');

function extractStepScript(stepName: string): string {
  const workflow = readFileSync(workflowPath, 'utf8');
  const marker = `      - name: ${stepName}\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Workflow step ${stepName} was not found`);
  const next = workflow.indexOf('\n      - name:', start + marker.length);
  const step = workflow.slice(start, next < 0 ? workflow.length : next);
  const runMarker = '        run: |\n';
  const runStart = step.indexOf(runMarker);
  if (runStart < 0) {
    throw new Error(`Workflow step ${stepName} has no shell script`);
  }
  return step
    .slice(runStart + runMarker.length)
    .split('\n')
    .map((line) => line.replace(/^ {10}/, ''))
    .join('\n');
}

const dispatchValidationScript = () =>
  extractStepScript('Validate dispatch inputs before using credentials');
const productionValidationScript = () =>
  extractStepScript('Check production release-note preconditions');

const baseDispatchEnv = {
  INPUT_ENVIRONMENT: 'staging',
  INPUT_SERVICE: 'api',
  INPUT_TRAIN_ID: '',
  INPUT_RELEASE_CONTRIBUTORS: '[]',
  INPUT_TRAIN_REVISION: '',
  INPUT_OPERATION_KEY: '',
  INPUT_EXPECTED_SHA: '',
  INPUT_ARTIFACT_RUN_ID: '',
  INPUT_ARTIFACT_TRAIN_ID: '',
  INPUT_ARTIFACT_DIGEST: '',
  INPUT_ARTIFACT_ENVIRONMENT: '',
  INPUT_ARTIFACT_CONTRACT_VERSION: 'legacy-v2',
  INPUT_EMERGENCY_API_BOOTSTRAP: 'false',
  INPUT_EMERGENCY_API_BOOTSTRAP_EXPECTED_SHA: '',
  INPUT_EMERGENCY_API_BOOTSTRAP_REASON: '',
  INPUT_RELEASE_PULL_REQUEST: '42',
  INPUT_RELEASE_NOTE_PUBLISH: 'false',
  INPUT_RELEASE_GROUP_SERVICES: 'api',
  INPUT_RELEASE_NOTE_GROUPS: '',
  INPUT_RELEASE_NOTE_OPT_OUT: 'false'
};

function runShell(script: string, overrides: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...baseDispatchEnv,
      ...overrides
    }
  });
}

function dispatchArguments({
  environment,
  pullRequest,
  publish,
  optOut,
  groupServices
}: {
  readonly environment: 'staging' | 'prod';
  readonly pullRequest: string;
  readonly publish: 'true' | 'false';
  readonly optOut: 'true' | 'false';
  readonly groupServices: string;
}): string {
  const script = [
    'source "$1"',
    'gh() { printf "%s\\n" "$@"; }',
    'dispatch_deploy api "$2" main origin/main "$3" "$4" "$5" "$6"'
  ].join('\n');
  return execFileSync(
    'bash',
    [
      '-c',
      script,
      'ghdeploy-test',
      ghdeployPath,
      environment,
      pullRequest,
      publish,
      optOut,
      groupServices
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GHDEPLOY_SOURCE_ONLY: 'true'
      }
    }
  );
}

function selectReleaseGroupServices({
  currentService,
  selectedServices
}: {
  readonly currentService: string;
  readonly selectedServices: readonly string[];
}) {
  const script = [
    'source "$1"',
    'BATCH_SERVICES=(api worker releaseBus)',
    `node() { printf '%s\\n' ${selectedServices.map((service) => `'${service}'`).join(' ')}; }`,
    'choose_release_group_services "$2" main 42'
  ].join('\n');
  return spawnSync(
    'bash',
    ['-c', script, 'ghdeploy-test', ghdeployPath, currentService],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GHDEPLOY_SOURCE_ONLY: 'true'
      }
    }
  );
}

describe('manual backend deployment contract', () => {
  it.each(['staging', 'prod'] as const)(
    'accepts a normal PR-backed %s dispatch',
    (environment) => {
      const dispatch = runShell(dispatchValidationScript(), {
        INPUT_ENVIRONMENT: environment
      });
      expect(dispatch.status).toBe(0);

      if (environment === 'prod') {
        const production = runShell(productionValidationScript(), {
          RELEASE_PULL_REQUEST: '42',
          RELEASE_GROUP_SERVICES: 'api',
          RELEASE_NOTE_GROUPS: '',
          RELEASE_NOTE_PUBLISH: 'false',
          RELEASE_NOTE_OPT_OUT: 'false',
          RELEASE_SERVICE: 'api'
        });
        expect(production.status).toBe(0);
      }
    }
  );

  it.each(['staging', 'prod'] as const)(
    'accepts an explicit no-PR %s opt-out',
    (environment) => {
      const overrides = {
        INPUT_ENVIRONMENT: environment,
        INPUT_RELEASE_PULL_REQUEST: '',
        INPUT_RELEASE_NOTE_OPT_OUT: 'true',
        INPUT_RELEASE_GROUP_SERVICES: ''
      };
      expect(runShell(dispatchValidationScript(), overrides).status).toBe(0);

      if (environment === 'prod') {
        const production = runShell(productionValidationScript(), {
          ...overrides,
          RELEASE_PULL_REQUEST: '',
          RELEASE_GROUP_SERVICES: '',
          RELEASE_NOTE_GROUPS: '',
          RELEASE_NOTE_PUBLISH: 'false',
          RELEASE_NOTE_OPT_OUT: 'true',
          RELEASE_SERVICE: 'api'
        });
        expect(production.status).toBe(0);
      }
    }
  );

  it.each([
    [
      'an empty PR without opt-out',
      {
        INPUT_RELEASE_PULL_REQUEST: '',
        INPUT_RELEASE_NOTE_OPT_OUT: 'false'
      }
    ],
    [
      'a PR with opt-out',
      {
        INPUT_RELEASE_PULL_REQUEST: '42',
        INPUT_RELEASE_NOTE_OPT_OUT: 'true',
        INPUT_RELEASE_GROUP_SERVICES: ''
      }
    ],
    [
      'publication with opt-out',
      {
        INPUT_RELEASE_PULL_REQUEST: '',
        INPUT_RELEASE_NOTE_OPT_OUT: 'true',
        INPUT_RELEASE_NOTE_PUBLISH: 'true',
        INPUT_RELEASE_GROUP_SERVICES: ''
      }
    ],
    [
      'contributors with opt-out',
      {
        INPUT_RELEASE_PULL_REQUEST: '',
        INPUT_RELEASE_NOTE_OPT_OUT: 'true',
        INPUT_RELEASE_CONTRIBUTORS: '["unverified"]',
        INPUT_RELEASE_GROUP_SERVICES: ''
      }
    ],
    [
      'manual structured release-note groups',
      {
        INPUT_RELEASE_NOTE_GROUPS:
          '[{"release_group_id":"pr-42","release_group_services":["api"],"pull_request_number":42,"publish_release_note":false}]'
      }
    ],
    [
      'a PR-backed operation without an explicit service plan',
      {
        INPUT_RELEASE_GROUP_SERVICES: ''
      }
    ],
    [
      'a service plan that omits the deployed service',
      {
        INPUT_RELEASE_GROUP_SERVICES: 'aggregatedActivityLoop'
      }
    ],
    [
      'a staging publication request',
      {
        INPUT_ENVIRONMENT: 'staging',
        INPUT_RELEASE_NOTE_PUBLISH: 'true'
      }
    ]
  ])('rejects %s', (_scenario, overrides) => {
    expect(runShell(dispatchValidationScript(), overrides).status).not.toBe(0);
  });

  it('preserves strict Release Bus dispatch validation', () => {
    const result = runShell(dispatchValidationScript(), {
      INPUT_TRAIN_ID: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
      INPUT_RELEASE_CONTRIBUTORS: '["GelatoGenesis"]',
      INPUT_TRAIN_REVISION: '1',
      INPUT_OPERATION_KEY:
        'rb2:a7d3433d-e145-4578-bc78-e96fbd34f591:deploy:staging:backend:api:a1',
      INPUT_EXPECTED_SHA: 'a'.repeat(40),
      INPUT_ARTIFACT_RUN_ID: '123',
      INPUT_ARTIFACT_TRAIN_ID: 'a7d3433d-e145-4578-bc78-e96fbd34f591',
      INPUT_ARTIFACT_DIGEST: 'b'.repeat(64),
      INPUT_ARTIFACT_ENVIRONMENT: 'staging',
      INPUT_ARTIFACT_CONTRACT_VERSION: 'environment-bound-v3',
      INPUT_RELEASE_PULL_REQUEST: '',
      INPUT_RELEASE_NOTE_OPT_OUT: 'false'
    });

    expect(result.status).toBe(0);
  });

  it.each([
    {
      environment: 'staging' as const,
      pullRequest: '42',
      publish: 'false' as const,
      optOut: 'false' as const,
      groupServices: 'api'
    },
    {
      environment: 'prod' as const,
      pullRequest: '42',
      publish: 'true' as const,
      optOut: 'false' as const,
      groupServices: 'api'
    }
  ])('makes ghdeploy pass PR-backed $environment metadata', (input) => {
    const output = dispatchArguments(input);
    expect(output).toContain('release_pull_request=42');
    expect(output).toContain(`release_note_publish=${input.publish}`);
    expect(output).toContain('release_note_opt_out=false');
    expect(output).toContain('release_group_services=api');
  });

  it('makes ghdeploy pass explicit safe no-PR metadata', () => {
    const output = dispatchArguments({
      environment: 'prod',
      pullRequest: '',
      publish: 'false',
      optOut: 'true',
      groupServices: ''
    });
    expect(output).toContain('release_pull_request=');
    expect(output).toContain('release_note_publish=false');
    expect(output).toContain('release_note_opt_out=true');
    expect(output).toContain('release_group_services=');
  });

  it('makes every manual production service use the same complete canonical group', () => {
    const apiSelection = selectReleaseGroupServices({
      currentService: 'api',
      selectedServices: ['worker', 'api']
    });
    const workerSelection = selectReleaseGroupServices({
      currentService: 'worker',
      selectedServices: ['api', 'worker']
    });

    expect(apiSelection).toMatchObject({ status: 0, stdout: 'api,worker\n' });
    expect(workerSelection).toMatchObject({
      status: 0,
      stdout: 'api,worker\n'
    });
  });

  it('rejects a production release group that omits the deployed service', () => {
    const selection = selectReleaseGroupServices({
      currentService: 'worker',
      selectedServices: ['api']
    });

    expect(selection.status).not.toBe(0);
    expect(selection.stderr).toContain(
      'Release group must include the service being deployed: worker'
    );
  });
});
