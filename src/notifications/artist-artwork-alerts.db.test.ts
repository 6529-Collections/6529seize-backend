import { randomUUID } from 'node:crypto';
import { ArtistArtworkAlertsDb } from './artist-artwork-alerts.db';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import * as tables from '@/constants';
import { stableUuid } from '@/competitions/competition-id';
import { competitionEventRepository } from '@/competitions/competition-event.repository';

const eventId = randomUUID();

function barrier() {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

async function insertOutboxEvent(id: string, semanticKey: string) {
  await sqlExecutor.execute(
    `insert into ${tables.COMPETITION_OUTBOX_TABLE}
    (id,competition_id,wave_id,semantic_key,event,created_at,next_attempt_at,attempts)
    values (:id,'competition','wave',:semanticKey,'{}',1,1,0)`,
    { id, semanticKey }
  );
}

async function completeReceipt(event: string, key: string) {
  await sqlExecutor.execute(
    `insert into ${tables.COMPETITION_EVENT_EFFECTS_TABLE} (id,event_id,effect_key,result,completed_at)
    values (:id,:event,:key,'[7]',10)`,
    { id: stableUuid(event, key), event, key }
  );
}

async function receiptKeys(event: string): Promise<string[]> {
  const rows = await sqlExecutor.execute<{ effect_key: string }>(
    `select effect_key from ${tables.COMPETITION_EVENT_EFFECTS_TABLE}
    where event_id=:event order by effect_key`,
    { event }
  );
  return rows.map((row) => row.effect_key);
}

/** Runs one write in its own transaction, failing fast instead of waiting on a lock. */
async function writeWithoutWaiting(
  sql: string,
  params: Record<string, unknown>
) {
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    await sqlExecutor.execute(
      'set session innodb_lock_wait_timeout = 1',
      {},
      { wrappedConnection: connection }
    );
    try {
      await sqlExecutor.execute(sql, params, {
        wrappedConnection: connection
      });
    } finally {
      await sqlExecutor.execute(
        'set session innodb_lock_wait_timeout = default',
        {},
        { wrappedConnection: connection }
      );
    }
  });
}

