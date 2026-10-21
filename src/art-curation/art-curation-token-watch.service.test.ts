jest.mock('@/competitions/competition-entry.repository', () => ({
  competitionEntryRepository: {
    lockDropMemberships: jest.fn().mockResolvedValue([])
  }
}));
jest.mock('@/competitions/competition.repository', () => ({
  competitionRepository: {
    findCompetitionRecordById: jest.fn(),
    findCapabilities: jest.fn(),
    listCompetitionRecordsForWave: jest.fn().mockResolvedValue([])
  }
}));
jest.mock('@/competitions/competition-execution.router', () => ({
  competitionExecutionRouter: {
    shouldUseLegacyWaveExecution: jest.fn().mockResolvedValue(true)
  }
}));
import { ArtCurationTokenWatchService } from '@/art-curation/art-curation-token-watch.service';
import { DropType } from '@/entities/IDrop';
import { competitionEntryRepository } from '@/competitions/competition-entry.repository';
import { competitionRepository } from '@/competitions/competition.repository';
import { CompetitionCapability } from '@/entities/ICompetition';
import { competitionExecutionRouter } from '@/competitions/competition-execution.router';

describe('ArtCurationTokenWatchService', () => {
  const baseCtx = {};

  beforeEach(() => {
    process.env.ART_CURATIONS_WAVE_ID = 'wave-1';
    jest
      .mocked(competitionEntryRepository.lockDropMemberships)
      .mockResolvedValue([]);
    jest
      .mocked(competitionExecutionRouter.shouldUseLegacyWaveExecution)
      .mockResolvedValue(true);
  });

  afterEach(() => {
    delete process.env.ART_CURATIONS_WAVE_ID;
    delete process.env.ART_CURATIONS_WATCH_MAX_PER_CYCLE;
    jest.resetAllMocks();
  });

  function createService({
    findByDropId = jest.fn().mockResolvedValue(null),
    detachDropFromWatch = jest.fn().mockResolvedValue(undefined),
    upsertActiveWatchAndGet = jest.fn(),
    upsertDropWatch = jest.fn(),
    cancelIfEmpty = jest.fn().mockResolvedValue(undefined),
    lockNextActiveWatch = jest.fn(),
    unlock = jest.fn().mockResolvedValue(undefined),
    markChecked = jest.fn().mockResolvedValue(undefined),
    markResolved = jest.fn().mockResolvedValue(undefined),
    snapshotSubmissionState = jest.fn(),
    findFirstTransfer = jest.fn(),
    findTransferPrice = jest.fn().mockResolvedValue({
      amountRaw: null,
      amount: null,
      currency: null
    }),
    getCurrentVoterStatesForDrops = jest.fn().mockResolvedValue([]),
    insertWinnerDropsVoterVotes = jest.fn().mockResolvedValue(undefined),
    deleteStaleLeaderboardEntries = jest.fn().mockResolvedValue(undefined),
    executeNativeQueriesInTransaction = jest
      .fn()
      .mockImplementation(async (callback) => await callback({})),
    resyncParticipatoryDropCountsForWaves = jest
      .fn()
      .mockResolvedValue(undefined),
    insertDecisionIfMissing = jest.fn().mockResolvedValue(undefined),
    insertDecisionWinners = jest.fn().mockResolvedValue(undefined),
    updateDropsToWinners = jest.fn().mockResolvedValue(undefined),
    deleteDropsRanks = jest.fn().mockResolvedValue(undefined),
    calculateFinalVoteForDrop = jest.fn().mockReturnValue(0)
  } = {}) {
    return {
      service: new ArtCurationTokenWatchService(
        {
          findByDropId,
          detachDropFromWatch,
          upsertActiveWatchAndGet,
          upsertDropWatch,
          cancelIfEmpty,
          lockNextActiveWatch,
          unlock,
          markChecked,
          markResolved
        } as any,
        {
          snapshotSubmissionState,
          findFirstTransfer,
          findTransferPrice
        } as any,
        {
          getCurrentVoterStatesForDrops,
          insertWinnerDropsVoterVotes,
          deleteStaleLeaderboardEntriesForWave: deleteStaleLeaderboardEntries
        } as any,
        {
          executeNativeQueriesInTransaction,
          resyncParticipatoryDropCountsForWaves
        } as any,
        {
          insertDecisionIfMissing,
          insertDecisionWinners,
          updateDropsToWinners,
          deleteDropsRanks
        } as any,
        {
          calculateFinalVoteForDrop
        } as any
      ),
      mocks: {
        findByDropId,
        detachDropFromWatch,
        upsertActiveWatchAndGet,
        upsertDropWatch,
        cancelIfEmpty,
        lockNextActiveWatch,
        unlock,
        markChecked,
        markResolved,
        snapshotSubmissionState,
        findFirstTransfer,
        findTransferPrice,
        getCurrentVoterStatesForDrops,
        insertWinnerDropsVoterVotes,
        deleteStaleLeaderboardEntries,
        executeNativeQueriesInTransaction,
        resyncParticipatoryDropCountsForWaves,
        insertDecisionIfMissing,
        insertDecisionWinners,
        updateDropsToWinners,
        deleteDropsRanks,
        calculateFinalVoteForDrop
      }
    };
  }

  it('detaches a previous watch when an updated drop no longer has exactly one link', async () => {
    const { service, mocks } = createService({
      findByDropId: jest.fn().mockResolvedValue({
        watch_id: 'watch-1'
      })
    });

    await service.registerDrop(
      {
        dropId: 'drop-1',
        waveId: 'wave-1',
        dropType: DropType.PARTICIPATORY,
        links: []
      },
      baseCtx as any
    );

    expect(mocks.detachDropFromWatch).toHaveBeenCalledWith('drop-1', baseCtx);
    expect(mocks.upsertActiveWatchAndGet).not.toHaveBeenCalled();
    expect(mocks.upsertDropWatch).not.toHaveBeenCalled();
  });

  it('moves an updated drop to a new watch and cancels the previous watch when empty', async () => {
    const { service, mocks } = createService({
      findByDropId: jest.fn().mockResolvedValue({
        watch_id: 'watch-old'
      }),
      snapshotSubmissionState: jest.fn().mockResolvedValue({
        blockNumber: 123,
        observedAt: 456,
        owner: '0x0000000000000000000000000000000000000001',
        isTrackable: true
      }),
      upsertActiveWatchAndGet: jest.fn().mockResolvedValue({
        id: 'watch-new'
      }),
      upsertDropWatch: jest.fn().mockResolvedValue(undefined)
    });

    await service.registerDrop(
      {
        dropId: 'drop-1',
        waveId: 'wave-1',
        dropType: DropType.PARTICIPATORY,
        links: [
          {
            url_in_text:
              'https://opensea.io/assets/ethereum/0x1111111111111111111111111111111111111111/1',
            canonical_id:
              'OPENSEA:eth:0x1111111111111111111111111111111111111111:1'
          }
        ]
      },
      baseCtx as any
    );

    expect(mocks.snapshotSubmissionState).toHaveBeenCalledWith({
      contract: '0x1111111111111111111111111111111111111111',
      tokenId: '1'
    });
    expect(mocks.upsertDropWatch).toHaveBeenCalled();
    expect(mocks.cancelIfEmpty).toHaveBeenCalledWith('watch-old', baseCtx);
  });

  it.each([
    {
      dropType: DropType.PARTICIPATORY,
      capabilities: [CompetitionCapability.CURATION],
      expected: true
    },
    { dropType: DropType.PARTICIPATORY, capabilities: [], expected: false },
    {
      dropType: DropType.CHAT,
      capabilities: [CompetitionCapability.CURATION],
      expected: false
    }
  ])(
    'registers only explicit native CURATION entry content ($dropType, $capabilities)',
    async ({ dropType, capabilities, expected }) => {
      delete process.env.ART_CURATIONS_WAVE_ID;
      jest
        .mocked(competitionRepository.findCompetitionRecordById)
        .mockResolvedValue({
          id: 'curation',
          wave_id: 'wave-1',
          storage_mode: 'NATIVE'
        } as never);
      jest
        .mocked(competitionRepository.findCapabilities)
        .mockResolvedValue(capabilities);
      const { service, mocks } = createService();
      await service.registerDrop(
        {
          dropId: 'drop-1',
          waveId: 'wave-1',
          dropType,
          competitionId: 'curation',
          links: []
        },
        baseCtx
      );
      expect(mocks.findByDropId).toHaveBeenCalledTimes(expected ? 1 : 0);
      expect(
        competitionExecutionRouter.shouldUseLegacyWaveExecution
      ).not.toHaveBeenCalled();
    }
  );

  it('registers an edited actual ACTIVE CURATION entry without inferring a primary owner', async () => {
    jest
      .mocked(competitionExecutionRouter.shouldUseLegacyWaveExecution)
      .mockResolvedValue(false);
    jest
      .mocked(competitionEntryRepository.lockDropMemberships)
      .mockResolvedValue([
        {
          competition_id: 'curation',
          wave_id: 'wave-1',
          status: 'ACTIVE'
        } as never
      ]);
    jest
      .mocked(competitionRepository.findCompetitionRecordById)
      .mockResolvedValue({
        id: 'curation',
        wave_id: 'wave-1',
        storage_mode: 'NATIVE'
      } as never);
    jest
      .mocked(competitionRepository.findCapabilities)
      .mockResolvedValue([CompetitionCapability.CURATION]);
    const { service, mocks } = createService();
    await service.registerDrop(
      {
        dropId: 'drop-1',
        waveId: 'wave-1',
        dropType: DropType.PARTICIPATORY,
        links: []
      },
      baseCtx
    );
    expect(mocks.findByDropId).toHaveBeenCalledTimes(1);
  });

  it('does not implicitly select native CURATION for shared content without a permit', async () => {
    jest
      .mocked(competitionExecutionRouter.shouldUseLegacyWaveExecution)
      .mockResolvedValue(false);
    const { service, mocks } = createService();
    await service.registerDrop(
      {
        dropId: 'drop-1',
        waveId: 'wave-1',
        dropType: DropType.PARTICIPATORY,
        links: []
      },
      baseCtx
    );
    expect(mocks.findByDropId).not.toHaveBeenCalled();
    expect(
      competitionRepository.findCompetitionRecordById
    ).not.toHaveBeenCalled();
  });

  it('does not retry the same watch within one cycle when no safe blocks are available yet', async () => {
    process.env.ART_CURATIONS_WATCH_MAX_PER_CYCLE = '3';

    const watch = {
      id: 'watch-1',
      contract: '0x1111111111111111111111111111111111111111',
      token_id: '1',
      last_checked_block: 123
    };
    const lockNextActiveWatch = jest
      .fn()
      .mockImplementation(
        ({ excludedWatchIds = [] }: { excludedWatchIds?: string[] }) =>
          Promise.resolve(
            excludedWatchIds.includes(watch.id) ? null : (watch as any)
          )
      );
    const unlock = jest.fn().mockResolvedValue(undefined);
    const findFirstTransfer = jest.fn().mockResolvedValue({
      checkedThroughBlock: 123,
      event: null
    });
    const { service, mocks } = createService({
      lockNextActiveWatch,
      unlock,
      findFirstTransfer
    });

    const processed = await service.processCycle({
      start: jest.fn(),
      stop: jest.fn()
    } as any);

    expect(processed).toBe(1);
    expect(mocks.findFirstTransfer).toHaveBeenCalledTimes(1);
    expect(mocks.unlock).toHaveBeenCalledWith('watch-1', expect.any(Object));
    expect(mocks.lockNextActiveWatch).toHaveBeenCalledTimes(2);
    expect(mocks.lockNextActiveWatch.mock.calls[1][0]).toMatchObject({
      excludedWatchIds: ['watch-1']
    });
  });

  it('persists the best-effort transfer price when resolving a watch', async () => {
    const { service, mocks } = createService();

    await (service as any).convertDropsToWinnersForTrigger(
      {
        watch: {
          id: 'watch-1'
        },
        wave: {
          id: 'wave-1',
          time_lock_ms: null
        },
        dropIds: ['drop-1'],
        event: {
          from: '0x0000000000000000000000000000000000000001',
          to: '0x0000000000000000000000000000000000000002',
          txHash: '0xtx',
          blockNumber: 123,
          logIndex: 4,
          timestampMs: 999
        },
        transferPrice: {
          amountRaw: '2000000000000000000',
          amount: 2,
          currency: '0x0000000000000000000000000000000000000000'
        }
      },
      baseCtx as any
    );

    expect(mocks.insertDecisionIfMissing).toHaveBeenCalledWith(
      {
        decision_time: 999,
        wave_id: 'wave-1'
      },
      baseCtx
    );
    expect(mocks.markResolved).toHaveBeenCalledWith(
      {
        watchId: 'watch-1',
        resolvedAt: expect.any(Number),
        triggerTxHash: '0xtx',
        triggerBlockNumber: 123,
        triggerLogIndex: 4,
        triggerTime: 999,
        triggerPriceRaw: '2000000000000000000',
        triggerPrice: 2,
        triggerPriceCurrency: '0x0000000000000000000000000000000000000000'
      },
      baseCtx
    );
  });

  it('persists a null transfer price when price attribution is unavailable', async () => {
    const { service, mocks } = createService();

    await (service as any).convertDropsToWinnersForTrigger(
      {
        watch: {
          id: 'watch-1'
        },
        wave: {
          id: 'wave-1',
          time_lock_ms: null
        },
        dropIds: ['drop-1'],
        event: {
          from: '0x0000000000000000000000000000000000000001',
          to: '0x0000000000000000000000000000000000000002',
          txHash: '0xtx',
          blockNumber: 123,
          logIndex: 4,
          timestampMs: 999
        },
        transferPrice: {
          amountRaw: null,
          amount: null,
          currency: null
        }
      },
      baseCtx as any
    );

    expect(mocks.markResolved).toHaveBeenCalledWith(
      {
        watchId: 'watch-1',
        resolvedAt: expect.any(Number),
        triggerTxHash: '0xtx',
        triggerBlockNumber: 123,
        triggerLogIndex: 4,
        triggerTime: 999,
        triggerPriceRaw: null,
        triggerPrice: null,
        triggerPriceCurrency: null
      },
      baseCtx
    );
  });
});
