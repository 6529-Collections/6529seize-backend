import {
  IDENTITY_NOTIFICATIONS_TABLE,
  PUSH_NOTIFICATION_CANCELLATIONS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { Time } from '@/time';
import { dropsDb } from '@/drops/drops.db';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { PushNotificationCancellationsDb } from './push-notification-cancellations.db';

const rows = [
  {
    id: 1,
    related_drop_id: 'deleted',
    related_drop_2_id: null,
    wave_id: 'wave'
  },
  {
    id: 2,
    related_drop_id: 'other',
    related_drop_2_id: 'deleted',
    wave_id: 'wave'
  },
  {
    id: 3,
    related_drop_id: 'other',
    related_drop_2_id: null,
    wave_id: 'other-wave'
  }
].map((row) => ({
  ...row,
  identity_id: 'recipient',
  cause: 'IDENTITY_MENTIONED',
  additional_data: '{}',
  created_at: 1
}));

describeWithSeed(
  'durable push cancellation',
  { table: IDENTITY_NOTIFICATIONS_TABLE, rows },
  () => {
    let db: PushNotificationCancellationsDb;
    beforeEach(() => {
      // The shared test hook creates a new executor before every test. Avoid
      // retaining an earlier executor that bypasses this test's failure spy.
      db = new PushNotificationCancellationsDb(() => sqlExecutor);
    });
    const remaining = async () =>
      (
        await sqlExecutor.execute<{ id: number }>(
          `select id from ${IDENTITY_NOTIFICATIONS_TABLE} order by id`
        )
      ).map((row) => Number(row.id));

    it('records both drop references and preserves unrelated notifications', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        dropsDb.deleteDropNotifications('deleted', { connection })
      );
      expect(await remaining()).toEqual([3]);
      expect(await db.findCancelledIds([1, 2, 3, 99])).toEqual(new Set([1, 2]));
    });

    it('records wave notification cancellations', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        wavesApiDb.deleteDropNotificationsByWaveId('wave', { connection })
      );
      expect(await remaining()).toEqual([3]);
      expect(await db.findCancelledIds([1, 2, 3])).toEqual(new Set([1, 2]));
    });

    it('serializes concurrent deletion of crossed drop references', async () => {
      await sqlExecutor.execute(`update ${IDENTITY_NOTIFICATIONS_TABLE}
      set related_drop_id = if(id = 1, 'a', 'b'),
          related_drop_2_id = if(id = 1, 'b', 'a') where id in (1, 2)`);
      await Promise.all(
        ['a', 'b'].map((dropId) =>
          sqlExecutor.executeNativeQueriesInTransaction((connection) =>
            db.cancelAndDelete('drop', [dropId], { connection })
          )
        )
      );
      expect(await remaining()).toEqual([3]);
      expect(await db.findCancelledIds([1, 2])).toEqual(new Set([1, 2]));
    });

    it('rolls back both cancellation and deletion on transaction failure', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          await db.cancelAndDelete('wave', ['wave'], { connection });
          throw new Error('abort deletion');
        })
      ).rejects.toThrow('abort deletion');
      expect(await remaining()).toEqual([1, 2, 3]);
      expect(await db.findCancelledIds([1, 2, 3])).toEqual(new Set());
    });

    it('does not delete notifications when cancellation persistence fails', async () => {
      const originalExecute = sqlExecutor.execute.bind(sqlExecutor);
      const execute = jest
        .spyOn(sqlExecutor, 'execute')
        .mockImplementation((sql, params, options) => {
          if (
            sql.includes(`insert into ${PUSH_NOTIFICATION_CANCELLATIONS_TABLE}`)
          ) {
            throw new Error('cancellation storage unavailable');
          }
          return originalExecute(sql, params, options);
        });
      try {
        await expect(
          sqlExecutor.executeNativeQueriesInTransaction((connection) =>
            db.cancelAndDelete('wave', ['wave'], { connection })
          )
        ).rejects.toThrow('cancellation storage unavailable');
      } finally {
        execute.mockRestore();
      }
      expect(await remaining()).toEqual([1, 2, 3]);
      expect(await db.findCancelledIds([1, 2, 3])).toEqual(new Set());
    });

    it('refuses to delete without a transaction', async () => {
      await expect(db.cancelAndDelete('wave', ['wave'], {})).rejects.toThrow(
        'requires a transaction'
      );
      expect(await remaining()).toEqual([1, 2, 3]);
    });

    it('handles more than one cancellation batch', async () => {
      await sqlExecutor.bulkInsert(
        IDENTITY_NOTIFICATIONS_TABLE,
        Array.from({ length: 1001 }, (_, i) => ({ ...rows[0], id: i + 10 })),
        Object.keys(rows[0])
      );
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        db.cancelAndDelete('wave', ['wave'], { connection })
      );
      expect(await remaining()).toEqual([3]);
      const count = await sqlExecutor.oneOrNull<{ count: number }>(
        `select count(*) as count from ${PUSH_NOTIFICATION_CANCELLATIONS_TABLE}`
      );
      expect(Number(count?.count)).toBe(1003);
    });

    it('expires only records older than 30 days', async () => {
      const now = Time.currentMillis();
      await sqlExecutor.execute(
        `insert into ${PUSH_NOTIFICATION_CANCELLATIONS_TABLE} (notification_id, cancelled_at) values (1, :old), (2, :recent)`,
        {
          old: now - Time.days(31).toMillis(),
          recent: now - Time.days(29).toMillis()
        }
      );
      await db.deleteExpired();
      expect(await db.findCancelledIds([1, 2])).toEqual(new Set([2]));
    });
  }
);
