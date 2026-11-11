import 'reflect-metadata';
import {
  PROFILE_PROXIES_TABLE,
  PROFILE_PROXY_ACTIONS_TABLE,
  PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { ProfileProxiesDb } from './profile-proxies.db';

function proxy(id: string, created_by: string, target_id: string) {
  return { id, created_by, target_id, created_at: 1 };
}

function action(id: string, proxy_id: string) {
  return {
    id,
    proxy_id,
    action_type: 'ALLOCATE_REP',
    credit_amount: 100,
    credit_spent: 0,
    created_at: 1,
    start_time: 1,
    end_time: null,
    accepted_at: null,
    rejected_at: null,
    revoked_at: null,
    is_active: false
  };
}

function balance(proxy_action_id: string) {
  return {
    proxy_action_id,
    matter: 'REP',
    matter_target_id: 'someone',
    matter_category: 'category',
    credit_spent_outstanding: 1,
    created_at: 1,
    updated_at: 1
  };
}

describeWithSeed(
  'ProfileProxiesDb.deleteAllProxiesAndActionsForProfile',
  [
    {
      table: PROFILE_PROXIES_TABLE,
      rows: [
        proxy('granted-by-source', 'source', 'other'),
        proxy('granted-to-source', 'other', 'source'),
        proxy('self', 'source', 'source'),
        proxy('unrelated', 'other', 'third')
      ]
    },
    {
      table: PROFILE_PROXY_ACTIONS_TABLE,
      rows: [
        action('action-by', 'granted-by-source'),
        action('action-to', 'granted-to-source'),
        action('action-self', 'self'),
        action('action-unrelated', 'unrelated')
      ]
    },
    {
      table: PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE,
      rows: [
        balance('action-by'),
        balance('action-to'),
        balance('action-unrelated')
      ]
    }
  ],
  () => {
    const db = new ProfileProxiesDb(() => sqlExecutor);

    async function remaining() {
      return {
        proxies: (
          await sqlExecutor.execute<{ id: string }>(
            `select id from ${PROFILE_PROXIES_TABLE} order by id`
          )
        ).map((row) => row.id),
        actions: (
          await sqlExecutor.execute<{ id: string }>(
            `select id from ${PROFILE_PROXY_ACTIONS_TABLE} order by id`
          )
        ).map((row) => row.id),
        balances: (
          await sqlExecutor.execute<{ proxy_action_id: string }>(
            `select proxy_action_id from ${PROFILE_PROXY_RATING_CREDIT_BALANCES_TABLE} order by proxy_action_id`
          )
        ).map((row) => row.proxy_action_id)
      };
    }

    it('deletes proxies granted by and to the profile with their actions and balances', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        db.deleteAllProxiesAndActionsForProfile('source', connection)
      );

      expect(await remaining()).toEqual({
        proxies: ['unrelated'],
        actions: ['action-unrelated'],
        balances: ['action-unrelated']
      });
    });

    it('changes nothing for a profile without proxies', async () => {
      const before = await remaining();

      await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
        db.deleteAllProxiesAndActionsForProfile('no-handle', connection)
      );

      expect(await remaining()).toEqual(before);
    });

    it('lets other profiles change their proxies while the deletion is uncommitted', async () => {
      let release!: () => void;
      const finish = new Promise<void>((resolve) => {
        release = resolve;
      });
      let deleted!: () => void;
      const deletedReady = new Promise<void>((resolve) => {
        deleted = resolve;
      });
      const merge = sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await db.deleteAllProxiesAndActionsForProfile(
            'no-handle',
            connection
          );
          deleted();
          await finish;
        }
      );
      await deletedReady;
      try {
        await sqlExecutor.executeNativeQueriesInTransaction(
          async (connection) => {
            await sqlExecutor.execute(
              'set session innodb_lock_wait_timeout = 1',
              {},
              { wrappedConnection: connection }
            );
            try {
              await db.insertProfileProxy({
                profileProxy: proxy('new', 'other', 'third'),
                connection
              });
              await sqlExecutor.execute(
                `update ${PROFILE_PROXY_ACTIONS_TABLE} set is_active = true where id = 'action-unrelated'`,
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

      expect((await remaining()).proxies).toContain('new');
    });
  }
);
