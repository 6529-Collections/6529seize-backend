import fs from 'node:fs';
import path from 'node:path';

describe('Release Bus v2 infrastructure ownership', () => {
  const source = fs.readFileSync(
    path.join(__dirname, 'serverless.yaml'),
    'utf8'
  );

  it('preserves the live v2 reconciler and emergency invoke identity', () => {
    expect(source).toContain('v2Reconciler:');
    expect(source).toContain('handler: index.v2ReconcilerHandler');
    expect(source).toContain('name: releaseBusV2Reconciler');
    expect(source).toContain('ReleaseBusV2ReconcilerInvokePolicy:');
    expect(source).toContain('rate(1 minute)');
  });

  it('keeps cleanup v2-only and has no v1 claimant or state machine', () => {
    expect(source).toContain('cleaner:');
    expect(source).toContain('handler: index.cleanerHandler');
    expect(source).toContain('name: releaseBusCleaner');
    expect(source).toContain('RELEASE_BUS_V2_BRANCH_RETENTION_DAYS');
    expect(source).not.toMatch(
      /releaseBusStarter|releaseBusWorker|ReleaseBusStateMachine|RELEASE_BUS_MODE/
    );
  });
});
