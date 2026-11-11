import 'reflect-metadata';
import { USER_GROUPS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { UserGroupsDb } from './user-groups.db';

const groups = [
  aUserGroup(
    { created_by: 'source', cic_user: 'source', rep_user: 'other' },
    { id: 'by-source', name: 'by-source' }
  ),
  aUserGroup(
    { created_by: 'other', cic_user: null, rep_user: 'source' },
    { id: 'rep-of-source', name: 'rep-of-source' }
  ),
  aUserGroup(
    { created_by: 'other', cic_user: 'third', rep_user: null },
    { id: 'unrelated', name: 'unrelated' }
  )
];

describeWithSeed(
  'UserGroupsDb.migrateProfileIdsInGroups',
  withUserGroups(groups),
  () => {
    const db = new UserGroupsDb(() => sqlExecutor);

    async function profileColumns() {
      return sqlExecutor.execute(
        `select id, created_by, cic_user, rep_user from ${USER_GROUPS_TABLE} order by id`
      );
    }

    it('moves creator, CIC and REP references to the target', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        db.migrateProfileIdsInGroups('source', 'target', connection)
      );

      expect(await profileColumns()).toEqual([
        {
          id: 'by-source',
          created_by: 'target',
          cic_user: 'target',
          rep_user: 'other'
        },
        {
          id: 'rep-of-source',
          created_by: 'other',
          cic_user: null,
          rep_user: 'target'
        },
        {
          id: 'unrelated',
          created_by: 'other',
          cic_user: 'third',
          rep_user: null
        }
      ]);
    });

    it('changes nothing and leaves other groups writable for an identity without groups', async () => {
      const before = await profileColumns();
      let release!: () => void;
      const finish = new Promise<void>((resolve) => {
        release = resolve;
      });
      let migrated!: () => void;
      const migratedReady = new Promise<void>((resolve) => {
        migrated = resolve;
      });
      const merge = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await db.migrateProfileIdsInGroups('no-handle', 'target', connection);
          migrated();
          await finish;
        }
      );
      await migratedReady;
      try {
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            await sqlExecutor.execute(
              'set session innodb_lock_wait_timeout = 1',
              {},
              { wrappedConnection: connection }
            );
            try {
              // Without indexes the merge's updates would hold every row.
              await sqlExecutor.execute(
                `update ${USER_GROUPS_TABLE} set name = 'renamed' where id = 'unrelated'`,
                {},
                { wrappedConnection: connection }
              );
            } finally {
              await sqlExecutor.execute(
                'set session innodb_lock_wait_timeout = default',
                {},
                { wrappedConnection: connection }
              );
            }
          }
        );
      } finally {
        release();
        await merge;
      }

      expect(await profileColumns()).toEqual(before);
    });
  }
);
