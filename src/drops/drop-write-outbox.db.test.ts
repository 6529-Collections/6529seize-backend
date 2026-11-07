import 'reflect-metadata';
import {
  DROPS_TABLE,
  DROP_WRITE_OUTBOX_TABLE,
  IDENTITY_NOTIFICATIONS_TABLE,
  IDENTITY_SUBSCRIPTIONS_TABLE,
  METRIC_ROLLUP_HOUR_TABLE,
  PUSH_NOTIFICATION_OUTBOX_TABLE,
  WAVE_DROPPER_METRICS_TABLE,
  WAVE_METRICS_TABLE
} from '@/constants';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { CreateOrUpdateDropModel } from '@/drops/create-or-update-drop.model';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
import { pushNotificationOutboxDb } from '@/notifications/push-notification-outbox.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { DropWriteOutboxDb } from './drop-write-outbox.db';
import { DropWriteOutboxProcessor } from './drop-write-outbox.processor';
import { sweepDropWriteOutbox } from '../dropWriteOutboxLoop/sweep';

/**
 * Waves plan 1.8: the post outbox must do exactly what the in-transaction
 * path did, once, even when deliveries repeat, processors overlap or a
 * Lambda dies mid-way.
 */

const outboxWave = aWave(
  { type: WaveType.CHAT, chat_enabled: true },
  { id: 'outbox-wave', name: 'Outbox wave' }
);
const inlineWave = aWave(
  { type: WaveType.CHAT, chat_enabled: true },
  { id: 'inline-wave', name: 'Inline wave' }
);
const AUTHOR = 'outbox-author';
const FOLLOWERS = ['follower-1', 'follower-2', 'follower-3'];

function followerRows(waveId: string) {
  return FOLLOWERS.map((subscriber) => ({
    subscriber_id: subscriber,
    target_id: waveId,
    target_type: 'WAVE',
    target_action: 'DROP_CREATED',
    wave_id: waveId,
    subscribed_to_all_drops: true
  }));
}

function post(waveId: string, content: string): CreateOrUpdateDropModel {
  return {
    drop_id: null,
    wave_id: waveId,
    author_id: AUTHOR,
    author_identity: AUTHOR,
    drop_type: DropType.CHAT,
    signature: null,
    title: null,
    reply_to: null,
    parts: [{ content, quoted_drop: null, media: [] }],
    metadata: [],
    mentioned_users: [],
    mentioned_waves: [],
    mentioned_groups: [],
    referenced_nfts: [],
    is_additional_action_promised: null
  };
}

async function write(model: CreateOrUpdateDropModel, useOutbox: boolean) {
  return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    createOrUpdateDrop.execute(model, false, {
      connection,
      prePublication: { trustedSystem: true },
      useOutbox
    })
  );
}

async function count(sql: string, params: Record<string, unknown> = {}) {
  const row = await sqlExecutor.oneOrNull<{ cnt: number }>(sql, params);
  return Number(row?.cnt ?? 0);
}

const notificationsFor = (dropId: string) =>
  count(
    `select count(*) as cnt from ${IDENTITY_NOTIFICATIONS_TABLE} where related_drop_id = :dropId`,
    { dropId }
  );
const outboxRows = () =>
  count(`select count(*) as cnt from ${DROP_WRITE_OUTBOX_TABLE}`);
const pushRows = () =>
  count(`select count(*) as cnt from ${PUSH_NOTIFICATION_OUTBOX_TABLE}`);

async function waveTotals(waveId: string) {
  const wave = await sqlExecutor.oneOrNull<{ drops_count: number }>(
    `select drops_count from ${WAVE_METRICS_TABLE} where wave_id = :waveId`,
    { waveId }
  );
  const dropper = await sqlExecutor.oneOrNull<{ drops_count: number }>(
    `select drops_count from ${WAVE_DROPPER_METRICS_TABLE}
     where wave_id = :waveId and dropper_id = :author`,
    { waveId, author: AUTHOR }
  );
  return {
    wave: Number(wave?.drops_count ?? 0),
    dropper: Number(dropper?.drops_count ?? 0)
  };
}

const dropRollup = () =>
  count(
    `select coalesce(sum(event_count), 0) as cnt from ${METRIC_ROLLUP_HOUR_TABLE}
     where metric = 'DROP'`
  );

