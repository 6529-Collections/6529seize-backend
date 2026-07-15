import { buildReleaseOperationKey } from '@/releaseBus/release-bus.idempotency';

describe('release operation idempotency', () => {
  it('builds stable keys for retries', () => {
    const input = {
      trainId: 'train-1',
      revision: 2,
      operation: 'deploy',
      repository: 'backend',
      environment: 'prod',
      service: 'api',
      expectedSha: 'a'.repeat(40)
    };
    expect(buildReleaseOperationKey(input)).toBe(
      buildReleaseOperationKey(input)
    );
    expect(buildReleaseOperationKey(input).length).toBeLessThan(180);
    expect(
      buildReleaseOperationKey({ ...input, expectedSha: 'b'.repeat(40) })
    ).not.toBe(buildReleaseOperationKey(input));
  });

  it('rejects unsafe components', () => {
    expect(() =>
      buildReleaseOperationKey({
        trainId: 'train:bad',
        revision: 1,
        operation: 'deploy'
      })
    ).toThrow('Unsafe');
  });
});