describeWithSeed(
  'Independent artist artwork preferences',
  [
    {
      table: tables.COMPETITION_ENTRIES_TABLE,
      rows: [
        {
          id: 'entry',
          competition_id: 'competition',
          wave_id: 'wave',
          drop_id: 'drop',
          submitter_id: 'artist',
          status: 'ACTIVE',
          config_version: 1,
          submitted_at: 101
        }
      ]
    }
  ],
  () => {
    const db = new ArtistArtworkAlertsDb(() => sqlExecutor);
    const pair = { subscriberId: 'viewer', artistId: 'artist' };
    afterEach(() => jest.restoreAllMocks());
    async function recipients(submittedAt: number) {
      await sqlExecutor.execute(
        `update ${tables.COMPETITION_ENTRIES_TABLE} set submitted_at=:submittedAt where id='entry'`,
        { submittedAt }
      );
      return db.listPendingRecipients(eventId, 'entry', {});
    }
    async function complete(ids: string[]) {
      await sqlExecutor.bulkInsert(
        tables.COMPETITION_EVENT_EFFECTS_TABLE,
        ids.map((id) => ({
          id: stableUuid(eventId, `artwork:${id}`),
          event_id: eventId,
          effect_key: `artwork:${id}`,
          result: '[]',
          completed_at: 10
        })),
        ['id', 'event_id', 'effect_key', 'result', 'completed_at']
      );
    }

    it('defaults off and persists an explicit opt-in without following', async () => {
      expect(await db.isEnabled(pair)).toBe(false);
      jest.spyOn(Date, 'now').mockReturnValue(100);
      await db.setEnabled(pair, true);
      expect(await db.isEnabled(pair)).toBe(true);
      expect(await recipients(101)).toEqual(['viewer']);
      expect(await db.isEnabled({ ...pair, subscriberId: 'other' })).toBe(
        false
      );
      await db.setEnabled(pair, false);
      await db.setEnabled(pair, false);
      expect(await db.isEnabled(pair)).toBe(false);
    });

    it('never backfills old work and preserves the cutoff when enable is retried', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(100);
      await db.setEnabled(pair, true);
      now.mockReturnValue(200);
      await db.setEnabled(pair, true);
      expect(await db.isEnabled({ ...pair, submittedAt: 100 })).toBe(false);
      expect(await recipients(100)).toEqual([]);
      expect(await db.isEnabled({ ...pair, submittedAt: 150 })).toBe(true);
      await db.setEnabled(pair, false);
      await db.setEnabled(pair, true);
      expect(await db.isEnabled({ ...pair, submittedAt: 150 })).toBe(false);
      expect(await recipients(201)).toEqual(['viewer']);
    });

    it('paginates all recipients exactly once and excludes self notifications', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1);
      for (let index = 0; index < 253; index++) {
        await db.setEnabled(
          {
            artistId: 'artist',
            subscriberId: `viewer-${String(index).padStart(3, '0')}`
          },
          true
        );
      }
      await db.setEnabled({ subscriberId: 'artist', artistId: 'artist' }, true);
      const first = await recipients(2);
      await complete(first);
      const second = await recipients(2);
      await complete(second);
      const third = await recipients(2);
      await complete(third);
      expect(first).toHaveLength(100);
      expect(second).toHaveLength(100);
      expect(third).toHaveLength(53);
      expect(new Set([...first, ...second, ...third]).size).toBe(253);
      expect(await recipients(2)).toEqual([]);
    });

    it('moves both sides of merged preferences, keeps the earliest opt-in and removes self-pairs', async () => {
      const now = jest.spyOn(Date, 'now').mockReturnValue(100);
      await db.setEnabled({ subscriberId: 'source', artistId: 'artist' }, true);
      await db.setEnabled({ subscriberId: 'viewer', artistId: 'target' }, true);
      now.mockReturnValue(200);
      await db.setEnabled({ subscriberId: 'target', artistId: 'artist' }, true);
      await db.setEnabled({ subscriberId: 'viewer', artistId: 'source' }, true);
      await db.setEnabled({ subscriberId: 'source', artistId: 'target' }, true);
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await db.mergeProfile('source', 'target', { connection });
          await db.mergeProfile('source', 'target', { connection });
        }
      );
      expect(
        await sqlExecutor.execute(
          `select * from ${tables.ARTIST_ARTWORK_ALERTS_TABLE} order by subscriber_id`
        )
      ).toEqual([
        { subscriber_id: 'target', artist_id: 'artist', enabled_at: 100 },
        { subscriber_id: 'viewer', artist_id: 'target', enabled_at: 100 }
      ]);
      expect(
        await db.isEnabled({
          subscriberId: 'target',
          artistId: 'artist',
          submittedAt: 100
        })
      ).toBe(false);
      expect(
        await db.isEnabled({
          subscriberId: 'target',
          artistId: 'artist',
          submittedAt: 101
        })
      ).toBe(true);
    });

    it('preserves processed recipients when a profile merges during a pending delivery', async () => {
      await db.setEnabled({ subscriberId: 'source', artistId: 'artist' }, true);
      await sqlExecutor.execute(
        `update ${tables.ARTIST_ARTWORK_ALERTS_TABLE} set enabled_at=1`
      );
      await sqlExecutor.execute(
        `insert into ${tables.COMPETITION_OUTBOX_TABLE}
      (id,competition_id,wave_id,semantic_key,event,created_at,next_attempt_at,attempts)
      values (:eventId,'competition','wave','review-event','{}',1,1,0)`,
        { eventId }
      );
      await competitionEventRepository.applyEffect(
        eventId,
        'artwork:source',
        async () => [42]
      );
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        db.mergeProfile('source', 'target', { connection })
      );
      expect(await recipients(2)).toEqual([]);
      const notify = jest.fn().mockResolvedValue([43]);
      expect(
        await competitionEventRepository.applyEffect(
          eventId,
          'artwork:target',
          notify
        )
      ).toEqual([42]);
      expect(notify).not.toHaveBeenCalled();
    });

    it('transfers a source receipt committed after the merge transaction establishes its snapshot', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1);
      await db.setEnabled({ subscriberId: 'source', artistId: 'artist' }, true);
      await sqlExecutor.execute(
        `insert into ${tables.COMPETITION_OUTBOX_TABLE}
        (id,competition_id,wave_id,semantic_key,event,created_at,next_attempt_at,attempts)
        values (:eventId,'competition','wave','concurrent-event','{}',1,1,0)`,
        { eventId }
      );
      const sourceLocked = barrier();
      const finishSource = barrier();
      const mergeStarted = barrier();
      const delivery = competitionEventRepository.applyEffect(
        eventId,
        'artwork:source',
        async (ctx) => {
          expect(
            await db.isEnabled(
              { subscriberId: 'source', artistId: 'artist', submittedAt: 2 },
              ctx
            )
          ).toBe(true);
          sourceLocked.release();
          await finishSource.ready;
          return [42];
        }
      );
      await sourceLocked.ready;
      const merge = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          // This consistent read establishes a snapshot before delivery commits.
          expect(
            await sqlExecutor.execute(
              `select * from ${tables.COMPETITION_EVENT_EFFECTS_TABLE}`,
              {},
              { wrappedConnection: connection }
            )
          ).toEqual([]);
          const pending = db.mergeProfile('source', 'target', { connection });
          mergeStarted.release();
          await pending;
        }
      );
      await mergeStarted.ready;
      finishSource.release();
      await Promise.all([delivery, merge]);
      expect(await recipients(2)).toEqual([]);
      const duplicate = jest.fn().mockResolvedValue([43]);
      expect(
        await competitionEventRepository.applyEffect(
          eventId,
          'artwork:target',
          duplicate
        )
      ).toEqual([42]);
      expect(duplicate).not.toHaveBeenCalled();
    });

    it('does not notify a stale source recipient when delivery overlaps a committed preference merge', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1);
      await db.setEnabled({ subscriberId: 'source', artistId: 'artist' }, true);
      const preferencesMoved = barrier();
      const finishMerge = barrier();
      const merge = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await db.mergeProfile('source', 'target', { connection });
          preferencesMoved.release();
          await finishMerge.ready;
        }
      );
      await preferencesMoved.ready;
      const notify = jest.fn().mockResolvedValue([42]);
      const delivery = competitionEventRepository.applyEffect(
        eventId,
        'artwork:source',
        async (ctx) => {
          if (
            !(await db.isEnabled(
              { subscriberId: 'source', artistId: 'artist', submittedAt: 2 },
              ctx
            ))
          )
            return [];
          return notify();
        }
      );
      finishMerge.release();
      await Promise.all([delivery, merge]);
      expect(notify).not.toHaveBeenCalled();
      expect(await recipients(2)).toEqual(['target']);
      await competitionEventRepository.applyEffect(
        eventId,
        'artwork:target',
        notify
      );
      expect(notify).toHaveBeenCalledTimes(1);
      expect(await recipients(2)).toEqual([]);
    });

    it('leaves other undelivered events claimable while a merge is open', async () => {
      const otherEvent = randomUUID();
      await insertOutboxEvent(eventId, 'merge-source-event');
      await insertOutboxEvent(otherEvent, 'merge-other-event');
      await completeReceipt(eventId, 'artwork:source');
      await completeReceipt(otherEvent, 'artwork:viewer');
      const merged = barrier();
      const finishMerge = barrier();
      const merge = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await db.mergeProfile('source', 'target', { connection });
          merged.release();
          await finishMerge.ready;
        }
      );
      await merged.ready;
      try {
        // An outbox claim, a new event and a receipt outside the source key's
        // index range do not wait for the merge transaction.
        await writeWithoutWaiting(
          `update ${tables.COMPETITION_OUTBOX_TABLE} set lease_token='lease' where id=:otherEvent`,
          { otherEvent }
        );
        await writeWithoutWaiting(
          `insert into ${tables.COMPETITION_OUTBOX_TABLE}
          (id,competition_id,wave_id,semantic_key,event,created_at,next_attempt_at,attempts)
          values (:id,'competition','wave','merge-new-event','{}',1,1,0)`,
          { id: randomUUID() }
        );
        await writeWithoutWaiting(
          `insert into ${tables.COMPETITION_EVENT_EFFECTS_TABLE} (id,event_id,effect_key)
          values (:id,:otherEvent,'notify:viewer')`,
          { id: randomUUID(), otherEvent }
        );
      } finally {
        finishMerge.release();
        await merge;
      }
      expect(await receiptKeys(eventId)).toEqual([
        'artwork:source',
        'artwork:target'
      ]);
      expect(await receiptKeys(otherEvent)).toEqual([
        'artwork:viewer',
        'notify:viewer'
      ]);
    });

    it('moves only the source receipts of undelivered events', async () => {
      const deliveredEvent = randomUUID();
      await insertOutboxEvent(eventId, 'pending-event');
      await insertOutboxEvent(deliveredEvent, 'delivered-event');
      await sqlExecutor.execute(
        `update ${tables.COMPETITION_OUTBOX_TABLE} set delivered_at=5 where id=:deliveredEvent`,
        { deliveredEvent }
      );
      await completeReceipt(eventId, 'artwork:source');
      await completeReceipt(deliveredEvent, 'artwork:source');
      await completeReceipt(eventId, 'artwork:viewer');
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        db.mergeProfile('source', 'target', { connection })
      );
      expect(await receiptKeys(eventId)).toEqual([
        'artwork:source',
        'artwork:target',
        'artwork:viewer'
      ]);
      expect(await receiptKeys(deliveredEvent)).toEqual(['artwork:source']);
    });

    it('changes nothing for a source without receipts or preferences', async () => {
      await insertOutboxEvent(eventId, 'untouched-event');
      await completeReceipt(eventId, 'artwork:viewer');
      await db.setEnabled({ subscriberId: 'viewer', artistId: 'artist' }, true);
      const before = await sqlExecutor.execute(
        `select * from ${tables.ARTIST_ARTWORK_ALERTS_TABLE}`
      );
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        db.mergeProfile('no-handle', 'target', { connection })
      );
      expect(
        await sqlExecutor.execute(
          `select * from ${tables.ARTIST_ARTWORK_ALERTS_TABLE}`
        )
      ).toEqual(before);
      expect(await receiptKeys(eventId)).toEqual(['artwork:viewer']);
    });

    it('finds a merged subscriber even when its ID sorts before a completed recipient', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1);
      await db.setEnabled(
        { subscriberId: 'z-source', artistId: 'artist' },
        true
      );
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        db.mergeProfile('z-source', 'a-target', { connection })
      );
      expect(await recipients(2)).toEqual(['a-target']);
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        db.mergeProfile('artist', 'new-artist', { connection })
      );
      await sqlExecutor.execute(
        `update ${tables.COMPETITION_ENTRIES_TABLE} set submitter_id='new-artist' where id='entry'`
      );
      expect(await recipients(2)).toEqual(['a-target']);
    });
  }
);
