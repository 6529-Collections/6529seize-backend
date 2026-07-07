const mockRecordXtdhGranted = jest.fn();

jest.mock('../metrics/MetricsRecorder', () => ({
  metricsRecorder: {
    recordXtdhGranted: mockRecordXtdhGranted
  }
}));

import { RequestContext } from '../request.context';
import { RecalculateXTdhStatsUseCase } from './recalculate-xtdh-stats.use-case';

describe('RecalculateXTdhStatsUseCase', () => {
  const makeRepository = () => ({
    getStatsMetaOrNull: jest.fn().mockResolvedValue({ active_slot: 'a' }),
    refillXTdhGrantStats: jest.fn().mockResolvedValue(undefined),
    refillXTdhTokenStats: jest.fn().mockResolvedValue(undefined),
    getTotalGrantedXTdh: jest.fn().mockResolvedValue(6529),
    markStatsJustReindexed: jest.fn().mockResolvedValue(undefined)
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordXtdhGranted.mockResolvedValue(undefined);
  });

  it('rebuilds the inactive slot before activating it', async () => {
    const order: string[] = [];
    const repository = makeRepository();
    repository.getStatsMetaOrNull.mockImplementationOnce(async () => {
      order.push('meta');
      return { active_slot: 'a' };
    });
    repository.refillXTdhGrantStats.mockImplementationOnce(async ({ slot }) => {
      order.push(`grant:${slot}`);
    });
    repository.refillXTdhTokenStats.mockImplementationOnce(async ({ slot }) => {
      order.push(`token:${slot}`);
    });
    repository.getTotalGrantedXTdh.mockImplementationOnce(async ({ slot }) => {
      order.push(`total:${slot}`);
      return 6529;
    });
    repository.markStatsJustReindexed.mockImplementationOnce(
      async ({ slot }) => {
        order.push(`activate:${slot}`);
      }
    );

    await new RecalculateXTdhStatsUseCase(repository as any).handle(
      {} as RequestContext
    );

    expect(repository.refillXTdhGrantStats).toHaveBeenCalledWith(
      { slot: 'b' },
      expect.any(Object)
    );
    expect(repository.refillXTdhTokenStats).toHaveBeenCalledWith(
      { slot: 'b' },
      expect.any(Object)
    );
    expect(repository.markStatsJustReindexed).toHaveBeenCalledWith(
      { slot: 'b' },
      expect.any(Object)
    );
    expect(order).toEqual([
      'meta',
      'grant:b',
      'token:b',
      'total:b',
      'activate:b'
    ]);
  });

  it('does not activate a slot when rebuilding token stats fails', async () => {
    const repository = makeRepository();
    repository.refillXTdhTokenStats.mockRejectedValueOnce(
      new Error('token rebuild failed')
    );

    await expect(
      new RecalculateXTdhStatsUseCase(repository as any).handle(
        {} as RequestContext
      )
    ).rejects.toThrow('token rebuild failed');

    expect(repository.markStatsJustReindexed).not.toHaveBeenCalled();
  });
});
