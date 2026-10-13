import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync
} from 'node:fs';
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
  it('matches the workflow generated from the committed source files', () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), 'deploy-oidc-generator-')
    );
    try {
      for (const subdirectory of [
        'scripts',
        'src/config',
        '.github/workflows'
      ]) {
        mkdirSync(path.join(directory, subdirectory), { recursive: true });
      }
      for (const file of [
        'scripts/generate-deploy-config.mjs',
        'src/config/deploy-config.validation.js',
        'src/config/deploy-services.json'
      ]) {
        copyFileSync(
          path.resolve(__dirname, '..', file),
          path.join(directory, file)
        );
      }
      const result = spawnSync(
        process.execPath,
        [path.join(directory, 'scripts/generate-deploy-config.mjs')],
        {
          encoding: 'utf8',
          timeout: 10000
        }
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(
        readFileSync(
          path.join(directory, '.github/workflows/deploy.yml'),
          'utf8'
        )
      ).toBe(
        readFileSync(
          path.resolve(__dirname, '../.github/workflows/deploy.yml'),
          'utf8'
        )
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ['staging', 'success', '', 0],
    ['prod', '', 'success', 0],
    ['staging', '', 'success', 1],
    ['prod', 'success', '', 1],
    ['staging', 'skipped', '', 1],
    ['prod', '', 'failure', 1],
    ['unknown', 'success', 'success', 1]
  ])(
    'requires the selected credential action to succeed for %s (%s, %s)',
    (environment, staging, production, status) => {
      const authentication = steps.find(
        (step) => step.name === 'Require successful AWS authentication'
      )!;
      expect(authentication.env).toEqual({
        STAGING_CREDENTIALS_OUTCOME:
          '${{ steps.aws_credentials_staging.outcome }}',
        PRODUCTION_CREDENTIALS_OUTCOME: '${{ steps.aws_credentials.outcome }}'
      });
      const result = spawnSync('bash', ['-c', authentication.run!], {
        encoding: 'utf8',
        timeout: 10000,
        env: {
          ...process.env,
          INPUT_ENVIRONMENT: String(environment),
          STAGING_CREDENTIALS_OUTCOME: String(staging),
          PRODUCTION_CREDENTIALS_OUTCOME: String(production),
          AWS_ACCESS_KEY_ID: 'ambient-credentials-must-not-bypass-the-guard'
        }
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(status);
      expect(steps.indexOf(authentication)).toBeLessThan(
        steps.findIndex(
          (step) => step.name === 'Select environment-specific config'
        )
      );
    }
  );

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
    expect(staging.id).toBe('aws_credentials_staging');
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
    expect(production.id).toBe('aws_credentials');
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
