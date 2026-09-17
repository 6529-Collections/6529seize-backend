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
  response: unknown = scope !== 'full' ? { schema_scope: scope } : null
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
      options: [
        'full',
        'wallet-transfer-analysis',
        'claims-media-upload',
        'nft-link-page-retry',
        'membership-refresh',
        'membership-evaluator-index',
        'membership-runtime-control',
        'membership-backfill-probes'
      ]
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

  it('restricts NFT retry scope to dbMigrationsLoop before credentials', () => {
    expect(
      validateDispatch('', 'prod', {
        INPUT_SERVICE: 'dbMigrationsLoop',
        DB_SCHEMA_SCOPE: 'nft-link-page-retry'
      }).status
    ).toBe(0);
    expect(
      validateDispatch('', 'prod', {
        INPUT_SERVICE: 'api',
        DB_SCHEMA_SCOPE: 'nft-link-page-retry'
      }).status
    ).toBe(1);
  });

  it.each([
    {},
    null,
    { schema_scope: 'full' },
    { schema_scope: 'wallet-transfer-analysis' },
    { schema_scope: 'claims-media-upload' }
  ])(
    'rejects a missing or different NFT retry acknowledgment %j',
    (response) => {
      const result = invokeMigrationScope(
        'nft-link-page-retry',
        { StatusCode: 200 },
        response
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('did not acknowledge');
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

  it.each([
    'full',
    'wallet-transfer-analysis',
    'claims-media-upload',
    'nft-link-page-retry',
    'membership-refresh',
    'membership-evaluator-index',
    'membership-backfill-probes'
  ])('forwards validated %s as one JSON invocation payload', (scope) => {
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
  });

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

  it('restricts claims schema scope to the migration service', () => {
    expect(
      validateDispatch(sourceSha, 'prod', {
        INPUT_SERVICE: 'dbMigrationsLoop',
        DB_SCHEMA_SCOPE: 'claims-media-upload'
      }).status
    ).toBe(0);
    expect(
      validateDispatch(sourceSha, 'prod', {
        INPUT_SERVICE: 'claimsMediaArweaveUploader',
        DB_SCHEMA_SCOPE: 'claims-media-upload'
      }).status
    ).toBe(1);
  });

  it.each([
    null,
    {},
    { schema_scope: 'full' },
    { schema_scope: 'wallet-transfer-analysis' },
    { schema_scope: 'nft-link-page-retry' }
  ])(
    'rejects a claims schema invocation without its exact acknowledgment: %j',
    (response) => {
      const result = invokeMigrationScope(
        'claims-media-upload',
        { StatusCode: 200 },
        response
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('did not acknowledge');
    }
  );
  it.each(['staging', 'prod'] as const)(
    'accepts inactive worker defaults for %s',
    (environment) => {
      expect(
        validateDispatch(sourceSha, environment, {
          INPUT_SERVICE: 'membershipRefreshLoop'
        }).status
      ).toBe(0);
    }
  );

  it('allows the exact staging fixture mapping and binds control inputs as data', () => {
    expect(
      validateDispatch(sourceSha, 'staging', {
        INPUT_SERVICE: 'membershipRefreshLoop',
        MEMBERSHIP_RUNTIME_MODE: 'staging-fixture-v1',
        MEMBERSHIP_WORKER_MAPPING_ENABLED: 'true'
      }).status
    ).toBe(0);
    expect(
      workflow.on.workflow_dispatch.inputs.membership_runtime_mode.default
    ).toBe('inactive');
    expect(
      workflow.on.workflow_dispatch.inputs.membership_worker_mapping_enabled
        .default
    ).toBe(false);
    expect(job.env.MEMBERSHIP_RUNTIME_MODE).toBe(
      "${{ github.event.inputs.membership_runtime_mode || 'inactive' }}"
    );
    expect(job.env.MEMBERSHIP_WORKER_MAPPING_ENABLED).toBe(
      "${{ github.event.inputs.membership_worker_mapping_enabled || 'false' }}"
    );
  });

  it('admits explicit backfill mode only for staging membership runtime services', () => {
    expect(
      workflow.on.workflow_dispatch.inputs.membership_runtime_mode.options
    ).toContain('staging-backfill-v1');
    expect(
      validateDispatch(sourceSha, 'staging', {
        INPUT_SERVICE: 'membershipRefreshLoop',
        MEMBERSHIP_RUNTIME_MODE: 'staging-backfill-v1',
        MEMBERSHIP_WORKER_MAPPING_ENABLED: 'true'
      }).status
    ).toBe(0);
    expect(
      validateDispatch(sourceSha, 'staging', {
        INPUT_SERVICE: 'membershipRefreshDispatcherLoop',
        MEMBERSHIP_RUNTIME_MODE: 'staging-backfill-v1',
        MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED: 'true'
      }).status
    ).toBe(0);
    expect(
      validateDispatch(sourceSha, 'staging', {
        INPUT_SERVICE: 'api',
        MEMBERSHIP_RUNTIME_MODE: 'staging-backfill-v1'
      }).status
    ).toBe(1);
    expect(
      validateDispatch(sourceSha, 'prod', {
        INPUT_SERVICE: 'membershipRefreshLoop',
        MEMBERSHIP_RUNTIME_MODE: 'staging-backfill-v1',
        MEMBERSHIP_WORKER_MAPPING_ENABLED: 'false'
      }).status
    ).toBe(1);
    expect(
      validateDispatch(sourceSha, 'prod', {
        INPUT_SERVICE: 'membershipRefreshDispatcherLoop',
        MEMBERSHIP_RUNTIME_MODE: 'staging-backfill-v1',
        MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED: 'false'
      }).status
    ).toBe(1);
  });

  it('keeps producer, reader and shadow controls inactive by default and stage-owned', () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs.membership_source_tracking_mode.default).toBe('inactive');
    expect(inputs.membership_read_mode.default).toBe('legacy');
    expect(inputs.membership_shadow_mode.default).toBe('off');
    expect(inputs.membership_reader_profile_ids.default).toBe('');
    expect(inputs.membership_reader_coverage_revision.default).toBe('');
    expect(job.env.MEMBERSHIP_SOURCE_TRACKING_STAGE).toBe(
      '${{ github.event.inputs.environment }}'
    );
    expect(job.env.MEMBERSHIP_READER_STAGE).toBe(
      '${{ github.event.inputs.environment }}'
    );
    expect(steps.find((step) => step.name === 'Deploy API')?.run).toContain(
      'MEMBERSHIP_READER_COVERAGE_REVISION: $readerCoverageRevision'
    );
  });

  it('allows only explicit staging producer tracking', () => {
    expect(
      validateDispatch(sourceSha, 'staging', {
        INPUT_SERVICE: 'tdhLoop',
        MEMBERSHIP_SOURCE_TRACKING_MODE: 'tracking-v1'
      }).status
    ).toBe(0);
    expect(
      validateDispatch(sourceSha, 'prod', {
        INPUT_SERVICE: 'tdhLoop',
        MEMBERSHIP_SOURCE_TRACKING_MODE: 'tracking-v1'
      }).status
    ).toBe(1);
    expect(
      validateDispatch(sourceSha, 'staging', {
        INPUT_SERVICE: 'membershipRefreshLoop',
        MEMBERSHIP_SOURCE_TRACKING_MODE: 'tracking-v1'
      }).status
    ).toBe(1);
    // Historical TDH replay is a general deploy unit, not a tracked producer.
    expect(
      validateDispatch(sourceSha, 'staging', {
        INPUT_SERVICE: 'populateHistoricConsolidatedTdh',
        MEMBERSHIP_SOURCE_TRACKING_MODE: 'tracking-v1'
      }).status
    ).toBe(1);
    expect(
      readFileSync(
        path.resolve(
          __dirname,
          '../src/populateHistoricConsolidatedTdh/serverless.yaml'
        ),
        'utf8'
      )
    ).not.toContain('MEMBERSHIP_SOURCE_TRACKING_MODE');
  });

  it('embeds the full workflow SHA and deploy description in every non-API tracked writer function', () => {
    const writerUnits = [
      'helpBotReplyLoop',
      'xTdhLoop',
      'tdhLoop',
      'delegationsLoop',
      'overRatesRevocationLoop',
      'xTdhGrantsReviewerLoop',
      'nftOwnersLoop',
      'externalCollectionSnapshottingLoop',
      'externalCollectionLiveTailingLoop'
    ];
    for (const unit of writerUnits) {
      const serverless = readFileSync(
        path.resolve(__dirname, `../src/${unit}/serverless.yaml`),
        'utf8'
      );
      const tracking = serverless.match(/MEMBERSHIP_SOURCE_TRACKING_MODE:/g);
      const deployedSha = serverless.match(
        /MEMBERSHIP_DEPLOY_SOURCE_SHA: \$\{env:GITHUB_SHA, ''\}/g
      );
      const description = serverless.match(
        /description: \$\{env:VERSION_DESCRIPTION\}/g
      );
      expect(deployedSha?.length).toBe(tracking?.length);
      expect(description?.length).toBe(tracking?.length);
    }
    expect(steps.find((step) => step.name === 'Deploy API')?.run).toContain(
      'GIT_COMMIT: $commit'
    );
  });

  it('validates the operator writer-receipt collector without AWS calls', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--test',
        path.resolve(__dirname, 'membership-m8-writer-receipt-check.mjs')
      ],
      { encoding: 'utf8', timeout: 10_000 }
    );
    expect(result.status).toBe(0);
  });

  it('requires an audited allowlist for controlled staging API reads', () => {
    const controls = {
      INPUT_SERVICE: 'api',
      MEMBERSHIP_READ_MODE: 'staging-controlled-v1',
      MEMBERSHIP_SHADOW_MODE: 'staging-controlled-v1',
      MEMBERSHIP_READER_PROFILE_IDS: 'profile-a,profile-b',
      MEMBERSHIP_READER_COVERAGE_REVISION: 'audited-v1'
    };
    expect(validateDispatch(sourceSha, 'staging', controls).status).toBe(0);
    expect(validateDispatch(sourceSha, 'prod', controls).status).toBe(1);
    expect(
      validateDispatch(sourceSha, 'staging', {
        ...controls,
        MEMBERSHIP_READER_COVERAGE_REVISION: ''
      }).status
    ).toBe(1);
    expect(
      validateDispatch(sourceSha, 'staging', {
        ...controls,
        MEMBERSHIP_READER_PROFILE_IDS: 'bad profile'
      }).status
    ).toBe(1);
  });

  it.each<Record<string, string>>([
    { INPUT_SERVICE: 'api', MEMBERSHIP_RUNTIME_MODE: 'staging-fixture-v1' },
    { INPUT_SERVICE: 'api', MEMBERSHIP_WORKER_MAPPING_ENABLED: 'true' },
    { MEMBERSHIP_WORKER_MAPPING_ENABLED: 'true' },
    { MEMBERSHIP_WORKER_MAPPING_ENABLED: 'TRUE' },
    { MEMBERSHIP_WORKER_MAPPING_ENABLED: '0' },
    { MEMBERSHIP_RUNTIME_MODE: 'active' },
    { MEMBERSHIP_RUNTIME_MODE: '$(exit 73)' }
  ])(
    'rejects unsupported worker controls before credentials: %j',
    (overrides) => {
      expect(
        validateDispatch(sourceSha, 'staging', {
          INPUT_SERVICE: 'membershipRefreshLoop',
          ...overrides
        }).status
      ).toBe(1);
    }
  );

  it('rejects production fixture mode even when mapping is disabled', () => {
    expect(
      validateDispatch(sourceSha, 'prod', {
        INPUT_SERVICE: 'membershipRefreshLoop',
        MEMBERSHIP_RUNTIME_MODE: 'staging-fixture-v1'
      }).status
    ).toBe(1);
  });

  it('restricts runtime-control schema to the migration carrier and validates its acknowledgment', () => {
    expect(
      validateDispatch(sourceSha, 'prod', {
        INPUT_SERVICE: 'membershipRefreshLoop',
        DB_SCHEMA_SCOPE: 'membership-runtime-control'
      }).status
    ).toBe(1);
    expect(invokeMigrationScope('membership-runtime-control').status).toBe(0);
    expect(
      invokeMigrationScope(
        'membership-runtime-control',
        { StatusCode: 200 },
        { schema_scope: 'membership-refresh' }
      ).status
    ).toBe(1);
  });
  it('restricts backfill probe schema to the migration carrier and validates its acknowledgment', () => {
    expect(
      validateDispatch(sourceSha, 'staging', {
        INPUT_SERVICE: 'api',
        DB_SCHEMA_SCOPE: 'membership-backfill-probes'
      }).status
    ).toBe(1);
    expect(invokeMigrationScope('membership-backfill-probes').status).toBe(0);
    expect(
      invokeMigrationScope(
        'membership-backfill-probes',
        { StatusCode: 200 },
        { schema_scope: 'membership-refresh' }
      ).status
    ).toBe(1);
  });
  it.each(['staging', 'prod'] as const)(
    'accepts inactive dispatcher defaults for %s',
    (environment) => {
      expect(
        validateDispatch(sourceSha, environment, {
          INPUT_SERVICE: 'membershipRefreshDispatcherLoop'
        }).status
      ).toBe(0);
    }
  );
  it('binds the schedule input and permits only explicit fixture activation', () => {
    expect(
      workflow.on.workflow_dispatch.inputs.membership_dispatch_schedule_enabled
    ).toMatchObject({ type: 'boolean', default: false });
    expect(job.env.MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED).toBe(
      "${{ github.event.inputs.membership_dispatch_schedule_enabled || 'false' }}"
    );
    expect(
      validateDispatch(sourceSha, 'staging', {
        INPUT_SERVICE: 'membershipRefreshDispatcherLoop',
        MEMBERSHIP_RUNTIME_MODE: 'staging-fixture-v1',
        MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED: 'true'
      }).status
    ).toBe(0);
  });
  it.each<Record<string, string>>([
    { MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED: 'true' },
    { MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED: 'TRUE' },
    { MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED: '0' },
    { MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED: '$(exit 73)' },
    {
      MEMBERSHIP_RUNTIME_MODE: 'staging-fixture-v1',
      MEMBERSHIP_WORKER_MAPPING_ENABLED: 'true'
    },
    { INPUT_SERVICE: 'api', MEMBERSHIP_RUNTIME_MODE: 'staging-fixture-v1' },
    { INPUT_SERVICE: 'api', MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED: 'true' },
    {
      INPUT_SERVICE: 'membershipRefreshLoop',
      MEMBERSHIP_RUNTIME_MODE: 'staging-fixture-v1',
      MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED: 'true'
    }
  ])('rejects unsafe or cross-service dispatcher controls %j', (overrides) => {
    expect(
      validateDispatch(sourceSha, 'staging', {
        INPUT_SERVICE: 'membershipRefreshDispatcherLoop',
        ...overrides
      }).status
    ).toBe(1);
  });
  it.each(['false', 'true'])(
    'rejects production fixture mode with schedule %s',
    (schedule) => {
      expect(
        validateDispatch(sourceSha, 'prod', {
          INPUT_SERVICE: 'membershipRefreshDispatcherLoop',
          MEMBERSHIP_RUNTIME_MODE: 'staging-fixture-v1',
          MEMBERSHIP_DISPATCH_SCHEDULE_ENABLED: schedule
        }).status
      ).toBe(1);
    }
  );
  it('catalogs the dispatcher behind worker exports with its own health target', () => {
    const catalog = JSON.parse(
      readFileSync(
        path.resolve(__dirname, '../src/config/deploy-services.json'),
        'utf8'
      )
    ) as {
      services: { name: string; [key: string]: unknown }[];
    };
    expect(
      catalog.services.find(
        (service) => service.name === 'membershipRefreshDispatcherLoop'
      )
    ).toEqual({
      name: 'membershipRefreshDispatcherLoop',
      allowed_environments: ['staging', 'prod'],
      deploy_adapter: 'serverless',
      aws_region: { staging: 'eu-west-1', prod: 'us-east-1' },
      verification_targets: ['membershipRefreshDispatcherLoop'],
      validation_profile: 'lambda-version',
      default_dependencies: ['membershipRefreshLoop']
    });
    expect(workflow.on.workflow_dispatch.inputs.service.options).toContain(
      'membershipRefreshDispatcherLoop'
    );
  });
});
