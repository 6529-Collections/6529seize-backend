jest.mock('@/release-notes/release-digest.service', () => ({
  releaseDigestService: { publish: jest.fn() }
}));
jest.mock('@/secrets', () => ({
  doInDbContext: jest.fn(async (fn: () => Promise<unknown>) => fn())
}));
jest.mock('@/sentry.context', () => ({
  wrapLambdaHandler: (fn: unknown) => fn
}));

import catalog from '@/config/deploy-services.json';
import { releaseDigestService } from '@/release-notes/release-digest.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { resolveReleaseDigestRequest, runReleaseDigest } from './index';

describe('releaseDigestLoop', () => {
  const originalStage = process.env.RELEASE_DIGEST_STAGE;

  afterEach(() => {
    if (originalStage === undefined) {
      delete process.env.RELEASE_DIGEST_STAGE;
    } else {
      process.env.RELEASE_DIGEST_STAGE = originalStage;
    }
    jest.clearAllMocks();
  });

  it('keys scheduled runs by the UTC event date and uses the event time as cutoff', () => {
    expect(
      resolveReleaseDigestRequest({
        source: 'aws.events',
        'detail-type': 'Scheduled Event',
        time: '2026-10-12T23:30:00Z'
      })
    ).toEqual({
      digestKey: '2026-10-12',
      cutoff: Date.parse('2026-10-12T23:30:00Z'),
      dryRun: false
    });
    expect(() =>
      resolveReleaseDigestRequest({
        source: 'aws.events',
        'detail-type': 'Scheduled Event'
      })
    ).toThrow('invalid event timestamp');
  });

  it('accepts manual digest keys and dry runs', () => {
    const now = Date.parse('2026-10-13T08:00:00Z');
    expect(resolveReleaseDigestRequest({}, now)).toEqual({
      digestKey: '2026-10-13',
      cutoff: now,
      dryRun: false
    });
    expect(
      resolveReleaseDigestRequest(
        { digest_key: '2026-10-12-retry', dry_run: true },
        now
      )
    ).toEqual({ digestKey: '2026-10-12-retry', cutoff: now, dryRun: true });
  });

  it('only publishes from the production stage', async () => {
    process.env.RELEASE_DIGEST_STAGE = 'staging';
    await expect(runReleaseDigest({})).resolves.toEqual({
      status: 'not-production'
    });
    expect(releaseDigestService.publish).not.toHaveBeenCalled();

    process.env.RELEASE_DIGEST_STAGE = 'prod';
    (releaseDigestService.publish as jest.Mock).mockResolvedValue({
      status: 'nothing-to-publish'
    });
    await expect(runReleaseDigest({})).resolves.toEqual({
      status: 'nothing-to-publish'
    });
  });

  it('deploys only to production as a serialized daily 23:30 UTC job', () => {
    const service = catalog.services.find(
      (entry) => entry.name === 'releaseDigestLoop'
    );
    expect(service?.allowed_environments).toEqual(['prod']);
    const yaml = parse(
      readFileSync(join(__dirname, 'serverless.yaml'), 'utf8')
    );
    const fn = yaml.functions.releaseDigestLoop;
    expect(fn.reservedConcurrency).toBe(1);
    expect(fn.events).toEqual([
      { schedule: { rate: 'cron(30 23 * * ? *)', enabled: true } }
    ]);
    expect(fn.environment.RELEASE_DIGEST_STAGE).toBe(
      '${opt:stage, self:provider.stage}'
    );
    expect(yaml.provider.timeout).toBe(600);
  });
});
