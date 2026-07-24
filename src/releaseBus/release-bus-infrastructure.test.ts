import { readFileSync } from 'node:fs';
import stateMachine from '@/releaseBus/state-machine.asl.json';
import { e2eSourceRef } from '@/releaseBus/worker';

const deployWorkflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const preflightWorkflow = readFileSync(
  '.github/workflows/release-bus-preflight.yml',
  'utf8'
);
const isolationWorkflow = readFileSync(
  '.github/workflows/release-bus-isolate-candidate.yml',
  'utf8'
);
const releaseBusServerless = readFileSync(
  'src/releaseBus/serverless.yaml',
  'utf8'
);
const releaseBusEntryPoint = readFileSync('src/releaseBus/index.ts', 'utf8');
const releaseBusWorker = readFileSync('src/releaseBus/worker.ts', 'utf8');
const dbContext = readFileSync('src/secrets.ts', 'utf8');
const environmentLoader = readFileSync('src/env.ts', 'utf8');
const releaseBusGitHubApp = readFileSync(
  'src/releaseBus/release-bus.github-app.ts',
  'utf8'
);
const ciWaveNotifier = readFileSync('scripts/notify-ci-wave.mjs', 'utf8');
const forceFreshMigration = readFileSync(
  'migrations/20260721114000-add-release-bus-force-fresh-base-canary.js',
  'utf8'
);

