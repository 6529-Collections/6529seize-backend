import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

const extractInlineJqFilter = (
  script: string,
  marker: string,
  inputVariable = 'response_file'
): string => {
  const markerIndex = script.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing jq filter marker: ${marker}`);
  const filterStart = script.indexOf('\'type == "object" and', markerIndex);
  const filterSuffix = script.slice(filterStart);
  const filterEndMatch = new RegExp(`'\\s+"\\$${inputVariable}"`).exec(
    filterSuffix
  );
  if (filterStart < 0 || !filterEndMatch)
    throw new Error(`Missing inline jq response filter after: ${marker}`);
  return filterSuffix.slice(1, filterEndMatch.index);
};

const runDeploymentSelectionFilter = (
  filter: string,
  packagePath: string
): void => {
  execFileSync(
    'jq',
    [
      '-e',
      '--arg',
      'service',
      'api',
      '--arg',
      'target_sha',
      'a'.repeat(40),
      '--arg',
      'workflow_run_id',
      '123',
      '--argjson',
      'workflow_run_attempt',
      '1',
      filter
    ],
    {
      cwd: root,
      input: JSON.stringify({
        artifact_kind: 'lambda-zip',
        environment: 'prod',
        package_bytes: 1024,
        package_digest: 'b'.repeat(64),
        package_path: packagePath,
        repository: 'backend',
        schema_version: 1,
        selection_type: 'backend-production-deployment-selection-v1',
        service: 'api',
        target_sha: 'a'.repeat(40),
        workflow_run_attempt: 1,
        workflow_run_id: '123'
      }),
      stdio: 'pipe'
    }
  );
};

const validAuthorityResponse = {
  authorized: true,
  bound: true,
  control_epoch: { all: 69, mode: 'PRODUCTION', production: 43 },
  controller_identity: 'backend-production-workflow',
  environment: 'prod',
  hard_expires_at: 20_000,
  lease_expires_at: 10_000,
  lock_row_version: 343,
  operation_id: 'backend-prod-api-123',
  repository: 'backend',
  reused: false,
  selection_digest: null as string | null,
  service: 'api',
  status: 'BOUND',
  target_sha: 'a'.repeat(40),
  workflow_run_attempt: 1,
  workflow_run_id: '123'
};

const runAuthorityResponseFilter = (
  filter: string,
  response: typeof validAuthorityResponse,
  selectionDigest?: string
) => {
  const args = [
    '-e',
    '--arg',
    'operation_id',
    response.operation_id,
    '--arg',
    'controller_identity',
    response.controller_identity,
    '--arg',
    'service',
    response.service,
    '--arg',
    'target_sha',
    response.target_sha,
    '--arg',
    'workflow_run_id',
    response.workflow_run_id,
    '--argjson',
    'workflow_run_attempt',
    String(response.workflow_run_attempt)
  ];
  if (selectionDigest) args.push('--arg', 'selection_digest', selectionDigest);
  args.push(filter);
  execFileSync('jq', args, {
    cwd: root,
    input: JSON.stringify(response),
    stdio: 'pipe'
  });
};

