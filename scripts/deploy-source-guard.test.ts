import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

type WorkflowStep = {
  name: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

const workflow = parse(
  readFileSync(
    path.resolve(__dirname, '../.github/workflows/deploy.yml'),
    'utf8'
  )
);
const job = workflow.jobs['build-and-deploy'];
const steps: WorkflowStep[] = job.steps;
const guard = steps[0];
const sourceSha = 'a'.repeat(40);

function validateDispatch(
  expectedSha: string,
  environment: 'staging' | 'prod' = 'staging',
  overrides: Record<string, string> = {}
) {
  return spawnSync('bash', ['-c', guard.run!], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      INPUT_ENVIRONMENT: environment,
      INPUT_SERVICE: 'api',
      EXPECTED_SOURCE_SHA: expectedSha,
      GITHUB_SHA: sourceSha,
      GITHUB_REF:
        environment === 'prod' ? 'refs/heads/main' : 'refs/heads/1a-staging',
      ...overrides
    }
  });
}

describe('generated deployment source guard', () => {
  it('binds the optional source input as data before checkout or credential configuration', () => {
    expect(workflow.on.workflow_dispatch.inputs.expected_source_sha).toEqual({
      type: 'string',
      description:
        'Exact reviewed source commit; fail if the branch resolves differently',
      required: false
    });
    expect(job.env.EXPECTED_SOURCE_SHA).toBe(
      '${{ github.event.inputs.expected_source_sha }}'
    );
    expect(guard.name).toBe(
      'Validate dispatch inputs before using credentials'
    );
    expect(guard.run).not.toContain('${{');
    const checkoutIndex = steps.findIndex((step) =>
      step.uses?.startsWith('actions/checkout@')
    );
    expect(checkoutIndex).toBeGreaterThan(0);
    expect(steps[checkoutIndex].with?.ref).toBe('${{ github.sha }}');
    expect(
      steps.findIndex((step) =>
        step.uses?.startsWith('aws-actions/configure-aws-credentials@')
      )
    ).toBeGreaterThan(checkoutIndex);
  });

  it.each(['staging', 'prod'] as const)(
    'accepts an exact reviewed SHA for %s',
    (environment) => {
      const result = validateDispatch(sourceSha, environment);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
    }
  );

  it('keeps ordinary callers compatible when the optional input is omitted', () => {
    expect(validateDispatch('').status).toBe(0);
  });

  it('rejects a branch that resolves to a different SHA after the caller checked it', () => {
    const result = validateDispatch(sourceSha, 'staging', {
      GITHUB_SHA: 'b'.repeat(40)
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Source changed after review');
  });

  it.each(['main', 'a'.repeat(39), 'A'.repeat(40), '$(exit 73)', 'a\nb'])(
    'rejects malformed expected source input %j as data',
    (expectedSha) => {
      const result = validateDispatch(expectedSha);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('must be a full lowercase commit SHA');
    }
  );

  it.each(['refs/tags/reviewed', 'refs/heads/feature', 'refs/heads/main'])(
    'preserves staging branch restrictions for %s',
    (ref) => {
      expect(
        validateDispatch(sourceSha, 'staging', { GITHUB_REF: ref }).status
      ).toBe(1);
    }
  );

  it('preserves the production main-branch restriction', () => {
    expect(
      validateDispatch(sourceSha, 'prod', {
        GITHUB_REF: 'refs/heads/1a-staging'
      }).status
    ).toBe(1);
  });
});