function processorWith({
  sendPush = jest.fn(async () => undefined),
  leaseMs,
  useCase = () => createOrUpdateDrop,
  outboxDb = new DropWriteOutboxDb(() => sqlExecutor)
}: {
  sendPush?: jest.Mock;
  leaseMs?: number;
  useCase?: () => Pick<typeof createOrUpdateDrop, 'applyDropWriteOutbox'>;
  outboxDb?: DropWriteOutboxDb;
} = {}) {
  return {
    sendPush,
    outboxDb,
    processor: new DropWriteOutboxProcessor(
      outboxDb,
      useCase,
      pushNotificationOutboxDb,
      () => sqlExecutor,
      leaseMs,
      () => true,
      sendPush
    )
  };
}

function settle<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/** Makes rows old enough for the sweeper (it leaves the worker 30 s). */
async function ageRows() {
  await sqlExecutor.execute(
    `update ${DROP_WRITE_OUTBOX_TABLE} set created_at = created_at - 3600000`
  );
}

async function expireLeases() {
  await sqlExecutor.execute(
    `update ${DROP_WRITE_OUTBOX_TABLE}
     set claimed_at = claimed_at - 3600000 where claimed_at is not null`
  );
}

describeWithSeed(
  'Post outbox (waves 1.8)',
  [
    withWaves([outboxWave, inlineWave]),
    {
      table: IDENTITY_SUBSCRIPTIONS_TABLE,
      rows: [...followerRows(outboxWave.id), ...followerRows(inlineWave.id)]
    }
  ],
  () => {
    let previousNotifier: string | undefined;
    beforeEach(() => {
      // Notification rows are written only with the notifier switched on.
      previousNotifier = process.env.USER_NOTIFIER_ACTIVATED;
      process.env.USER_NOTIFIER_ACTIVATED = 'true';
    });
    afterEach(() => {
      jest.restoreAllMocks();
      if (previousNotifier === undefined)
        delete process.env.USER_NOTIFIER_ACTIVATED;
      else process.env.USER_NOTIFIER_ACTIVATED = previousNotifier;
    });

    it('leaves one outbox row and none of the shared-row work in the write', async () => {
      const result = await write(post(outboxWave.id, 'hello'), true);

      expect(result.outbox_id).toEqual(expect.any(Number));
      expect(await outboxRows()).toBe(1);
      expect(await notificationsFor(result.drop_id)).toBe(0);
      expect(await waveTotals(outboxWave.id)).toEqual({ wave: 0, dropper: 0 });
      expect(await dropRollup()).toBe(0);
    });

    it('matches the in-transaction path exactly: notifications, rollups and wave metrics', async () => {
      const { processor } = processorWith();
      const inline: string[] = [];
      const outboxed: string[] = [];
      for (let i = 0; i < 4; i++) {
        inline.push(
          (await write(post(inlineWave.id, `inline ${i}`), false)).drop_id
        );
        const result = await write(post(outboxWave.id, `outbox ${i}`), true);
        outboxed.push(result.drop_id);
        expect(await processor.process(result.outbox_id!)).toBe('processed');
      }

      for (let i = 0; i < 4; i++) {
        expect(await notificationsFor(outboxed[i])).toBe(
          await notificationsFor(inline[i])
        );
        expect(await notificationsFor(outboxed[i])).toBe(FOLLOWERS.length);
      }
      expect(await waveTotals(outboxWave.id)).toEqual(
        await waveTotals(inlineWave.id)
      );
      expect(await waveTotals(outboxWave.id)).toEqual({ wave: 4, dropper: 4 });
      // 4 drops each way, counted once each.
      expect(await dropRollup()).toBe(8);
      expect(await outboxRows()).toBe(0);
    });

    it('does nothing twice when the same row is delivered twice', async () => {
      const { processor, sendPush } = processorWith();
      const result = await write(post(outboxWave.id, 'twice'), true);

      expect(await processor.process(result.outbox_id!)).toBe('processed');
      expect(await processor.process(result.outbox_id!)).toBe(
        'already_done_or_claimed'
      );

      expect(await notificationsFor(result.drop_id)).toBe(FOLLOWERS.length);
      expect(sendPush).toHaveBeenCalledTimes(1);
      expect(sendPush.mock.calls[0][0]).toHaveLength(FOLLOWERS.length);
      // Published at once and removed from the push outbox: no second send.
      expect(await pushRows()).toBe(0);
      expect(await dropRollup()).toBe(1);
    });

    it('runs once when the worker and the sweeper process the row together', async () => {
      const worker = processorWith();
      const sweeper = processorWith();
      const result = await write(post(outboxWave.id, 'together'), true);

      const outcomes = await Promise.all([
        worker.processor.process(result.outbox_id!),
        sweeper.processor.process(result.outbox_id!)
      ]);

      expect(outcomes.filter((it) => it === 'processed')).toHaveLength(1);
      expect(await notificationsFor(result.drop_id)).toBe(FOLLOWERS.length);
      expect(
        worker.sendPush.mock.calls.length + sweeper.sendPush.mock.calls.length
      ).toBe(1);
      expect(await waveTotals(outboxWave.id)).toEqual({ wave: 1, dropper: 1 });
    });

    it('keeps nothing from a run killed mid-processing, and the sweeper finishes it after the lease expires', async () => {
      const result = await write(post(outboxWave.id, 'killed'), true);
      const outboxDb = new DropWriteOutboxDb(() => sqlExecutor);
      // A dying Lambda never releases its claim.
      jest.spyOn(outboxDb, 'releaseFailed').mockResolvedValue(undefined);
      const dying = processorWith({
        outboxDb,
        useCase: () => ({
          applyDropWriteOutbox: async (row, ctx) => {
            await createOrUpdateDrop.applyDropWriteOutbox(row, ctx);
            throw new Error('Lambda killed after the notification inserts');
          }
        })
      });

      await expect(dying.processor.process(result.outbox_id!)).rejects.toThrow(
        'Lambda killed'
      );
      // The transaction rolled back: no notifications, rollups or metrics.
      expect(await notificationsFor(result.drop_id)).toBe(0);
      expect(await dropRollup()).toBe(0);
      expect(await waveTotals(outboxWave.id)).toEqual({ wave: 0, dropper: 0 });

      // Old enough for the sweeper, but still leased: left alone.
      await ageRows();
      const sweeper = processorWith();
      const sweep = () =>
        sweepDropWriteOutbox({
          processor: sweeper.processor,
          db: new DropWriteOutboxDb(() => sqlExecutor)
        });
      await expect(sweep()).resolves.toMatchObject({ processed: 0 });

      await expireLeases();
      await expect(sweep()).resolves.toMatchObject({ processed: 1 });

      expect(await notificationsFor(result.drop_id)).toBe(FOLLOWERS.length);
      expect(sweeper.sendPush).toHaveBeenCalledTimes(1);
      expect(await dropRollup()).toBe(1);
      expect(await outboxRows()).toBe(0);
    });

    it('rolls back a stale holder that finishes after another processor took over', async () => {
      const result = await write(post(outboxWave.id, 'stale'), true);
      const workDone = deferred();
      const resume = deferred();
      const stale = processorWith({
        useCase: () => ({
          applyDropWriteOutbox: async (row, ctx) => {
            const ids = await createOrUpdateDrop.applyDropWriteOutbox(row, ctx);
            workDone.resolve();
            await resume.promise;
            return ids;
          }
        })
      });
      const staleRun = settle(stale.processor.process(result.outbox_id!));
      await workDone.promise;
      // Its lease runs out while it is still busy, and another takes over.
      await expireLeases();
      const takeover = processorWith();
      const takeoverRun = settle(takeover.processor.process(result.outbox_id!));
      try {
        // Barrier: the takeover has claimed the row with its own token.
        for (let i = 0; ; i++) {
          const claims = await count(
            `select count(*) as cnt from ${DROP_WRITE_OUTBOX_TABLE}
             where id = :id and claimed_at > :recent`,
            { id: result.outbox_id, recent: Date.now() - 60_000 }
          );
          if (claims > 0) break;
          if (i > 2000) throw new Error('The takeover never claimed the row');
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        resume.resolve();
      }

      expect(await staleRun).toEqual({
        status: 'fulfilled',
        value: 'claim_lost'
      });
      expect(await takeoverRun).toEqual({
        status: 'fulfilled',
        value: 'processed'
      });
      expect(await notificationsFor(result.drop_id)).toBe(FOLLOWERS.length);
      expect(await dropRollup()).toBe(1);
      expect(await waveTotals(outboxWave.id)).toEqual({ wave: 1, dropper: 1 });
      expect(stale.sendPush).not.toHaveBeenCalled();
      expect(takeover.sendPush).toHaveBeenCalledTimes(1);
    });

    it('applies the counts but sends nothing for a drop deleted before its outbox ran', async () => {
      const result = await write(post(outboxWave.id, 'deleted'), true);
      await sqlExecutor.execute(`delete from ${DROPS_TABLE} where id = :id`, {
        id: result.drop_id
      });
      const { processor, sendPush } = processorWith();

      expect(await processor.process(result.outbox_id!)).toBe('processed');
      expect(await notificationsFor(result.drop_id)).toBe(0);
      expect(sendPush).not.toHaveBeenCalled();
      expect(await waveTotals(outboxWave.id)).toEqual({ wave: 1, dropper: 1 });
    });
  }
);
