import fetch from 'node-fetch';
import {
  fetchDistributionOperations,
  fetchPhaseName,
  fetchPhaseResults
} from './api.subscriptions.allowlist';
import {
  PreparationAuthRequired,
  withPreparationAuth
} from '@/drop-forge/drop-forge.preparation-auth';

jest.mock('node-fetch', () => jest.fn());
afterEach(() => jest.resetAllMocks());
it.each([401, 403])(
  'recognizes rejected operator access even when EMMA returns no JSON body (%i)',
  async (status) => {
    const json = jest.fn().mockRejectedValue(new Error('not JSON'));
    jest
      .mocked(fetch)
      .mockResolvedValue({ status, json } as unknown as Awaited<
        ReturnType<typeof fetch>
      >);
    const operations: Array<() => Promise<unknown>> = [
      () => fetchDistributionOperations('Bearer operator', 'plan'),
      () => fetchPhaseName('Bearer operator', 'plan', 'phase'),
      () => fetchPhaseResults('Bearer operator', 'plan', 'phase')
    ];
    for (const operation of operations)
      await expect(withPreparationAuth(operation)).rejects.toThrow(
        PreparationAuthRequired
      );
    expect(json).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: {
          accept: 'application/json',
          Authorization: 'Bearer operator'
        }
      })
    );
  }
);
