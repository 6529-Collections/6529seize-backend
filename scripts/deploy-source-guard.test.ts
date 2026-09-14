import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
      DB_SCHEMA_SCOPE: 'full',
      EXPECTED_SOURCE_SHA: expectedSha,
      GITHUB_SHA: sourceSha,
      GITHUB_REF:
        environment === 'prod' ? 'refs/heads/main' : 'refs/heads/1a-staging',
      ...overrides
    }
  });
}

function invokeMigrationScope(
  scope: string,
  metadata: unknown = { StatusCode: 200 },
  response: unknown = scope === 'wallet-transfer-analysis'
    ? { schema_scope: scope }
    : null
) {
  const directory = mkdtempSync(path.join(tmpdir(), '6529-schema-scope-'));
  const argumentsPath = path.join(directory, 'arguments.txt');
  const invokeStep = steps.find(
    (step) => step.name === 'Run lambda and validate result'
  )!;
  const fakeCommands = `
sleep() { :; }
aws() {
  printf '%s\\n' "$@" > "$MOCK_SCHEMA_INVOCATION_PATH"
  printf '%s' "$MOCK_SCHEMA_RESPONSE" > response.json
  printf '%s' "$MOCK_SCHEMA_METADATA"
}
`;
  try {
    const result = spawnSync(
      'bash',
      ['-c', `${fakeCommands}\n${guard.run}\n${invokeStep.run}`],
      {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          INPUT_ENVIRONMENT: 'prod',
          INPUT_SERVICE: 'dbMigrationsLoop',
          EXPECTED_SOURCE_SHA: sourceSha,
          DB_SCHEMA_SCOPE: scope,
          GITHUB_SHA: sourceSha,
          GITHUB_REF: 'refs/heads/main',
          MOCK_SCHEMA_INVOCATION_PATH: argumentsPath,
          MOCK_SCHEMA_RESPONSE: JSON.stringify(response),
          MOCK_SCHEMA_METADATA: JSON.stringify(metadata)
        }
      }
    );
    const args = readFileSync(argumentsPath, 'utf8').trimEnd().split(/\r?\n/);
    return { ...result, args };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

  it('defaults schema scope to full and validates it before credentials', () => {
    expect(workflow.on.workflow_dispatch.inputs.db_schema_scope).toEqual({
      type: 'choice',
      description:
        'Schema scope for dbMigrationsLoop; other services require full',
      required: false,
      default: 'full',
      options: ['full', 'wallet-transfer-analysis']
    });
    expect(job.env.DB_SCHEMA_SCOPE).toBe(
      "${{ github.event.inputs.db_schema_scope || 'full' }}"
    );
    expect(
      validateDispatch('', 'prod', {
        INPUT_SERVICE: 'dbMigrationsLoop',
        DB_SCHEMA_SCOPE: 'wallet-transfer-analysis'
      }).status
    ).toBe(0);
    expect(
      validateDispatch('', 'prod', {
        DB_SCHEMA_SCOPE: 'wallet-transfer-analysis'
      }).status
    ).toBe(1);
  });

  it.each(['unknown', '$(exit 73)', 'full\nwallet-transfer-analysis', ''])(
    'rejects unsupported schema scope %j as data',
    (scope) => {
      expect(
        validateDispatch('', 'prod', {
          INPUT_SERVICE: 'dbMigrationsLoop',
          DB_SCHEMA_SCOPE: scope
        }).status
      ).toBe(1);
    }
  );

  it('verifies the exact Lambda artifact before invoking a scoped migration', () => {
    const verificationIndex = steps.findIndex(
      (step) => step.name === 'Verify immutable Lambda code'
    );
    const invocationIndex = steps.findIndex(
      (step) => step.name === 'Run lambda and validate result'
    );
    expect(verificationIndex).toBeGreaterThan(0);
    expect(invocationIndex).toBeGreaterThan(verificationIndex);
    expect(steps[verificationIndex].run).toContain('--query CodeSha256');
    expect(steps[invocationIndex].run).toContain(
      'jq -cn --arg scope "$DB_SCHEMA_SCOPE"'
    );
    expect(steps[invocationIndex].run).toContain(
      '--cli-binary-format raw-in-base64-out --payload "$payload"'
    );
  });

  it.each(['full', 'wallet-transfer-analysis'])(
    'forwards validated %s as one JSON invocation payload',
    (scope) => {
      const result = invokeMigrationScope(scope);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.args).toEqual([
        'lambda',
        'invoke',
        '--function-name',
        'dbMigrationsLoop',
        '--cli-binary-format',
        'raw-in-base64-out',
        '--payload',
        JSON.stringify({ schema_scope: scope }),
        'response.json'
      ]);
    }
  );

  it.each(['Handled', 'Unhandled', 'Unexpected', '', false, 0])(
    'fails on every non-null FunctionError including %j',
    (error) => {
      const result = invokeMigrationScope('wallet-transfer-analysis', {
        StatusCode: 200,
        FunctionError: error
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('function error or invalid metadata');
    }
  );

  it.each([{}, null, { schema_scope: 'full' }, { schema_scope: true }])(
    'fails without an exact scoped acknowledgment in %j',
    (response) => {
      const result = invokeMigrationScope(
        'wallet-transfer-analysis',
        { StatusCode: 200 },
        response
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('did not acknowledge');
    }
  );

  it('accepts explicit null FunctionError with the exact scoped acknowledgment', () => {
    expect(
      invokeMigrationScope('wallet-transfer-analysis', {
        StatusCode: 200,
        FunctionError: null
      }).status
    ).toBe(0);
  });
});
