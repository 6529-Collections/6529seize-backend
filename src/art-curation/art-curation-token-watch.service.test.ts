import { ArtCurationTokenWatchService } from '@/art-curation/art-curation-token-watch.service';
import { DropType } from '@/entities/IDrop';

describe('ArtCurationTokenWatchService', () => {
  const baseCtx = {};

  beforeEach(() => {
    process.env.ART_CURATIONS_WAVE_ID = 'wave-1';
  });

  afterEach(() => {
    delete process.env.ART_CURATIONS_WAVE_ID;
    delete process.env.ART_CURATIONS_WATCH_MAX_PER_CYCLE;
    delete process.env.ART_CURATIONS_BACKFILL_MAX_TOKENS_PER_RUN;
    delete process.env.ART_CURATIONS_BACKFILL_DRY_RUN;
    jest.resetAllMocks();
  });

  function createService({
    findByDropId = jest.fn().mockResolvedValue(null),
    detachDropFromWatch = jest.fn().mockResolvedValue(undefined),
    upsertActiveWatchAndGet = jest.fn(),
    insertWatch = jest.fn().mockResolvedValue(undefined),
    upsertDropWatch = jest.fn(),
    cancelIfEmpty = jest.fn().mockResolvedValue(undefined),
    lockNextActiveWatch = jest.fn(),
    findHistoricalBackfillCandidateCanonicalIds = jest
      .fn()
      .mockResolvedValue([]),
    findHistoricalBackfillCandidateDrops = jest.fn().mockResolvedValue([]),
    findActiveByDedupeKey = jest.fn().mockResolvedValue(null),
    updateHistoricalBaseline = jest.fn().mockResolvedValue(undefined),
    unlock = jest.fn().mockResolvedValue(undefined),
    markChecked = jest.fn().mockResolvedValue(undefined),
    markResolved = jest.fn().mockResolvedValue(undefined),
    snapshotSubmissionState = jest.fn(),
    snapshotSubmissionStateAtBlock = jest.fn(),
    findFirstTransfer = jest.fn(),
    findLatestBlockBeforeTimestamp = jest.fn(),
    findTransfersThroughSafeHead = jest.fn(),
    executeNativeQueriesInTransaction = jest
      .fn()
      .mockImplementation(async (fn) => fn({} as any)),
    findWaveByIdOrNull = jest.fn().mockResolvedValue({
      id: 'wave-1',
      time_lock_ms: 0
    }),
    resyncParticipatoryDropCountsForWaves = jest
      .fn()
      .mockResolvedValue(undefined),
    insertWinnerDropsVoterVotes = jest.fn().mockResolvedValue(undefined),
    getCurrentVoterStatesForDrops = jest.fn().mockResolvedValue([]),
    getAllVoteChangeLogsForGivenDropsInTimeframe = jest
      .fn()
      .mockResolvedValue({}),
    deleteStaleLeaderboardEntries = jest.fn().mockResolvedValue(undefined),
    insertDecisionIfMissing = jest.fn().mockResolvedValue(undefined),
    insertDecisionWinners = jest.fn().mockResolvedValue(undefined),
    updateDropsToWinners = jest.fn().mockResolvedValue(undefined),
    deleteDropsRanks = jest.fn().mockResolvedValue(undefined)
  } = {}) {
    return {
      service: new ArtCurationTokenWatchService(
        {
          findByDropId,
          detachDropFromWatch,
          upsertActiveWatchAndGet,
          insertWatch,
          upsertDropWatch,
          cancelIfEmpty,
          lockNextActiveWatch,
          findHistoricalBackfillCandidateCanonicalIds,
          findHistoricalBackfillCandidateDrops,
          findActiveByDedupeKey,
          updateHistoricalBaseline,
          unlock,
          markChecked,
          markResolved
        } as any,
        {
          snapshotSubmissionState,
          snapshotSubmissionStateAtBlock,
          findFirstTransfer,
          findLatestBlockBeforeTimestamp,
          findTransfersThroughSafeHead
        } as any,
        {
          insertWinnerDropsVoterVotes,
          getCurrentVoterStatesForDrops,
          getAllVoteChangeLogsForGivenDropsInTimeframe,
          deleteStaleLeaderboardEntries
        } as any,
        {
          executeNativeQueriesInTransaction,
          findWaveByIdOrNull,
          resyncParticipatoryDropCountsForWaves
        } as any,
        {
          insertDecisionIfMissing,
          insertDecisionWinners,
          updateDropsToWinners,
          deleteDropsRanks
        } as any,
        {
          calculateFinalVoteForDrop: jest.fn()
        } as any
      ),
      mocks: {
        findByDropId,
        detachDropFromWatch,
        upsertActiveWatchAndGet,
        insertWatch,
        upsertDropWatch,
        cancelIfEmpty,
        lockNextActiveWatch,
        findHistoricalBackfillCandidateCanonicalIds,
        findHistoricalBackfillCandidateDrops,
        findActiveByDedupeKey,
        updateHistoricalBaseline,
        unlock,
        markChecked,
        markResolved,
        snapshotSubmissionState,
        snapshotSubmissionStateAtBlock,
        findFirstTransfer,
        findLatestBlockBeforeTimestamp,
        findTransfersThroughSafeHead,
        executeNativeQueriesInTransaction,
        findWaveByIdOrNull,
        resyncParticipatoryDropCountsForWaves,
        insertWinnerDropsVoterVotes,
        getCurrentVoterStatesForDrops,
        getAllVoteChangeLogsForGivenDropsInTimeframe,
        deleteStaleLeaderboardEntries,
        insertDecisionIfMissing,
        insertDecisionWinners,
        updateDropsToWinners,
        deleteDropsRanks
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

  it('backfills a resolved historical session using the first post-submission transfer', async () => {
    process.env.ART_CURATIONS_BACKFILL_MAX_TOKENS_PER_RUN = '5';

    const { service, mocks } = createService({
      findHistoricalBackfillCandidateCanonicalIds: jest
        .fn()
        .mockResolvedValue([
          'OPENSEA:eth:0x1111111111111111111111111111111111111111:1'
        ]),
      findHistoricalBackfillCandidateDrops: jest.fn().mockResolvedValue([
        {
          drop_id: 'drop-1',
          created_at: 1_000,
          canonical_id:
            'OPENSEA:eth:0x1111111111111111111111111111111111111111:1',
          url_in_text:
            'https://opensea.io/assets/ethereum/0x1111111111111111111111111111111111111111/1'
        },
        {
          drop_id: 'drop-2',
          created_at: 2_000,
          canonical_id:
            'OPENSEA:eth:0x1111111111111111111111111111111111111111:1',
          url_in_text:
            'https://opensea.io/assets/ethereum/0x1111111111111111111111111111111111111111/1'
        }
      ]),
      findLatestBlockBeforeTimestamp: jest
        .fn()
        .mockImplementation(async (createdAt: number) => ({
          number: createdAt === 1_000 ? 10 : 12,
          timestampMs: createdAt - 1
        })),
      snapshotSubmissionStateAtBlock: jest.fn().mockResolvedValue({
        blockNumber: 10,
        observedAt: 1_000,
        owner: '0x0000000000000000000000000000000000000001',
        isTrackable: true
      }),
      findTransfersThroughSafeHead: jest.fn().mockResolvedValue({
        safeHead: 30,
        events: [
          {
            txHash: '0xtx',
            blockNumber: 20,
            logIndex: 0,
            timestampMs: 3_000
          }
        ]
      })
    });

    const processed = await service.processHistoricalBackfillCycle({
      start: jest.fn(),
      stop: jest.fn()
    } as any);

    expect(processed).toBe(1);
    expect(mocks.insertWatch).toHaveBeenCalledTimes(1);
    expect(mocks.insertWatch.mock.calls[0][0]).toMatchObject({
      wave_id: 'wave-1',
      start_block: 10,
      start_time: 1_000,
      last_checked_block: 20,
      status: 'ACTIVE',
      active_dedupe_key: null
    });
    expect(mocks.upsertDropWatch).toHaveBeenCalledTimes(2);
    expect(mocks.insertDecisionIfMissing).toHaveBeenCalledWith(
      {
        decision_time: 3_000,
        wave_id: 'wave-1'
      },
      expect.any(Object)
    );
    expect(mocks.updateDropsToWinners).toHaveBeenCalledWith(
      ['drop-1', 'drop-2'],
      expect.any(Object)
    );
    expect(mocks.markResolved).toHaveBeenCalledWith(
      {
        watchId: expect.any(String),
        resolvedAt: expect.any(Number),
        triggerTxHash: '0xtx',
        triggerBlockNumber: 20,
        triggerLogIndex: 0,
        triggerTime: 3_000
      },
      expect.any(Object)
    );
  });

  it('merges unresolved historical drops into an existing active watch', async () => {
    process.env.ART_CURATIONS_BACKFILL_MAX_TOKENS_PER_RUN = '5';

    const { service, mocks } = createService({
      findHistoricalBackfillCandidateCanonicalIds: jest
        .fn()
        .mockResolvedValue([
          'OPENSEA:eth:0x1111111111111111111111111111111111111111:1'
        ]),
      findHistoricalBackfillCandidateDrops: jest.fn().mockResolvedValue([
        {
          drop_id: 'drop-1',
          created_at: 1_000,
          canonical_id:
            'OPENSEA:eth:0x1111111111111111111111111111111111111111:1',
          url_in_text:
            'https://opensea.io/assets/ethereum/0x1111111111111111111111111111111111111111/1'
        }
      ]),
      findLatestBlockBeforeTimestamp: jest.fn().mockResolvedValue({
        number: 10,
        timestampMs: 999
      }),
      snapshotSubmissionStateAtBlock: jest.fn().mockResolvedValue({
        blockNumber: 10,
        observedAt: 1_000,
        owner: '0x0000000000000000000000000000000000000001',
        isTrackable: true
      }),
      findTransfersThroughSafeHead: jest.fn().mockResolvedValue({
        safeHead: 90,
        events: []
      }),
      findActiveByDedupeKey: jest.fn().mockResolvedValue({
        id: 'watch-active',
        start_block: 50,
        start_time: 5_000,
        owner_at_submission: '0x0000000000000000000000000000000000000002',
        last_checked_block: 80
      })
    });

    const processed = await service.processHistoricalBackfillCycle({
      start: jest.fn(),
      stop: jest.fn()
    } as any);

    expect(processed).toBe(1);
    expect(mocks.insertWatch).not.toHaveBeenCalled();
    expect(mocks.updateHistoricalBaseline).toHaveBeenCalledWith(
      {
        watchId: 'watch-active',
        startBlock: 10,
        startTime: 1_000,
        ownerAtSubmission: '0x0000000000000000000000000000000000000001',
        lastCheckedBlock: 90
      },
      expect.any(Object)
    );
    expect(mocks.upsertDropWatch).toHaveBeenCalledWith(
      expect.objectContaining({
        watch_id: 'watch-active',
        drop_id: 'drop-1'
      }),
      expect.any(Object)
    );
  });

  it('dry run does not write any historical winner conversion rows', async () => {
    process.env.ART_CURATIONS_BACKFILL_MAX_TOKENS_PER_RUN = '5';

    const { service, mocks } = createService({
      findHistoricalBackfillCandidateCanonicalIds: jest
        .fn()
        .mockResolvedValue([
          'OPENSEA:eth:0x1111111111111111111111111111111111111111:1'
        ]),
      findHistoricalBackfillCandidateDrops: jest.fn().mockResolvedValue([
        {
          drop_id: 'drop-1',
          created_at: 1_000,
          canonical_id:
            'OPENSEA:eth:0x1111111111111111111111111111111111111111:1',
          url_in_text:
            'https://opensea.io/assets/ethereum/0x1111111111111111111111111111111111111111/1'
        }
      ]),
      findLatestBlockBeforeTimestamp: jest.fn().mockResolvedValue({
        number: 10,
        timestampMs: 999
      }),
      snapshotSubmissionStateAtBlock: jest.fn().mockResolvedValue({
        blockNumber: 10,
        observedAt: 1_000,
        owner: '0x0000000000000000000000000000000000000001',
        isTrackable: true
      }),
      findTransfersThroughSafeHead: jest.fn().mockResolvedValue({
        safeHead: 30,
        events: [
          {
            txHash: '0xtx',
            blockNumber: 20,
            logIndex: 0,
            timestampMs: 3_000
          }
        ]
      })
    });

    const processed = await service.processHistoricalBackfillCycle(
      {
        start: jest.fn(),
        stop: jest.fn()
      } as any,
      { dryRun: true }
    );

    expect(processed).toBe(1);
    expect(mocks.insertWatch).not.toHaveBeenCalled();
    expect(mocks.upsertDropWatch).not.toHaveBeenCalled();
    expect(mocks.insertDecisionIfMissing).not.toHaveBeenCalled();
    expect(mocks.insertDecisionWinners).not.toHaveBeenCalled();
    expect(mocks.updateDropsToWinners).not.toHaveBeenCalled();
    expect(mocks.deleteDropsRanks).not.toHaveBeenCalled();
    expect(mocks.markResolved).not.toHaveBeenCalled();
    expect(mocks.executeNativeQueriesInTransaction).not.toHaveBeenCalled();
  });

  it('dry run does not update active watches for unresolved historical drops', async () => {
    process.env.ART_CURATIONS_BACKFILL_MAX_TOKENS_PER_RUN = '5';

    const { service, mocks } = createService({
      findHistoricalBackfillCandidateCanonicalIds: jest
        .fn()
        .mockResolvedValue([
          'OPENSEA:eth:0x1111111111111111111111111111111111111111:1'
        ]),
      findHistoricalBackfillCandidateDrops: jest.fn().mockResolvedValue([
        {
          drop_id: 'drop-1',
          created_at: 1_000,
          canonical_id:
            'OPENSEA:eth:0x1111111111111111111111111111111111111111:1',
          url_in_text:
            'https://opensea.io/assets/ethereum/0x1111111111111111111111111111111111111111/1'
        }
      ]),
      findLatestBlockBeforeTimestamp: jest.fn().mockResolvedValue({
        number: 10,
        timestampMs: 999
      }),
      snapshotSubmissionStateAtBlock: jest.fn().mockResolvedValue({
        blockNumber: 10,
        observedAt: 1_000,
        owner: '0x0000000000000000000000000000000000000001',
        isTrackable: true
      }),
      findTransfersThroughSafeHead: jest.fn().mockResolvedValue({
        safeHead: 90,
        events: []
      }),
      findActiveByDedupeKey: jest.fn().mockResolvedValue({
        id: 'watch-active',
        start_block: 50,
        start_time: 5_000,
        owner_at_submission: '0x0000000000000000000000000000000000000002',
        last_checked_block: 80
      })
    });

    const processed = await service.processHistoricalBackfillCycle(
      {
        start: jest.fn(),
        stop: jest.fn()
      } as any,
      { dryRun: true }
    );

    expect(processed).toBe(1);
    expect(mocks.insertWatch).not.toHaveBeenCalled();
    expect(mocks.upsertDropWatch).not.toHaveBeenCalled();
    expect(mocks.updateHistoricalBaseline).not.toHaveBeenCalled();
    expect(mocks.findActiveByDedupeKey).toHaveBeenCalled();
  });
});