describe('release bus infrastructure contract', () => {
  it('invokes the worker version pinned into the train execution', () => {
    const advance = stateMachine.States.ADVANCE_TRAIN;
    expect(advance.Parameters['FunctionName.$']).toBe('$.worker_arn');
    expect(advance.Parameters.Payload['worker_arn.$']).toBe('$.worker_arn');
    expect(advance.Retry[0].MaxAttempts).toBeGreaterThan(1);
    expect(advance.Catch[0].Next).toBe('WAIT');
  });

  it('requires staging and production E2E even for backend-only trains', () => {
    expect(e2eSourceRef(null, 'staging', 'release-bus/train')).toBe(
      '1a-staging'
    );
    expect(e2eSourceRef(null, 'prod', 'release-bus/train')).toBe('main');
    expect(
      e2eSourceRef('release-bus/train', 'staging', 'release-bus/train')
    ).toBe('release-bus/train');
  });

  it('requires an exact frontend base canary before composition', () => {
    expect(releaseBusWorker).toContain(
      "workflow: 'release-bus-base-canary.yml'"
    );
    const canaryCall =
      'const baseCanary = await advanceFrontendBaseCanary(train, candidates);';
    const compositionCall = 'await beginComposition(train, candidates);';
    expect(releaseBusWorker).toContain(canaryCall);
    expect(releaseBusWorker.indexOf(canaryCall)).toBeLessThan(
      releaseBusWorker.indexOf(compositionCall)
    );
  });

  it('parallelizes exact-tree gates while preserving frozen dependency setup', () => {
    const installCommand =
      'npm --prefix src/api-serverless ci --ignore-scripts';
    const isolationInstallIndex = isolationWorkflow.indexOf(installCommand);
    const typecheckJob = preflightWorkflow.slice(
      preflightWorkflow.indexOf('\n  typecheck:'),
      preflightWorkflow.indexOf('\n  tests:')
    );
    const testsJob = preflightWorkflow.slice(
      preflightWorkflow.indexOf('\n  tests:'),
      preflightWorkflow.indexOf('\n  package:')
    );
    const packageJob = preflightWorkflow.slice(
      preflightWorkflow.indexOf('\n  package:'),
      preflightWorkflow.indexOf('\n  aggregate:')
    );
    const aggregateJob = preflightWorkflow.slice(
      preflightWorkflow.indexOf('\n  aggregate:')
    );

    expect(typecheckJob.indexOf(installCommand)).toBeGreaterThan(-1);
    expect(typecheckJob.indexOf('./node_modules/.bin/tsc')).toBeGreaterThan(
      typecheckJob.indexOf(installCommand)
    );
    expect(isolationInstallIndex).toBeGreaterThan(-1);
    expect(isolationWorkflow.indexOf('npx eslint')).toBeGreaterThan(
      isolationInstallIndex
    );
    expect(preflightWorkflow).toContain('\n  lint:\n');
    expect(preflightWorkflow).toContain('\n  typecheck:\n');
    expect(preflightWorkflow).toContain('\n  tests:\n');
    expect(preflightWorkflow).toContain('\n  package:\n');
    expect(preflightWorkflow).toContain('cache: npm');
    expect(preflightWorkflow).toContain(
      `node -p 'require("./package.json").packageManager.split("npm@")[1]'`
    );
    expect(preflightWorkflow).not.toContain('node -p \\"');
    expect(preflightWorkflow).toContain(
      'npm test -- --maxWorkers=2 --json --outputFile='
    );
    expect(preflightWorkflow).not.toContain('--runInBand');
    expect(isolationWorkflow).toContain('npm test -- --maxWorkers=2');
    expect(isolationWorkflow).not.toContain('--runInBand');
    expect(testsJob).toContain('npm test -- --maxWorkers=2');
    expect(testsJob).not.toContain('--runInBand');
    const testsInstallIndex = testsJob.indexOf(installCommand);
    expect(testsInstallIndex).toBeGreaterThan(-1);
    for (const marker of [
      'Stage immutable evidence contract and tool',
      'Capture complete Jest file inventory',
      'npm test -- --maxWorkers=2'
    ]) {
      expect(testsJob.indexOf(marker)).toBeGreaterThan(testsInstallIndex);
    }
    expect(packageJob).toContain('package-lock.json');
    expect(packageJob).toContain(
      'npm --prefix "$package_dir" ci --ignore-scripts'
    );
    expect(packageJob.indexOf('- *install-root')).toBeGreaterThan(-1);
    expect(
      packageJob.indexOf('Install frozen selected-unit dependencies')
    ).toBeGreaterThan(packageJob.indexOf('- *install-root'));
    expect(
      packageJob.indexOf('npm --prefix "$package_dir" run build')
    ).toBeGreaterThan(
      packageJob.indexOf('Install frozen selected-unit dependencies')
    );
    expect(preflightWorkflow).toContain(
      'test "$TEST_RESULT" = success -a "$PACKAGE_RESULT" = success'
    );
    expect(preflightWorkflow).toContain(
      'Verify deterministic complete test evidence'
    );
    expect(preflightWorkflow).toContain(
      'git status --porcelain --untracked-files=no'
    );
    expect(preflightWorkflow).toContain(
      'name: Package ${{ matrix.unit }} exactly once'
    );
    expect(aggregateJob).toContain(
      'Assemble selected immutable packages without rebuilding'
    );
    expect(aggregateJob).toContain(
      'steps.immutable-artifact.outputs.artifact-digest'
    );
    expect(aggregateJob).not.toContain('npm run build');
  });

  it('injects the GitHub App identity into every Release Bus Lambda', () => {
    expect(releaseBusServerless).toContain(
      'RELEASE_BUS_GITHUB_INSTALLATION_ID: ${env:RELEASE_BUS_GITHUB_INSTALLATION_ID}'
    );
    expect(releaseBusServerless).not.toContain(
      'RELEASE_BUS_GITHUB_PRIVATE_KEY: ${env:RELEASE_BUS_GITHUB_PRIVATE_KEY}'
    );
    expect(deployWorkflow).toContain(
      'name: Resolve Release Bus GitHub App installation'
    );
    expect(deployWorkflow).toContain(
      'RELEASE_BUS_GITHUB_INSTALLATION_ID: ${{ steps.release_bus_app.outputs.installation-id }}'
    );
    expect(deployWorkflow).toContain(
      "github.event.inputs.service == 'releaseBus' || (github.event.inputs.service == 'api' && github.event.inputs.environment == 'prod')"
    );
    expect(deployWorkflow).toContain(
      'RELEASE_BUS_GITHUB_APP_ID: $appId, RELEASE_BUS_GITHUB_INSTALLATION_ID: $installationId'
    );
    expect(deployWorkflow).toContain(
      "- name: Deploy API\n        if: github.event.inputs.service == 'api'\n        env:\n          RELEASE_BUS_GITHUB_APP_ID: ${{ vars.RELEASE_BUS_GITHUB_APP_ID }}\n          RELEASE_BUS_GITHUB_INSTALLATION_ID: ${{ steps.release_bus_app.outputs.installation-id }}\n          RELEASE_BUS_MODE: ${{ vars.RELEASE_BUS_MODE || 'OFF' }}"
    );
    expect(deployWorkflow).not.toContain(
      "RELEASE_BUS_MODE: ${{ vars.RELEASE_BUS_MODE || 'OFF' }}\n          RELEASE_BUS_MODE: ${{ vars.RELEASE_BUS_MODE || 'OFF' }}"
    );
    expect(deployWorkflow).toContain(
      'del(.RELEASE_BUS_V2_BETA_ALLOWLIST, .RELEASE_BUS_GITHUB_APP_ID, .RELEASE_BUS_GITHUB_INSTALLATION_ID, .RELEASE_BUS_WORKFLOW_AUTH_TOKEN, .RELEASE_BUS_GITHUB_WEBHOOK_SECRET)'
    );
    expect(releaseBusServerless).toContain(
      "RELEASE_BUS_V2_BETA_ALLOWLIST: ${env:RELEASE_BUS_V2_BETA_ALLOWLIST, ''}"
    );
    expect(deployWorkflow).toContain(
      "RELEASE_BUS_V2_BETA_ALLOWLIST: ${{ vars.RELEASE_BUS_V2_BETA_ALLOWLIST || '' }}"
    );
  });

  it('propagates immutable Release Train contributor metadata to alerts', () => {
    expect(deployWorkflow).toContain('release_contributors:');
    expect(deployWorkflow).toContain(
      'INPUT_RELEASE_CONTRIBUTORS: ${{ github.event.inputs.release_contributors }}'
    );
    expect(deployWorkflow).toContain(
      'CI_RELEASE_TRAIN_ID: ${{ github.event.inputs.release_train_id }}'
    );
    expect(deployWorkflow).toContain(
      'CI_RELEASE_CONTRIBUTORS: ${{ github.event.inputs.release_contributors }}'
    );
    expect(deployWorkflow).toContain(
      'CI_PIPELINES_SHA: ${{ github.event.inputs.expected_sha || github.sha }}'
    );
    expect(ciWaveNotifier).toContain(
      'contributor_github_logins: releaseContributors'
    );
  });

  it('allows the shared API role to nudge only the v2 reconciler Lambda', () => {
    const policy = releaseBusServerless.slice(
      releaseBusServerless.indexOf('ReleaseBusV2ReconcilerInvokePolicy:'),
      releaseBusServerless.indexOf('ReleaseBusWorkerVersionReadPolicy:')
    );
    expect(policy).toContain('Roles:\n          - lambda-vpc-role');
    expect(policy).toContain('Action: lambda:InvokeFunction');
    expect(policy).toContain('!GetAtt V2ReconcilerLambdaFunction.Arn');
    expect(policy).not.toContain("Resource: '*'");
  });

  it('ships fail-closed base evidence controls to the worker', () => {
    expect(releaseBusServerless).toContain(
      "RELEASE_BUS_BASE_EVIDENCE_REUSE: ${env:RELEASE_BUS_BASE_EVIDENCE_REUSE, 'false'}"
    );
    expect(releaseBusServerless).toContain(
      "RELEASE_BUS_BASE_EVIDENCE_REUSE_SHADOW: ${env:RELEASE_BUS_BASE_EVIDENCE_REUSE_SHADOW, 'false'}"
    );
    expect(releaseBusServerless).toContain(
      "RELEASE_BUS_BASE_EVIDENCE_MAX_AGE_HOURS: ${env:RELEASE_BUS_BASE_EVIDENCE_MAX_AGE_HOURS, '24'}"
    );
    expect(deployWorkflow).toContain(
      "RELEASE_BUS_BASE_EVIDENCE_REUSE: ${{ vars.RELEASE_BUS_BASE_EVIDENCE_REUSE || 'false' }}"
    );
    expect(deployWorkflow).toContain('RELEASE_BUS_BASE_EVIDENCE_MAX_AGE_HOURS');
  });

  it('adds force-fresh storage before worker code relies on it', () => {
    expect(forceFreshMigration).toContain(
      'ADD COLUMN force_fresh_base_canary tinyint(1) NOT NULL DEFAULT 0'
    );
    expect(forceFreshMigration).toContain('ALGORITHM=INPLACE, LOCK=NONE');
    expect(forceFreshMigration).toContain("['ER_DUP_FIELDNAME']");
    expect(forceFreshMigration).not.toContain(
      'DROP COLUMN force_fresh_base_canary'
    );
  });

  it('stores production credentials outside Lambda configuration', () => {
    expect(deployWorkflow).toContain(
      'RELEASE_BUS_GITHUB_WEBHOOK_SECRET: ${{ secrets.RELEASE_BUS_GITHUB_WEBHOOK_SECRET }}'
    );
    expect(deployWorkflow).toContain(
      'RELEASE_BUS_WORKFLOW_AUTH_TOKEN: ${{ secrets.RELEASE_BUS_WORKFLOW_AUTH_TOKEN }}'
    );
    expect(deployWorkflow).toContain(
      'name: Store Release Bus production API credentials'
    );
    expect(deployWorkflow).toContain('--secret-id prod/lambdas');
    expect(deployWorkflow).toContain(
      'name: Verify production Lambda secret exists'
    );
    expect(deployWorkflow).toContain("'manual-production'");
    expect(deployWorkflow).toContain(
      'group: deploy-control-${{ github.event.inputs.environment }}-'
    );
    expect(deployWorkflow).toContain(
      'group: deploy-service-${{ github.event.inputs.environment }}-${{ github.event.inputs.service }}'
    );
    expect(deployWorkflow).toContain(
      'Install Node.js with cached deploy-tool downloads'
    );
    expect(deployWorkflow).toContain('Activate pinned npm');
    expect(deployWorkflow).toContain(
      "github.event.inputs.operation_key != '' && github.event.inputs.service"
    );
    expect(deployWorkflow).toContain(
      'CI_RELEASE_GROUP_SERVICES: ${{ github.event.inputs.release_group_services }}'
    );
    expect(deployWorkflow).toContain(
      'CI_RELEASE_NOTE_GROUPS: ${{ github.event.inputs.release_note_groups }}'
    );
    expect(deployWorkflow).toContain(
      'CI_RELEASE_NOTE_OPT_OUT: ${{ github.event.inputs.release_note_opt_out }}'
    );
    expect(deployWorkflow).toContain(
      'release_group_services must contain the full canonical production service set'
    );
    expect(deployWorkflow).toContain(
      'release_group_services must include the deployed service'
    );
    expect(deployWorkflow).toContain(
      'release_note_opt_out cannot include release-note metadata or a publish request'
    );
    expect(deployWorkflow).toContain(
      'release_note_groups is reserved for Release Bus v2 operations'
    );
    expect(ciWaveNotifier).toContain("targetEnvironment === 'prod'");
    expect(deployWorkflow).toContain(
      'del(.RELEASE_BUS_WORKFLOW_AUTH_TOKEN, .RELEASE_BUS_GITHUB_WEBHOOK_SECRET)'
    );
  });

  it('parallelizes only Release Bus services while preserving deployment ordering', () => {
    expect(deployWorkflow).toContain(
      "github.event.inputs.operation_key != '' && github.event.inputs.service"
    );
    expect(deployWorkflow).toContain("'manual-production'");
    expect(deployWorkflow).toContain('cancel-in-progress: false');
    expect(releaseBusWorker).toContain(
      "'staging',\n        'DEPLOYING_FRONTEND'"
    );
    expect(releaseBusWorker).toContain(
      "'prod',\n        'MERGING_FRONTEND_PRODUCTION'"
    );
    expect(
      releaseBusWorker.indexOf("if (train.status === 'DEPLOYING_BACKEND')")
    ).toBeLessThan(
      releaseBusWorker.indexOf("if (train.status === 'DEPLOYING_FRONTEND')")
    );
    expect(
      releaseBusWorker.indexOf(
        "if (train.status === 'DEPLOYING_BACKEND_PRODUCTION')"
      )
    ).toBeLessThan(
      releaseBusWorker.indexOf(
        "if (train.status === 'DEPLOYING_FRONTEND_PRODUCTION')"
      )
    );
  });

  it('loads Release Bus credentials through the standard Lambda bootstrap', () => {
    expect(releaseBusEntryPoint).toContain('doInDbContext(');
    expect(dbContext).toContain('await prepEnvironment();');
    expect(environmentLoader).toContain("const SECRET = 'prod/lambdas';");
    expect(environmentLoader).toContain('process.env[key] = secretValue[key]');
    expect(releaseBusGitHubApp).toContain(
      'process.env.RELEASE_BUS_GITHUB_PRIVATE_KEY'
    );
  });
});
