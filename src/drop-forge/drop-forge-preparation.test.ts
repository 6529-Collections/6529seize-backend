import { prepareDistributionPhase } from '@/drop-forge/drop-forge.preparation';
import {
  dropForgePreparationRepository,
  PreparationResults
} from '@/drop-forge/drop-forge.preparation.repository';
import * as emma from '@/api/subscriptions/api.subscriptions.allowlist';
import * as distributions from '@/api/distributions/api.distributions.service';
import { RequestContext } from '@/request.context';

jest.mock('@/api/subscriptions/api.subscriptions.allowlist');
jest.mock('@/api/distributions/api.distributions.service');
jest.mock('@/redis', () => ({
  evictRedisCacheForPathWithTimeout: jest.fn().mockResolvedValue(undefined)
}));

const result = {
  phase: 'Phase 0',
  airdrops: [],
  airdrops_unconsolidated: [],
  allowlists: []
};
describe('Drop Forge phase network and replay boundary', () => {
  let cache: PreparationResults;
  let locked: boolean;
  beforeEach(() => {
    cache = {};
    locked = false;
    jest
      .spyOn(dropForgePreparationRepository, 'findResult')
      .mockImplementation(async (_, _claim, key) => cache[key] ?? null);
    jest
      .spyOn(dropForgePreparationRepository, 'run')
      .mockImplementation(
        async <T>(
          _contract: string,
          _claim: number,
          fn: (results: PreparationResults, ctx: RequestContext) => Promise<T>,
          ctx: RequestContext
        ) => {
          locked = true;
          try {
            return await fn(cache, ctx);
          } finally {
            locked = false;
          }
        }
      );
    jest.mocked(emma.validateDistribution).mockImplementation(async () => {
      expect(locked).toBe(false);
      return { valid: true, allowlist_id: 'allowlist' };
    });
    jest.mocked(emma.fetchPhaseName).mockImplementation(async () => {
      expect(locked).toBe(false);
      return 'Phase 0';
    });
    jest.mocked(emma.fetchPhaseResults).mockImplementation(async () => {
      expect(locked).toBe(false);
      return [];
    });
    jest.mocked(emma.splitAllowlistResults).mockImplementation(async () => {
      expect(locked).toBe(true);
      return { airdrops: [], airdrops_unconsolidated: [], allowlists: [] };
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });
  it('fetches outside the preparation lock and publishes inside it', async () => {
    expect(
      await prepareDistributionPhase('contract', 1, 'plan', 'phase', 'auth')
    ).toEqual(result);
    expect(distributions.populateDistribution).toHaveBeenCalledTimes(1);
  });
  it('recovers a committed result without requiring EMMA to be available', async () => {
    cache[JSON.stringify(['plan', 'phase'])] = result;
    jest
      .mocked(emma.validateDistribution)
      .mockRejectedValue(new Error('EMMA offline'));
    expect(
      await prepareDistributionPhase('contract', 1, 'plan', 'phase', 'auth')
    ).toEqual(result);
    expect(emma.validateDistribution).not.toHaveBeenCalled();
    expect(distributions.populateDistribution).not.toHaveBeenCalled();
  });
  it('returns a concurrent winner rather than duplicating the publication', async () => {
    jest.mocked(emma.fetchPhaseResults).mockImplementation(async () => {
      cache[JSON.stringify(['plan', 'phase'])] = result;
      return [];
    });
    expect(
      await prepareDistributionPhase('contract', 1, 'plan', 'phase', 'auth')
    ).toEqual(result);
    expect(distributions.populateDistribution).not.toHaveBeenCalled();
  });
  it('requires a fresh request if reset removes the result between reads', async () => {
    jest
      .spyOn(dropForgePreparationRepository, 'findResult')
      .mockResolvedValue(result);
    await expect(
      prepareDistributionPhase('contract', 1, 'plan', 'phase', 'auth')
    ).rejects.toThrow('reset during');
    expect(emma.validateDistribution).not.toHaveBeenCalled();
    expect(distributions.populateDistribution).not.toHaveBeenCalled();
  });
});
