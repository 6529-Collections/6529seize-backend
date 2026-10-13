import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

type WorkflowStep = {
  name: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
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
const stagingCondition = "github.event.inputs.environment == 'staging'";
const productionCondition = "github.event.inputs.environment == 'prod'";
const roleArn = 'arn:aws:iam::123456789012:role/gha-backend-deploy-staging';
const validation = steps.find((step) => step.id === 'staging_role')!;

function validateRole(value: string) {
  const directory = mkdtempSync(path.join(tmpdir(), 'deploy-oidc-'));
  const output = path.join(directory, 'output');
  try {
    const result = spawnSync('bash', ['-c', validation.run!], {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, AWS_DEPLOY_ROLE_ARN: value, GITHUB_OUTPUT: output }
    });
    return {
      ...result,
      output: result.status === 0 ? readFileSync(output, 'utf8') : undefined
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('staging deployment OIDC boundary', () => {
  it('binds deployments to the protected GitHub environments and grants only required token permissions', () => {
    expect(job.environment).toBe(
      "${{ github.event.inputs.environment == 'staging' && 'staging' || 'production' }}"
    );
    expect(job.permissions).toEqual({
      actions: 'read',
      contents: 'read',
      'id-token': 'write'
    });
    expect(workflow.permissions['id-token']).toBeUndefined();
  });

  it('never passes legacy keys to the staging credential action', () => {
    const credentials = steps.filter((step) =>
      step.uses?.startsWith('aws-actions/configure-aws-credentials@')
    );
    expect(credentials).toHaveLength(2);
    const staging = credentials.find((step) => step.if === stagingCondition)!;
    expect(staging.with).toEqual({
      'role-to-assume': '${{ vars.AWS_DEPLOY_ROLE_ARN }}',
      'allowed-account-ids': '${{ steps.staging_role.outputs.account_id }}',
      'role-session-name': 'backend-staging-${{ github.run_id }}',
      'unset-current-credentials': true,
      'aws-region': 'eu-west-1'
    });
    const production = credentials.find(
      (step) => step.if === productionCondition
    )!;
    expect(production.with).toEqual({
      'aws-access-key-id': '${{ secrets.AWS_ACCESS_KEY_ID }}',
      'aws-secret-access-key': '${{ secrets.AWS_SECRET_ACCESS_KEY }}',
      'force-skip-oidc': true,
      'aws-region': 'us-east-1'
    });
  });

  it('validates the environment variable before checkout, builds, or authentication', () => {
    expect(validation.if).toBe(stagingCondition);
    expect(validation.env).toEqual({
      AWS_DEPLOY_ROLE_ARN: '${{ vars.AWS_DEPLOY_ROLE_ARN }}'
    });
    expect(validation.run).not.toContain('${{');
    const validationIndex = steps.indexOf(validation);
    expect(validationIndex).toBeGreaterThan(0);
    expect(validationIndex).toBeLessThan(
      steps.findIndex((step) => step.uses?.startsWith('actions/checkout@'))
    );
  });

  it.each([roleArn, roleArn.replace('role/', 'role/deployment/')])(
    'accepts a role ARN and restricts the expected account: %s',
    (value) => {
      const result = validateRole(value);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.output).toBe('account_id=123456789012\n');
    }
  );

  it.each([
    '',
    'gha-backend-deploy-staging',
    roleArn.replace('123456789012', '123'),
    roleArn.replace(':role/', ':user/'),
    `${roleArn}\naccount_id=999999999999`,
    `${roleArn}$(exit 73)`,
    `${roleArn}; exit 73`,
    `${roleArn} `
  ])('fails closed on missing or malformed configuration: %j', (value) => {
    const result = validateRole(value);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Configure AWS_DEPLOY_ROLE_ARN');
    expect(result.output).toBeUndefined();
  });
});
