import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

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
    const evidence = index('Create backend production authority evidence');
    const evidenceUpload = index(
      'Upload backend production authority evidence'
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
    expect(reauthorize).toBe(aws - 1);
    expect(evidence).toBeGreaterThan(aws);
    expect(evidenceUpload).toBe(evidence + 1);
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
    expect(acquireResponseValidation).toBeGreaterThan(-1);
    expect(authorityStateWrite).toBeGreaterThan(acquireResponseValidation);
    expect(acquireScript).not.toContain('authority_state_json=');
    expect(acquireScript).not.toContain('--retry');
    expect(steps[acquire]?.uses).toBeUndefined();
    expect(steps[acquire]?.if).toBeUndefined();

    const selectionScript = steps[reauthorize]?.run ?? '';
    expect(selectionScript).toContain(
      'selection_type:"backend-production-deployment-selection-v1"'
    );
    expect(selectionScript).toContain('/production-authority/reauthorize');
    expect(selectionScript).toContain(
      '"authorized", "bound", "controller_identity", "control_epoch"'
    );
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

    expect(before).not.toContain('/production-authority/fail');
    expect(before).not.toContain(
      'Fail backend production authority after workflow failure'
    );
    expect(JSON.stringify(steps[failureStateUpload])).toContain(
      'backend-production-authority-failure-${{ github.run_id }}'
    );
    expect(before).not.toContain('/production-authority/complete');
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
    expect(source.match(/--retry 4 --retry-all-errors/g)).toHaveLength(2);
    expect(source.match(/--retry-max-time 300/g)).toHaveLength(2);
    expect(source).not.toContain('Production E2E');
    expect(source.match(/actions\/download-artifact@/g)).toHaveLength(2);
    expect(source).toContain(
      'actions/download-artifact@37930b1c2abaa49bbe596cd826c3c89aef350131 # v7.0.0'
    );

    const identity = parsed.jobs.complete.steps[0]?.run ?? '';
    expect(identity).toContain('.event == "workflow_dispatch"');
    expect(identity).toContain('.status == "completed"');
    expect(identity).toContain('backend-production-authority-');
    expect(identity).toContain('backend-production-authority-failure-');
    const completion = parsed.jobs.complete.steps.find(({ name }) =>
      name?.includes('complete backend authority')
    );
    expect(completion?.if).toContain("conclusion == 'success'");
    expect(completion?.run).toContain('.selection | type == "object"');
    expect(completion?.run).toContain('evidence_digest=');
  });
});
