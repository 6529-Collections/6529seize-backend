import fs from 'node:fs';
import path from 'node:path';
import { subscriptionCoverageReconciliationHandler } from './index';

type DeployService = {
  readonly name: string;
  readonly verification_targets: readonly string[];
  readonly default_dependencies: readonly string[];
};

function readRepo(relativePath: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, '../..', relativePath),
    'utf8'
  );
}

describe('subscription coverage deployment ownership', () => {
  const serverless = readRepo('src/subscriptionsDaily/serverless.yaml');
  const deployConfig = JSON.parse(
    readRepo('src/config/deploy-services.json')
  ) as { readonly services: readonly DeployService[] };
  const subscriptionsDaily = deployConfig.services.find(
    (service) => service.name === 'subscriptionsDaily'
  );

  it('exports reconciliation as a distinct handler in the daily bundle', () => {
    expect(typeof subscriptionCoverageReconciliationHandler).toBe('function');
    expect(serverless).toContain(
      'handler: index.subscriptionCoverageReconciliationHandler'
    );
    expect(serverless).toContain(
      'name: subscriptionCoverageReconciliationLoop'
    );
    expect(serverless).toContain('memorySize: 1024');
    expect(serverless).toContain('rate: rate(1 minute)');
    expect(serverless).toContain('rate: rate(1 hour)');
  });

  it('deploys and verifies both Lambdas through the existing unit', () => {
    expect(subscriptionsDaily).toEqual(
      expect.objectContaining({
        verification_targets: [
          'subscriptionsDaily',
          'subscriptionCoverageReconciliationLoop'
        ],
        default_dependencies: [
          'api',
          'dbMigrationsLoop',
          'ownersBalancesLoop',
          'pushNotificationsHandler',
          'subscriptionsTopUpLoop',
          'transactionsProcessingLoop'
        ]
      })
    );
    expect(
      deployConfig.services.some(
        (service) => service.name === 'subscriptionCoverageReconciliationLoop'
      )
    ).toBe(false);
  });

  it('does not retain a standalone package or manual deploy unit', () => {
    expect(
      fs.existsSync(
        path.resolve(
          __dirname,
          '../subscriptionCoverageReconciliationLoop/package.json'
        )
      )
    ).toBe(false);
    expect(
      fs.existsSync(
        path.resolve(
          __dirname,
          '../subscriptionCoverageReconciliationLoop/serverless.yaml'
        )
      )
    ).toBe(false);
    expect(readRepo('scripts/deploy-all-lambdas.sh')).not.toMatch(
      /^\s+subscriptionCoverageReconciliationLoop\s*$/m
    );
  });
});
