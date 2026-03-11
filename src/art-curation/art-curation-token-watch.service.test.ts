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
    snapshotSubmissionState = jest.fn(),
    findFirstTransfer = jest.fn()
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
          markChecked
        } as any,
        {
          snapshotSubmissionState,
          findFirstTransfer
        } as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any
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
        snapshotSubmissionState,
        findFirstTransfer
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
});
