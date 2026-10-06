import 'reflect-metadata';
import {
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  MEMES_CONTRACT,
  MEMES_SEASONS_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  updateSubscriptionCount,
  updateSubscriptionMode,
  updateSubscribeAllEditions,
  fetchUpcomingMemeSubscriptions
} from '@/api/subscriptions/api.subscriptions.db';
import {
  synchronizeAutomaticSubscriptionQuantities,
  synchronizeAutomaticSubscriptionQuantitiesAfterReset
} from './subscription-quantity-sync.db';
import { invalidateUpcomingSubscriptionCaches } from './subscription-cache';
import { resolveRequestedSubscriptionCount } from './subscriptions';

jest.mock('@/nftsLoop/db.nfts', () => ({
  getMaxMemeId: jest.fn().mockResolvedValue(556)
}));
jest.mock('@/subscription-coverage/subscription-coverage-dirty', () => ({
  markSubscriptionCoverageDirty: jest.fn()
}));
jest.mock('./subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn()
}));

const timestamp = '2026-09-01 12:00:00';
const automaticRow = (
  tokenId: number,
  key = 'auto',
  automatic = true,
  subscribed = true,
  contract = MEMES_CONTRACT
) => ({
  consolidation_key: key,
  contract,
  token_id: tokenId,
  subscribed,
  subscribed_count: 11,
  automatic_subscription: automatic,
  created_at: timestamp,
  updated_at: timestamp
});

async function sync(keys?: string[]) {
  return sqlExecutor.executeNativeQueriesInTransaction((connection) =>
    synchronizeAutomaticSubscriptionQuantities(keys, {
      connection,
      timer: undefined
    })
  );
}

async function saved(tokenId: number, key = 'auto') {
  return sqlExecutor.oneOrNull<{
    subscribed_count: number;
    automatic_subscription: boolean;
    updated_at: string;
  }>(
    `SELECT subscribed_count, automatic_subscription, updated_at FROM ${SUBSCRIPTIONS_NFTS_TABLE}
     WHERE consolidation_key = :key AND contract = :contract AND token_id = :tokenId`,
    { key, contract: MEMES_CONTRACT, tokenId }
  );
}

async function setEligibility(sets: number) {
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    await sqlExecutor.execute(
      `UPDATE ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE} SET sets = :sets WHERE consolidation_key = 'auto' AND season = 2`,
      { sets },
      { wrappedConnection: connection }
    );
    await synchronizeAutomaticSubscriptionQuantities(['auto'], {
      connection,
      timer: undefined
    });
  });
}

async function addSubscriptionPages() {
  const rows = Array.from({ length: 501 }, (_, index) =>
    automaticRow(1000 + index)
  );
  await sqlExecutor.bulkInsert(
    SUBSCRIPTIONS_NFTS_TABLE,
    rows,
    Object.keys(rows[0])
  );
}

