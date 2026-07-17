import { readFileSync } from 'node:fs';
import stateMachine from '@/releaseBus/state-machine.asl.json';
import { e2eSourceRef } from '@/releaseBus/worker';

const deployWorkflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const releaseBusServerless = readFileSync(
  'src/releaseBus/serverless.yaml',
  'utf8'
);
const releaseBusEntryPoint = readFileSync('src/releaseBus/index.ts', 'utf8');
const dbContext = readFileSync('src/secrets.ts', 'utf8');
const environmentLoader = readFileSync('src/env.ts', 'utf8');
const releaseBusGitHubApp = readFileSync(
  'src/releaseBus/release-bus.github-app.ts',
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
    expect(deployWorkflow).toContain(
      "github.event.inputs.environment == 'prod' && 'production'"
    );
    expect(deployWorkflow).toContain(
      'del(.RELEASE_BUS_WORKFLOW_AUTH_TOKEN, .RELEASE_BUS_GITHUB_WEBHOOK_SECRET)'
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
