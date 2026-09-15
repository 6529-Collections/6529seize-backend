import { MEMBERSHIP_SOURCE_STATES_TABLE } from '@/constants';
import * as loopDb from '@/db';
import {
  markMembershipTransactionFailed,
  membershipQueryOptions,
  withMembershipPrimaryTransaction
} from '@/membership/membership-primary';
import { setSqlExecutor, sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

describeWithSeed(
  'membership primary snapshots on MySQL',
  [
    {
      table: MEMBERSHIP_SOURCE_STATES_TABLE,
      rows: [
        {
          scope: 'PROFILE',
          target_id: 'm2-primary-test',
          dimension: 'IDENTITY',
          version: '1',
          active_jobs: 0,
          updated_at_millis: '1'
        }
      ]
    }
  ],
  () => {
    const select = `SELECT CAST(version AS CHAR) AS version
    FROM ${MEMBERSHIP_SOURCE_STATES_TABLE}
    WHERE scope = 'PROFILE' AND target_id = 'm2-primary-test' AND dimension = 'IDENTITY'`;

    it('holds a coherent page snapshot while locking reads see current committed changes', async () => {
      await withMembershipPrimaryTransaction(sqlExecutor, async (ctx) => {
        const options = membershipQueryOptions(ctx);
        expect(await sqlExecutor.execute(select, undefined, options)).toEqual([
          { version: '1' }
        ]);
        // A separate connection commits while the page snapshot is open.
        await sqlExecutor.execute(`UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version = 2
        WHERE target_id = 'm2-primary-test'`);
        expect(await sqlExecutor.execute(select, undefined, options)).toEqual([
          { version: '1' }
        ]);
        expect(
          await sqlExecutor.execute(`${select} FOR UPDATE`, undefined, options)
        ).toEqual([{ version: '2' }]);
      });
      await withMembershipPrimaryTransaction(sqlExecutor, async (ctx) => {
        expect(
          await sqlExecutor.execute(
            select,
            undefined,
            membershipQueryOptions(ctx)
          )
        ).toEqual([{ version: '2' }]);
      });
    });

    it('rolls back writes made through the bound connection on callback failure', async () => {
      await expect(
        withMembershipPrimaryTransaction(sqlExecutor, async (ctx) => {
          await sqlExecutor.execute(
            `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version = 9
        WHERE target_id = 'm2-primary-test'`,
            undefined,
            membershipQueryOptions(ctx)
          );
          throw new Error('abort scoped work');
        })
      ).rejects.toThrow('abort scoped work');
      expect(await sqlExecutor.execute(select)).toEqual([{ version: '1' }]);
    });

    it('rolls back a real write when the caller catches a marked mutation failure', async () => {
      const failure = new Error('source write failed after partial progress');
      await expect(
        withMembershipPrimaryTransaction(sqlExecutor, async (ctx) => {
          try {
            await sqlExecutor.execute(
              `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version = 7
              WHERE target_id = 'm2-primary-test'`,
              undefined,
              membershipQueryOptions(ctx)
            );
            throw failure;
          } catch (error) {
            markMembershipTransactionFailed(ctx, error);
          }
          return 'caller caught the failure';
        })
      ).rejects.toBe(failure);
      expect(await sqlExecutor.execute(select)).toEqual([{ version: '1' }]);
    });

    it('keeps the same coherent snapshot through the real loop TypeORM adapter', async () => {
      const concurrentWriter = sqlExecutor;
      await loopDb.connect();
      try {
        await withMembershipPrimaryTransaction(sqlExecutor, async (ctx) => {
          const options = membershipQueryOptions(ctx);
          expect(await sqlExecutor.execute(select, undefined, options)).toEqual(
            [{ version: '1' }]
          );
          await concurrentWriter.execute(
            `UPDATE ${MEMBERSHIP_SOURCE_STATES_TABLE} SET version = 3
              WHERE target_id = 'm2-primary-test'`
          );
          expect(await sqlExecutor.execute(select, undefined, options)).toEqual(
            [{ version: '1' }]
          );
          expect(
            await sqlExecutor.execute(
              `${select} FOR UPDATE`,
              undefined,
              options
            )
          ).toEqual([{ version: '3' }]);
        });
      } finally {
        await loopDb.disconnect();
        setSqlExecutor(concurrentWriter);
      }
    });
  }
);
