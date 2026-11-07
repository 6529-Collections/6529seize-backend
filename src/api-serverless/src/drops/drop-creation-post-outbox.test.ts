import {
  DropCreationApiService,
  dropWriteOutboxAfterCommitStages
} from '@/api/drops/drop-creation.api.service';
jest.mock('@/competitions/competition-entry-drop-hooks');
import { waveScoreService } from '@/api/waves/wave-score.service';
import { DropType } from '@/entities/IDrop';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import { helpBotDailyActivityCreditQueueService } from '@/help-bot/help-bot-daily-activity-credit-queue.service';
import { handOffDropWriteOutbox } from '@/drops/drop-write-outbox.hand-off';
import { poolForUnboundQuery } from '@/db/primary-read-scope';
import { DbPoolName } from '@/db-query.options';

jest.mock('@/api/waves/wave-unread-cache', () => ({
  invalidateWaveUnreadCacheForWave: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('@/api/push-notifications/push-notifications.service', () => ({
  sendIdentityPushNotifications: jest.fn().mockResolvedValue(undefined)
}));

/**
 * Waves 1.8 in the create path: with WS_POST_OUTBOX off nothing changes;
 * with it on the write leaves an outbox row, the API read moves after commit
 * and the request only hands the row id to the worker.
 */
describe('DropCreationApiService.createDrop with the post outbox (1.8)', () => {
  const env = { ...process.env };

  beforeEach(() => {
    jest
      .spyOn(helpBotDailyActivityCreditQueueService, 'enqueueRequest')
      .mockResolvedValue(false);
    jest
      .spyOn(waveScoreService, 'requestWaveScoreRefreshBestEffort')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  function setup({ outbox }: { outbox: boolean }) {
    if (outbox) process.env.WS_POST_OUTBOX = 'true';
    else delete process.env.WS_POST_OUTBOX;
    delete process.env.WS_ASYNC_FANOUT;
    const transactions: { inside: boolean }[] = [];
    let inTransaction = false;
    const dropsDb = {
      executeNativeQueriesInTransaction: jest.fn(async (callback) => {
        inTransaction = true;
        transactions.push({ inside: true });
        try {
          return await callback({ connection: `tx-${transactions.length}` });
        } finally {
          inTransaction = false;
        }
      })
    };
    const reads: {
      inWriteTransaction: boolean;
      connection: unknown;
      onPrimary: boolean;
    }[] = [];
    const dropsService = {
      findDropByIdOrThrow: jest.fn(async (_query, ctx) => {
        reads.push({
          inWriteTransaction: inTransaction && transactions.length === 1,
          connection: ctx.connection,
          onPrimary: poolForUnboundQuery(DbPoolName.READ) === DbPoolName.WRITE
        });
        return { id: 'drop-1', wave_id: 'wave-1' };
      })
    };
    const execute = jest.fn().mockResolvedValue(
      outbox
        ? {
            drop_id: 'drop-1',
            pending_push_notification_ids: [],
            dm_unread_recipient_ids: [],
            outbox_id: 42
          }
        : {
            drop_id: 'drop-1',
            pending_push_notification_ids: [7, 8],
            dm_unread_recipient_ids: []
          }
    );
    const queue = { enqueue: jest.fn().mockResolvedValue([]) };
    const service = new DropCreationApiService(
      dropsService as never,
      dropsDb as never,
      {
        createDropApiToUseCaseModel: jest
          .fn()
          .mockReturnValue({ wave_id: 'wave-1', drop_type: DropType.CHAT })
      } as never,
      {
        preResolveIdentityNomination: jest.fn().mockResolvedValue(null),
        preparePrePublication: jest.fn().mockResolvedValue({}),
        execute
      } as never,
      {} as never,
      {
        notifyAboutDropUpdate: jest.fn().mockResolvedValue(undefined)
      } as never,
      { findByDropId: jest.fn().mockResolvedValue([]) } as never,
      {} as never,
      { createPollForDrop: jest.fn().mockResolvedValue(undefined) } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { enqueue: jest.fn().mockResolvedValue([]) } as never,
      dropWriteOutboxAfterCommitStages(dropsService as never, (input, ctx) =>
        handOffDropWriteOutbox(input, ctx, queue)
      )
    );
    const create = () =>
      service.createDrop(
        {
          createDropRequest: {} as never,
          authorId: 'author-1',
          representativeId: 'author-1'
        },
        { timer: undefined } as never
      );
    return { create, execute, queue, reads, dropsDb };
  }

  it('changes nothing with the flag off', async () => {
    const { create, execute, queue, reads, dropsDb } = setup({
      outbox: false
    });

    await expect(create()).resolves.toMatchObject({ id: 'drop-1' });

    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      false,
      expect.objectContaining({ useOutbox: false })
    );
    // One transaction, and the API read happens inside it, as before.
    expect(dropsDb.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
    expect(reads).toEqual([
      {
        inWriteTransaction: true,
        connection: { connection: 'tx-1' },
        onPrimary: false
      }
    ]);
    expect(queue.enqueue).not.toHaveBeenCalled();
    // The pushes go out once, from the write's own notification ids.
    expect(sendIdentityPushNotifications).toHaveBeenCalledTimes(1);
    expect(sendIdentityPushNotifications).toHaveBeenCalledWith([7, 8]);
  });

  it('with the flag on, reads after commit and only hands the outbox row to the worker', async () => {
    const { create, execute, queue, reads, dropsDb } = setup({
      outbox: true
    });

    await expect(create()).resolves.toMatchObject({ id: 'drop-1' });

    expect(execute).toHaveBeenCalledWith(
      expect.anything(),
      false,
      expect.objectContaining({ useOutbox: true })
    );
    // The write transaction does no API read. The committed drop is read
    // on the primary after commit, with no transaction of its own, so the
    // mapper's parallel queries are not serialized on one connection.
    expect(dropsDb.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(1);
    expect(reads).toEqual([
      { inWriteTransaction: false, connection: undefined, onPrimary: true }
    ]);
    expect(queue.enqueue).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'drop_write_outbox',
        outbox_id: 42,
        drop_id: 'drop-1',
        wave_id: 'wave-1'
      })
    ]);
    // Notifications and their pushes come from the outbox processor, so the
    // request sends none: no double send.
    expect(sendIdentityPushNotifications).not.toHaveBeenCalledWith(
      expect.arrayContaining([expect.any(Number)])
    );
  });

  it('leaves a refused hand-off to the sweeper without failing the POST', async () => {
    const { create, queue } = setup({ outbox: true });
    queue.enqueue.mockImplementation(async (jobs: unknown[]) => jobs);

    await expect(create()).resolves.toMatchObject({ id: 'drop-1' });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });
});
