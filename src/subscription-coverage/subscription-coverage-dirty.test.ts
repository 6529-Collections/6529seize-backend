import { subscriptionCoverageRepository } from './subscription-coverage.repository';
import {
  markSubscriptionCoverageDirty,
  markSubscriptionCoverageDirtyForDemonstratedIntent
} from './subscription-coverage-dirty';

jest.mock('./subscription-coverage.repository', () => ({
  subscriptionCoverageRepository: {
    findDemonstratedIntentKeys: jest.fn(),
    markDirty: jest.fn()
  }
}));

const repository = subscriptionCoverageRepository as unknown as {
  findDemonstratedIntentKeys: jest.Mock;
  markDirty: jest.Mock;
};

describe('subscription coverage dirty markers', () => {
  beforeEach(() => {
    repository.findDemonstratedIntentKeys.mockReset();
    repository.markDirty.mockReset();
  });

  it('normalizes and persists dirty keys in bounded batches', async () => {
    repository.markDirty
      .mockRejectedValueOnce(new Error('first batch unavailable'))
      .mockResolvedValue(undefined);
    const keys = Array.from(
      { length: 1_001 },
      (_unused, index) => `KEY-${index}`
    );

    await markSubscriptionCoverageDirty(
      [...keys, ' key-1000 ', ''],
      'ELIGIBILITY_CHANGED'
    );

    expect(repository.markDirty).toHaveBeenCalledTimes(3);
    expect(
      repository.markDirty.mock.calls.map(([batch]) => batch.length)
    ).toEqual([500, 500, 1]);
    expect(repository.markDirty.mock.calls[2][0]).toEqual(['key-1000']);
  });

  it('continues filtering later batches when one intent lookup fails', async () => {
    repository.findDemonstratedIntentKeys
      .mockRejectedValueOnce(new Error('first batch unavailable'))
      .mockImplementation(async (keys: readonly string[]) => keys.slice(0, 1));
    repository.markDirty.mockResolvedValue(undefined);
    const keys = Array.from(
      { length: 1_001 },
      (_unused, index) => `key-${index}`
    );

    await markSubscriptionCoverageDirtyForDemonstratedIntent(
      keys,
      'ELIGIBILITY_CHANGED'
    );

    expect(repository.findDemonstratedIntentKeys).toHaveBeenCalledTimes(3);
    expect(repository.markDirty).toHaveBeenCalledTimes(2);
    expect(repository.markDirty.mock.calls.map(([batch]) => batch)).toEqual([
      ['key-500'],
      ['key-1000']
    ]);
  });
});
