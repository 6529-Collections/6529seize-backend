const mockSqsSend = jest.fn();
const mockGetStringOrNull = jest.fn();
const mockIsXTdhEnabled = jest.fn();
const mockBulkCreateIdentities = jest.fn();
const mockUpdateAllIdentitiesLevels = jest.fn();

jest.mock('../sqs', () => ({
  DEFAULT_MESSAGE_GROUP_ID: 'default',
  sqs: {
    send: mockSqsSend
  }
}));

jest.mock('../env', () => ({
  env: {
    getStringOrNull: mockGetStringOrNull
  }
}));

jest.mock('../app-features', () => ({
  appFeatures: {
    isXTdhEnabled: mockIsXTdhEnabled
  }
}));

jest.mock('../api-serverless/src/identities/identities.service', () => ({
  identitiesService: {
    bulkCreateIdentities: mockBulkCreateIdentities
  }
}));

jest.mock('../identity', () => ({
  identityConsolidationEffects: {
    updateAllIdentitiesLevels: mockUpdateAllIdentitiesLevels
  }
}));

import { RequestContext } from '../request.context';
import { RecalculateXTdhUseCase } from './recalculate-xtdh.use-case';
import { XTDH_LOOP_PHASE } from './xtdh-loop-phase';

describe('RecalculateXTdhUseCase phase handling', () => {
  const connection = { connection: {} };

  const makeRepository = () => ({
    executeNativeQueriesInTransaction: jest.fn(
      async (callback: (connection: unknown) => Promise<void>) => {
        await callback(connection);
      }
    ),
    getWalletsWithoutIdentities: jest.fn().mockResolvedValue([]),
    updateProducedXTDH: jest.fn().mockResolvedValue(undefined),
    updateAllGrantedXTdhs: jest.fn().mockResolvedValue(undefined),
    deleteXTdhState: jest.fn().mockResolvedValue(undefined),
    updateAllXTdhsWithGrantedPart: jest.fn().mockResolvedValue(undefined),
    giveOutUngrantedXTdh: jest.fn().mockResolvedValue(undefined),
    updateXtdhRate: jest.fn().mockResolvedValue(undefined)
  });

  const makeUseCase = () => {
    const repository = makeRepository();
    const reReviewRates = { handle: jest.fn().mockResolvedValue(undefined) };
    const stats = { handle: jest.fn().mockResolvedValue(undefined) };
    const useCase = new RecalculateXTdhUseCase(
      repository as any,
      reReviewRates as any,
      stats as any
    );
    return { repository, reReviewRates, stats, useCase };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetStringOrNull.mockReturnValue(
      'https://sqs.us-east-1.amazonaws.com/123/xtdh-start.fifo'
    );
    mockIsXTdhEnabled.mockReturnValue(true);
    mockSqsSend.mockResolvedValue({});
    mockUpdateAllIdentitiesLevels.mockResolvedValue(undefined);
  });

  it('enqueues stats phase after the universe transaction commits', async () => {
    const order: string[] = [];
    const { repository, stats, useCase } = makeUseCase();
    repository.executeNativeQueriesInTransaction.mockImplementationOnce(
      async (callback: (connection: unknown) => Promise<void>) => {
        order.push('transaction-start');
        await callback(connection);
        order.push('transaction-commit');
      }
    );
    mockSqsSend.mockImplementationOnce(async () => {
      order.push('stats-enqueued');
      return {};
    });

    await useCase.handleUniversePhase({} as RequestContext, {
      messageGroupId: 'tdh-fifo-group'
    });

    expect(stats.handle).not.toHaveBeenCalled();
    expect(mockSqsSend).toHaveBeenCalledWith({
      queue: 'https://sqs.us-east-1.amazonaws.com/123/xtdh-start.fifo',
      messageGroupId: 'tdh-fifo-group',
      message: {
        phase: XTDH_LOOP_PHASE.STATS,
        queued_at_ms: expect.any(Number)
      }
    });
    expect(order).toEqual([
      'transaction-start',
      'transaction-commit',
      'stats-enqueued'
    ]);
  });

  it('uses the default FIFO message group for stats when no source group resolves', async () => {
    const { useCase } = makeUseCase();

    await useCase.handleUniversePhase({} as RequestContext);

    expect(mockSqsSend).toHaveBeenCalledWith({
      queue: 'https://sqs.us-east-1.amazonaws.com/123/xtdh-start.fifo',
      messageGroupId: 'default',
      message: {
        phase: XTDH_LOOP_PHASE.STATS,
        queued_at_ms: expect.any(Number)
      }
    });
  });

  it('does not enqueue stats when the universe transaction fails', async () => {
    const { repository, useCase } = makeUseCase();
    repository.executeNativeQueriesInTransaction.mockRejectedValueOnce(
      new Error('transaction failed')
    );

    await expect(
      useCase.handleUniversePhase({} as RequestContext)
    ).rejects.toThrow('transaction failed');

    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('fails before the universe transaction when stats phase queue url is missing', async () => {
    const { repository, useCase } = makeUseCase();
    mockGetStringOrNull.mockReturnValue(null);

    await expect(
      useCase.handleUniversePhase({} as RequestContext)
    ).rejects.toThrow(
      'XTDH_LOOP_QUEUE_URL not configured. Can not enqueue xTDH stats phase.'
    );

    expect(repository.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('does not enqueue stats when too little lambda time remains', async () => {
    const { repository, useCase } = makeUseCase();

    await expect(
      useCase.handleUniversePhase({} as RequestContext, {
        getRemainingTimeInMillis: () => 1_000
      })
    ).rejects.toThrow(
      'Not enough Lambda time remaining to enqueue xTDH stats phase after universe phase.'
    );

    expect(repository.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(
      1
    );
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('rejects universe phase when a caller-managed transaction is open', async () => {
    const { repository, useCase } = makeUseCase();

    await expect(
      useCase.handleUniversePhase({ connection } as RequestContext)
    ).rejects.toThrow(
      'handleUniversePhase must own the transaction before enqueueing xTDH stats phase'
    );

    expect(repository.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
    expect(mockSqsSend).not.toHaveBeenCalled();
  });

  it('enqueues direct universe wakeups with a unique FIFO body', async () => {
    const { useCase } = makeUseCase();

    await useCase.activateLoop({} as RequestContext);

    expect(mockSqsSend).toHaveBeenCalledWith({
      queue: 'https://sqs.us-east-1.amazonaws.com/123/xtdh-start.fifo',
      message: {
        phase: XTDH_LOOP_PHASE.UNIVERSE,
        queued_at_ms: expect.any(Number)
      }
    });
  });

  it('runs stats phase without recalculating the universe', async () => {
    const { repository, stats, useCase } = makeUseCase();

    await useCase.handleStatsPhase({} as RequestContext);

    expect(stats.handle).toHaveBeenCalledTimes(1);
    expect(repository.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
    expect(mockSqsSend).not.toHaveBeenCalled();
  });
});