describeWithSeed(
  'automatic subscription quantity synchronization',
  [
    {
      table: MEMES_SEASONS_TABLE,
      rows: [1, 2].map((id) => ({
        id,
        start_index: 1,
        end_index: 556,
        count: 556,
        name: `S${id}`,
        display: `S${id}`,
        boost: 1
      }))
    },
    {
      table: CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
      rows: [
        {
          consolidation_key: 'auto',
          season: 1,
          balance: 99,
          unique: 1,
          sets: 99
        },
        ...['auto', 'one', 'disabled'].map((key) => ({
          consolidation_key: key,
          season: 2,
          balance: 24,
          unique: 1,
          sets: 24
        }))
      ]
    },
    {
      table: SUBSCRIPTIONS_MODE_TABLE,
      rows: [
        {
          consolidation_key: 'auto',
          automatic: true,
          subscribe_all_editions: true
        },
        {
          consolidation_key: 'one',
          automatic: true,
          subscribe_all_editions: false
        },
        {
          consolidation_key: 'disabled',
          automatic: false,
          subscribe_all_editions: true
        }
      ]
    },
    {
      table: SUBSCRIPTIONS_BALANCES_TABLE,
      rows: [{ consolidation_key: 'auto', balance: 1 }]
    },
    {
      table: SUBSCRIPTIONS_NFTS_TABLE,
      rows: [
        automaticRow(555),
        automaticRow(557),
        automaticRow(558, 'auto', false),
        automaticRow(600, 'auto', false),
        automaticRow(599, 'auto', true, false),
        automaticRow(557, 'one'),
        automaticRow(557, 'disabled'),
        automaticRow(557, 'auto', true, true, '0xother')
      ]
    },
    {
      table: SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      rows: [
        {
          consolidation_key: 'auto',
          contract: MEMES_CONTRACT,
          token_id: 557,
          subscribed_count: 24,
          airdrop_address: '0xairdrop',
          balance: 1
        }
      ]
    }
  ],
  () => {
    afterEach(() => jest.restoreAllMocks());
    beforeEach(() =>
      jest.mocked(invalidateUpcomingSubscriptionCaches).mockReset()
    );

    it('bounds subscription and eligibility reads even when one consolidation has more than 500 future cards', async () => {
      await addSubscriptionPages();
      const execute = sqlExecutor.execute.bind(sqlExecutor);
      const pageSizes: number[] = [];
      jest
        .spyOn(sqlExecutor, 'execute')
        .mockImplementation(async (sql, params, options) => {
          const rows = await execute(sql, params, options);
          if (sql.startsWith('SELECT subscription.id'))
            pageSizes.push(rows.length);
          return rows;
        });
      expect(await sync(['auto'])).toEqual(['auto']);
      expect(pageSizes).toEqual([500, 2]);
      expect((await saved(1500))?.subscribed_count).toBe(24);
      expect((await saved(600))?.subscribed_count).toBe(11);
    });

    it('reconciles reset pages in separate transactions and evicts each only after commit', async () => {
      await addSubscriptionPages();
      const transaction = jest.spyOn(
        sqlExecutor,
        'executeNativeQueriesInTransaction'
      );
      jest
        .mocked(invalidateUpcomingSubscriptionCaches)
        .mockImplementation(async () => {
          // This read uses another connection, so it cannot see an uncommitted write.
          expect((await saved(557))?.subscribed_count).toBe(24);
        });
      await synchronizeAutomaticSubscriptionQuantitiesAfterReset();
      expect(transaction).toHaveBeenCalledTimes(2);
      expect(invalidateUpcomingSubscriptionCaches).toHaveBeenCalledTimes(2);
      expect((await saved(1500))?.subscribed_count).toBe(24);
      expect((await saved(600))?.subscribed_count).toBe(11);
    });

    it('rolls back a failed reset page, retains eviction of committed pages, and safely retries the sweep', async () => {
      await addSubscriptionPages();
      const execute = sqlExecutor.execute.bind(sqlExecutor);
      let updates = 0;
      const spy = jest
        .spyOn(sqlExecutor, 'execute')
        .mockImplementation(async (sql, params, options) => {
          if (
            sql.startsWith(`UPDATE ${SUBSCRIPTIONS_NFTS_TABLE} subscription`) &&
            ++updates === 2
          ) {
            throw new Error('page failed');
          }
          return execute(sql, params, options);
        });
      await expect(
        synchronizeAutomaticSubscriptionQuantitiesAfterReset()
      ).rejects.toThrow('page failed');
      expect(invalidateUpcomingSubscriptionCaches).toHaveBeenCalledTimes(1);
      expect((await saved(557))?.subscribed_count).toBe(24);
      expect((await saved(1500))?.subscribed_count).toBe(11);
      spy.mockRestore();
      await synchronizeAutomaticSubscriptionQuantitiesAfterReset();
      expect((await saved(1500))?.subscribed_count).toBe(24);
      expect((await saved(600))?.subscribed_count).toBe(11);
    });

    it('updates 11 to 24 in the upcoming API while preserving manual future cards and final allocations', async () => {
      const before = await saved(557);
      expect(await sync()).toEqual(['auto']);
      expect(await saved(557)).toEqual({ ...before, subscribed_count: 24 });
      for (const [id, key] of [
        [555, 'auto'],
        [558, 'auto'],
        [600, 'auto'],
        [599, 'auto'],
        [557, 'one'],
        [557, 'disabled']
      ] as const) {
        expect((await saved(id, key))?.subscribed_count).toBe(11);
      }
      const upcoming = await fetchUpcomingMemeSubscriptions('auto', 2);
      expect(upcoming.map((row) => row.subscribed_count)).toEqual([24, 11]);
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT subscribed_count FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`
        )
      ).toEqual({ subscribed_count: 24 });
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT subscribed_count FROM ${SUBSCRIPTIONS_NFTS_TABLE} WHERE contract = '0xother'`
        )
      ).toEqual({ subscribed_count: 11 });
      expect(await sync()).toEqual([]);
    });

    it('keeps a successful manual 11 through eligibility decreases and recovery', async () => {
      await sync();
      await updateSubscriptionCount('auto', MEMES_CONTRACT, 557, 11);
      await setEligibility(10);
      await setEligibility(12);
      const row = await saved(557);
      expect(row).toMatchObject({
        subscribed_count: 11,
        automatic_subscription: false
      });
      expect(
        resolveRequestedSubscriptionCount(
          row!,
          { subscribe_all_editions: true },
          12
        )
      ).toBe(11);
    });

    it('synchronizes when all-eligible preference is enabled while retaining manual future quantities', async () => {
      await updateSubscribeAllEditions('auto', false);
      expect((await saved(557))?.subscribed_count).toBe(11);
      await updateSubscribeAllEditions('auto', true);
      expect((await saved(557))?.subscribed_count).toBe(24);
      expect((await saved(600))?.subscribed_count).toBe(11);
    });

    it('synchronizes when automatic mode is enabled', async () => {
      await updateSubscriptionMode('auto', false);
      await updateSubscriptionMode('auto', true);
      expect((await saved(557))?.subscribed_count).toBe(24);
      expect((await saved(600))?.subscribed_count).toBe(11);
    });

    it('limits normal synchronization to the supplied consolidation keys', async () => {
      expect(await sync(['one'])).toEqual([]);
      expect((await saved(557))?.subscribed_count).toBe(11);
    });

    it.each([10, 0, -1])(
      'synchronizes a decrease to %s with the same minimum as finalization',
      async (sets) => {
        await setEligibility(sets);
        expect((await saved(557))?.subscribed_count).toBe(Math.max(1, sets));
        expect((await saved(600))?.subscribed_count).toBe(11);
      }
    );

    it('uses minimum eligibility when the current-season balance is deleted, including a reset sweep', async () => {
      await sqlExecutor.execute(
        `DELETE FROM ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE} WHERE consolidation_key = 'auto' AND season = 2`
      );
      await sync(undefined);
      expect((await saved(557))?.subscribed_count).toBe(1);
    });

    it.each(['manual quantity', 'manual mode'])(
      'preserves a concurrent %s committed between read and write',
      async (change) => {
        const execute = sqlExecutor.execute.bind(sqlExecutor);
        let changed = false;
        jest
          .spyOn(sqlExecutor, 'execute')
          .mockImplementation(async (sql, params, options) => {
            if (
              !changed &&
              sql.startsWith(`UPDATE ${SUBSCRIPTIONS_NFTS_TABLE} subscription`)
            ) {
              changed = true;
              if (change === 'manual quantity') {
                await execute(
                  `UPDATE ${SUBSCRIPTIONS_NFTS_TABLE} SET automatic_subscription = false WHERE consolidation_key = 'auto' AND token_id = 557`
                );
              } else {
                await execute(
                  `UPDATE ${SUBSCRIPTIONS_MODE_TABLE} SET automatic = false WHERE consolidation_key = 'auto'`
                );
              }
            }
            return execute(sql, params, options);
          });
        await sync();
        expect(changed).toBe(true);
        expect((await saved(557))?.subscribed_count).toBe(11);
      }
    );

    it('rolls back eligibility and synchronized quantities together on failure', async () => {
      await expect(
        sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
          await sqlExecutor.execute(
            `UPDATE ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE} SET sets = 12 WHERE consolidation_key = 'auto' AND season = 2`,
            undefined,
            { wrappedConnection: connection }
          );
          await synchronizeAutomaticSubscriptionQuantities(['auto'], {
            connection,
            timer: undefined
          });
          throw new Error('rollback');
        })
      ).rejects.toThrow('rollback');
      expect((await saved(557))?.subscribed_count).toBe(11);
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT sets FROM ${CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE} WHERE consolidation_key = 'auto' AND season = 2`
        )
      ).toEqual({ sets: 24 });
    });
  }
);
