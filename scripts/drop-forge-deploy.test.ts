import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';

const workflow = parse(
  readFileSync(
    path.resolve(__dirname, '../.github/workflows/deploy.yml'),
    'utf8'
  )
);
const job = workflow.jobs['build-and-deploy'];
const steps = job.steps as {
  name: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
}[];
const roleStep = steps.find(
  (step) => step.name === 'Configure Drop Forge execution role'
)!;
const roleArn = 'arn:aws:iam::123456789012:role/drop-forge/launch';

function configureRole(service: string, variables: Record<string, string>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'drop-forge-deploy-'));
  const output = path.join(directory, 'environment');
  try {
    const result = spawnSync('bash', ['-c', roleStep.run!], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        DROP_FORGE_WORKER_ROLE_ARN: '',
        DROP_FORGE_PREPARATION_ROLE_ARN: '',
        ...variables,
        INPUT_SERVICE: service,
        GITHUB_ENV: output
      }
    });
    return {
      ...result,
      environment: existsSync(output) ? readFileSync(output, 'utf8') : ''
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

it('loads role variables from the selected protected GitHub environment before deployment', () => {
  expect(job.environment).toBe(
    "${{ github.event.inputs.environment == 'staging' && 'staging' || 'production' }}"
  );
  expect(roleStep.env).toEqual({
    DROP_FORGE_WORKER_ROLE_ARN: '${{ vars.DROP_FORGE_WORKER_ROLE_ARN }}',
    DROP_FORGE_PREPARATION_ROLE_ARN:
      '${{ vars.DROP_FORGE_PREPARATION_ROLE_ARN }}'
  });
  expect(roleStep.if).toBe(
    "github.event.inputs.service == 'dropForgeLaunchLoop' || github.event.inputs.service == 'dropForgePreparationLoop'"
  );
  expect(steps.indexOf(roleStep)).toBeGreaterThan(0);
  expect(steps.indexOf(roleStep)).toBeLessThan(
    steps.findIndex((step) => step.name === 'Deploy service')
  );
});

it.each([
  ['dropForgeLaunchLoop', 'DROP_FORGE_WORKER_ROLE_ARN'],
  ['dropForgePreparationLoop', 'DROP_FORGE_PREPARATION_ROLE_ARN']
])('exports only the role needed by %s', (service, variable) => {
  const result = configureRole(service, { [variable]: roleArn });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.environment).toBe(`${variable}=${roleArn}\n`);
});

it.each([
  ['dropForgeLaunchLoop', 'DROP_FORGE_WORKER_ROLE_ARN'],
  ['dropForgePreparationLoop', 'DROP_FORGE_PREPARATION_ROLE_ARN']
])(
  'rejects the missing required role for %s even when the other role exists',
  (service, variable) => {
    const other =
      variable === 'DROP_FORGE_WORKER_ROLE_ARN'
        ? 'DROP_FORGE_PREPARATION_ROLE_ARN'
        : 'DROP_FORGE_WORKER_ROLE_ARN';
    const result = configureRole(service, { [other]: roleArn });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${variable} must be a valid IAM role ARN`);
    expect(result.environment).toBe('');
  }
);

it.each([
  'launch-role',
  'arn:aws:iam::123:role/launch',
  'arn:aws:iam::123456789012:user/launch',
  `${roleArn}\nINJECTED=value`,
  `${roleArn} $(unexpected-command)`
])('rejects malformed or injectable role values: %s', (value) => {
  const result = configureRole('dropForgeLaunchLoop', {
    DROP_FORGE_WORKER_ROLE_ARN: value
  });
  expect(result.status).toBe(1);
  expect(result.environment).toBe('');
});

it('rejects accidental invocation for an unrelated service without exporting a role', () => {
  const result = configureRole('api', {
    DROP_FORGE_WORKER_ROLE_ARN: roleArn
  });
  expect(result.status).toBe(1);
  expect(result.environment).toBe('');
});