describe('backend production authority workflow integration', () => {
  it('keeps the generated workflow deterministic and acquires before candidate code', () => {
    const workflowPath = '.github/workflows/deploy.yml';
    const before = read(workflowPath);
    execFileSync('node', ['scripts/generate-deploy-config.mjs'], {
      cwd: root,
      stdio: 'pipe'
    });
    expect(read(workflowPath)).toBe(before);

    const parsed = YAML.parse(before) as {
      'run-name': string;
      jobs: Record<
        string,
        {
          steps: Array<{
            name?: string;
            if?: string;
            run?: string;
            uses?: string;
            with?: Record<string, string | number | boolean>;
          }>;
        }
      >;
    };
    const steps = parsed.jobs['build-and-deploy'].steps;
    const index = (name: string) =>
      steps.findIndex((step) => step.name === name);
    const validation = index(
      'Validate dispatch inputs before using credentials'
    );
    const acquire = index('Authorize exact deployment operation');
    const checkout = index('Checkout');
    const aws = index('Configure AWS credentials');
    const reauthorize = index(
      'Reauthorize exact backend production selection immediately before cloud credentials'
    );
    const emergencyBootstrapRevalidation = index(
      'Revalidate emergency API bootstrap immediately before cloud credentials'
    );
    const evidence = index('Create backend production authority evidence');
    const evidenceUpload = index(
      'Upload backend production authority evidence'
    );
    const emergencyEvidence = index('Create emergency API bootstrap evidence');
    const emergencyEvidenceUpload = index(
      'Upload emergency API bootstrap evidence'
    );
    const immutableLambdaVerification = index('Verify immutable Lambda code');
    const exactApiHealthVerification = index(
      'Verify API health and exact version'
    );
    const inlineFailure = index(
      'Fail backend production authority after workflow failure'
    );
    const failureState = index(
      'Preserve bounded backend production authority failure evidence'
    );
    const failureStateUpload = index(
      'Upload backend production authority failure state'
    );
    const successNotification = index('Notify about success');
    const successWaveNotification = index('Notify CI wave about success');

    expect(validation).toBe(0);
    expect(acquire).toBe(1);
    expect(checkout).toBeGreaterThan(acquire);
    expect(reauthorize).toBeLessThan(emergencyBootstrapRevalidation);
    expect(emergencyBootstrapRevalidation).toBe(aws - 1);
    expect(evidence).toBeGreaterThan(aws);
    expect(evidenceUpload).toBe(evidence + 1);
    expect(emergencyEvidence).toBe(evidenceUpload + 1);
    expect(emergencyEvidenceUpload).toBe(emergencyEvidence + 1);
    expect(immutableLambdaVerification).toBeGreaterThan(aws);
    expect(exactApiHealthVerification).toBeGreaterThan(
      immutableLambdaVerification
    );
    expect(inlineFailure).toBe(-1);
    expect(failureState).toBeGreaterThan(successNotification);
    expect(failureState).toBeGreaterThan(successWaveNotification);
    expect(failureStateUpload).toBe(failureState + 1);
    expect(parsed['run-name']).toContain("format('backend-prod-{0}-{1}'");

    const acquireScript = steps[acquire]?.run ?? '';
    expect(acquireScript).toContain(
      'release-bus-v2/production-authority/acquire-bind'
    );
    expect(acquireScript).toContain(
      'operation_id="backend-prod-$INPUT_SERVICE-$GITHUB_RUN_ID"'
    );
    expect(acquireScript).toContain('selection_digest:null');
    expect(acquireScript).toContain(
      'if [ "$production_authority" = true ] && [ "$http_status" != 200 ]'
    );
    const acquireResponseValidation = acquireScript.indexOf(
      '(keys_unsorted | sort) == ['
    );
    const authorityStateWrite = acquireScript.indexOf(
      `printf '%s\\n' "$state_json" > "$authority_state_file"`
    );
    const canonicalAuthorityResponseKeys =
      '"authorized", "bound", "control_epoch", "controller_identity"';
    expect(acquireResponseValidation).toBeGreaterThan(-1);
    expect(authorityStateWrite).toBeLessThan(acquireResponseValidation);
    expect(acquireScript).toContain(canonicalAuthorityResponseKeys);
    expect(acquireScript).not.toContain(
      '"authorized", "bound", "controller_identity", "control_epoch"'
    );
    expect(acquireScript).not.toContain('authority_state_json=');
    expect(acquireScript).not.toContain('--retry');
    expect(acquireScript).toContain('--arg service "$INPUT_SERVICE"');
    expect(acquireScript).toContain(
      '.name == ("Deploy " + $service + " to prod [backend-prod-" +'
    );
    expect(acquireScript).toContain('$service + "-" + $run_id + "]")');
    expect(acquireScript).toContain('.display_title == .name');
    expect(acquireScript).not.toContain(
      '.name == "Deploy api to prod [manual]"'
    );
    expect(acquireScript).not.toContain('--arg title');
    expect(steps[acquire]?.uses).toBeUndefined();
    expect(steps[acquire]?.if).toBeUndefined();

    const emergencyRevalidationScript =
      steps[emergencyBootstrapRevalidation]?.run ?? '';
    expect(emergencyRevalidationScript).toContain('/usr/bin/env -i');
    expect(emergencyRevalidationScript).toContain(
      'INPUT_SERVICE="$INPUT_SERVICE"'
    );

    const selectionScript = steps[reauthorize]?.run ?? '';
    expect(steps[reauthorize]?.if).toContain(
      "steps.deployment_authorization.outputs.emergency_compatibility_fallback != 'true'"
    );
    expect(selectionScript).toContain(
      'selection_type:"backend-production-deployment-selection-v1"'
    );
    expect(selectionScript).toContain('/production-authority/reauthorize');
    expect(selectionScript).toContain(canonicalAuthorityResponseKeys);
    expect(selectionScript).not.toContain('lease_token');

    const evidenceScript = steps[evidence]?.run ?? '';
    expect(evidenceScript).toContain(
      'evidence_type:"backend-production-authority-v1"'
    );
    expect(evidenceScript).toContain('deployment_result:"success"');
    expect(evidenceScript).not.toContain('lease_token');
    expect(steps[evidenceUpload]).toMatchObject({
      uses: expect.stringMatching(
        /^actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02$/
      ),
      with: {
        name: 'backend-production-authority-${{ github.run_id }}'
      }
    });
    expect(JSON.stringify(steps[evidenceUpload])).toContain(
      'backend-production-authority-${{ github.run_id }}'
    );
    expect(JSON.stringify(steps[evidenceUpload])).toContain(
      '${{ runner.temp }}/backend-production-authority-evidence.json'
    );

    const emergencyEvidenceScript = steps[emergencyEvidence]?.run ?? '';
    expect(emergencyEvidenceScript).toContain(
      'evidence_type:"backend-emergency-api-bootstrap-v1"'
    );
    expect(emergencyEvidenceScript).toContain(
      'authorization_mode:"workflow-identity-self-bootstrap"'
    );
    expect(emergencyEvidenceScript).toContain(
      'test "$INPUT_EXPECTED_SHA" = "$GITHUB_SHA"'
    );
    expect(emergencyEvidenceScript).toContain(
      'test "$INPUT_EMERGENCY_API_BOOTSTRAP_EXPECTED_SHA" = "$GITHUB_SHA"'
    );
    expect(steps[immutableLambdaVerification]?.if).toContain(
      "steps.deployment_authorization.outputs.emergency_compatibility_fallback == 'true'"
    );
    expect(steps[exactApiHealthVerification]?.if).toContain(
      "steps.deployment_authorization.outputs.emergency_compatibility_fallback == 'true'"
    );
    expect(steps[exactApiHealthVerification]?.run).toContain(
      'test "$INPUT_EMERGENCY_API_BOOTSTRAP_EXPECTED_SHA" = "$INPUT_EXPECTED_SHA"'
    );
    expect(steps[emergencyEvidenceUpload]).toMatchObject({
      uses: expect.stringMatching(
        /^actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02$/
      ),
      with: {
        name: 'backend-emergency-api-bootstrap-${{ github.run_id }}',
        'retention-days': 30
      }
    });

    expect(before).not.toContain('/production-authority/fail');
    expect(before).not.toContain(
      'Fail backend production authority after workflow failure'
    );
    expect(JSON.stringify(steps[failureStateUpload])).toContain(
      'backend-production-authority-failure-${{ github.run_id }}'
    );
    expect(before).not.toContain('/production-authority/complete');
  });

  it('executes both inline authority response filters with object-scoped expiry comparisons', () => {
    const parsed = YAML.parse(read('.github/workflows/deploy.yml')) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const steps = parsed.jobs['build-and-deploy'].steps;
    const acquireScript =
      steps.find(({ name }) => name === 'Authorize exact deployment operation')
        ?.run ?? '';
    const reauthorizeScript =
      steps.find(
        ({ name }) =>
          name ===
          'Reauthorize exact backend production selection immediately before cloud credentials'
      )?.run ?? '';
    const acquireFilter = extractInlineJqFilter(
      acquireScript,
      'if [ "$http_status" = 200 ] && [ "$production_authority" = true ]'
    );
    const reauthorizeFilter = extractInlineJqFilter(
      reauthorizeScript,
      'test "$http_status" = 200 ||'
    );
    const selectionDigest = 'b'.repeat(64);

    expect(acquireFilter).toContain('(.hard_expires_at > .lease_expires_at)');
    expect(reauthorizeFilter).toContain(
      '(.hard_expires_at > .lease_expires_at)'
    );
    expect(acquireFilter).not.toContain(
      '.hard_expires_at | type == "number" and . > .lease_expires_at'
    );
    expect(() =>
      runAuthorityResponseFilter(acquireFilter, validAuthorityResponse)
    ).not.toThrow();
    expect(() =>
      runAuthorityResponseFilter(
        reauthorizeFilter,
        {
          ...validAuthorityResponse,
          selection_digest: selectionDigest
        },
        selectionDigest
      )
    ).not.toThrow();

    for (const invalidHardExpiry of [10_000, '20000']) {
      expect(() =>
        runAuthorityResponseFilter(acquireFilter, {
          ...validAuthorityResponse,
          hard_expires_at: invalidHardExpiry as number
        })
      ).toThrow();
    }
  });

  it('executes the generated deployment-selection filter with a literal zip suffix', () => {
    const parsed = YAML.parse(read('.github/workflows/deploy.yml')) as {
      jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
    };
    const evidenceScript =
      parsed.jobs['build-and-deploy'].steps.find(
        ({ name }) => name === 'Create backend production authority evidence'
      )?.run ?? '';
    const selectionFilter = extractInlineJqFilter(
      evidenceScript,
      'selection_json="$(jq -cS',
      'selection_file'
    );

    expect(selectionFilter).toContain('dist/index\\\\.zip$');
    expect(() =>
      runDeploymentSelectionFilter(
        selectionFilter,
        'src/api-serverless/dist/index.zip'
      )
    ).not.toThrow();
    expect(() =>
      runDeploymentSelectionFilter(
        selectionFilter,
        'src/tdhLoop/dist/index.zip'
      )
    ).not.toThrow();
    for (const invalidPath of [
      'src/api-serverless/dist/indexXzip',
      'src/api-serverless/dist/indexAzip',
      'src/api-serverless/dist/index.zipx',
      'src/api-serverless/dist/index\\.zip',
      'x/src/api-serverless/dist/index.zip',
      'src/api-serverless/subdir/dist/index.zip'
    ]) {
      expect(() =>
        runDeploymentSelectionFilter(selectionFilter, invalidPath)
      ).toThrow();
    }
  });

  it.each([
    ['Deploy api to prod [backend-prod-api-123]', true],
    ['Deploy api to prod [backend-prod-api-124]', false],
    ['Deploy api to prod [backend-prod-other-123]', false],
    ['Deploy api to staging [backend-prod-api-123]', false],
    ['Deploy api to prod [manual]', false],
    ['Deploy api to prod [rb2:train:deploy:api:a1]', false]
  ])('accepts only an exact manual production title: %s', (title, accepted) => {
    const match = title.match(
      /^Deploy ([A-Za-z0-9]+) to prod \[backend-prod-([A-Za-z0-9]+)-([1-9][0-9]{0,19})\]$/
    );
    const result =
      match !== null && match[1] === match[2] && match[3] === '123';
    expect(result).toBe(accepted);
  });

  it('uses a read-only exact-run listener and never completes deploy success alone', () => {
    const listenerPath =
      '.github/workflows/release-bus-v2-production-authority-completion.yml';
    const source = read(listenerPath);
    const parsed = YAML.parse(source) as {
      on: {
        workflow_run: {
          workflows: string[];
          types: string[];
          branches: string[];
        };
      };
      permissions: Record<string, string>;
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
    expect(parsed.on.workflow_run).toEqual({
      workflows: ['Deploy a service'],
      types: ['completed'],
      branches: ['main']
    });
    expect(parsed.permissions).toEqual({ actions: 'read', contents: 'read' });
    expect(source).toContain(
      '.head_repository.full_name == "6529-Collections/6529seize-backend"'
    );
    expect(source).toContain('.path == ".github/workflows/deploy.yml"');
    expect(source).toContain(
      'title="$(jq -er \'.display_title\' "$run_file")"'
    );
    expect(source).toContain(
      'Exact backend failure state artifact was not available'
    );
    expect(source).toContain('/production-authority/complete');
    expect(source).toContain('/production-authority/fail');
    expect(source).toContain(
      '--arg qualifier_workflow_run_id "$DEPLOY_RUN_ID"'
    );
    expect(source).toContain(
      '--argjson qualifier_workflow_run_attempt "$DEPLOY_RUN_ATTEMPT"'
    );
    expect(source).toContain(
      'evidence_digest="$(sha256sum "$state_file" | cut -d\' \' -f1)"'
    );
    expect(source).toContain('reason_code=WORKFLOW_FAILED');
    expect(source).toContain(
      'failure|timed_out|action_required|stale|startup_failure'
    );
    expect(source).not.toContain('|neutral|');
    expect(source).not.toContain('|skipped|');
    expect(source).toContain(
      '["completed", "lock_row_version", "operation_id", "reused", "status"]'
    );
    expect(source).toContain(
      '["failed", "lock_row_version", "operation_id", "reused", "status"]'
    );
    expect(source).not.toContain('lease_token');
    expect(source.match(/--retry 4 --retry-all-errors/g)).toHaveLength(3);
    expect(source.match(/--retry-max-time 300/g)).toHaveLength(3);
    expect(source).not.toContain('Production E2E');
    expect(source.match(/actions\/download-artifact@/g)).toHaveLength(2);
    expect(source).toContain(
      'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7.0.0'
    );

    const identity = parsed.jobs.complete.steps[0]?.run ?? '';
    expect(identity).toContain('.event == "workflow_dispatch"');
    expect(identity).toContain('.status == "completed"');
    expect(identity).toContain('actions/workflows/$workflow_id');
    expect(identity).toMatch(
      /workflow_status="\$\(curl --silent --show-error \\\n\s+--retry 4 --retry-all-errors --retry-delay 2 --retry-max-time 300/
    );
    expect(identity).toContain('.name == "Deploy a service"');
    expect(identity).toContain('.path == ".github/workflows/deploy.yml"');
    expect(identity).toContain('.state == "active"');
    expect(identity).toContain('(.workflow_id | type == "number" and . >= 1)');
    expect(identity).toContain('backend-production-authority-');
    expect(identity).toContain('backend-production-authority-failure-');
    expect(identity).toContain('for artifact_attempt in {1..12}');
    expect(identity).toContain('if [ "$artifact_attempt" -lt 12 ]');
    expect(identity).toContain('sleep 5');
    expect(identity).toContain('test "$artifact_count" -le 1');
    const completion = parsed.jobs.complete.steps.find(({ name }) =>
      name?.includes('complete backend authority')
    );
    expect(completion?.if).toContain("conclusion == 'success'");
    expect(completion?.run).toContain('.selection | type == "object"');
    expect(completion?.run).toContain('evidence_digest=');
  });
});
