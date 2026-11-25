import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE,
  CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  MEMES_CONTRACT,
  NFT_OWNERS_CONSOLIDATION_TABLE,
  NULL_ADDRESS,
  TRANSFER_RECONCILIATIONS_TABLE
} from '@/constants';
import { consolidationTools } from '@/consolidation-tools';
import { connect, disconnect, getDataSource } from '@/db';
import * as Entities from '@/entities/entities';
import { updateAggregatedActivity } from '@/aggregatedActivityLoop/aggregated_activity';
import {
  consolidateNftOwners,
  updateNftOwners
} from '@/nftOwnersLoop/nft_owners';
import { updateOwnerBalances } from '@/ownersBalancesLoop/owners_balances';
import { sqlExecutor } from '@/sql-executor';
import { transferReconciliationDb } from '@/transactions/transfer-reconciliation.db';
import { sweepHoldingsKeys } from './holdings-key-sweep';

// Writing consolidated balances also syncs subscription quantities, caches
// and coverage (the subscriptions code's own tests cover those). The
// non-reset sync runs on a TypeORM transaction that the test executor can't
// drive, so those calls are stubbed here.
jest.mock('@/subscriptionsDaily/subscription-quantity-sync.db', () => ({
  synchronizeAutomaticSubscriptionQuantities: jest.fn(async () => []),
  synchronizeAutomaticSubscriptionQuantitiesAfterReset: jest.fn(
    async () => undefined
  )
}));
jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn(async () => undefined),
  retryPendingSubscriptionCacheInvalidations: jest.fn(async () => undefined)
}));
jest.mock('@/subscription-coverage/subscription-coverage-dirty', () => ({
  markSubscriptionCoverageDirtyForDemonstratedIntent: jest.fn(
    async () => undefined
  )
}));

// Tables these tests write, emptied before and after.
const TOUCHED = [
  'transactions',
  'memes_seasons',
  'nft_owners',
  'nft_owners_sync_state',
  NFT_OWNERS_CONSOLIDATION_TABLE,
  'owners_balances',
  'owners_balances_memes',
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE,
  'aggregated_activity',
  'aggregated_activity_memes',
  CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE,
  CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE,
  ADDRESS_CONSOLIDATION_KEY,
  TRANSFER_RECONCILIATIONS_TABLE
];

// The consolidated tables, ordered for comparison.
const CONSOLIDATED: [string, string][] = [
  [NFT_OWNERS_CONSOLIDATION_TABLE, 'consolidation_key, contract, token_id'],
  [CONSOLIDATED_OWNERS_BALANCES_TABLE, 'consolidation_key'],
  [CONSOLIDATED_OWNERS_BALANCES_MEMES_TABLE, 'consolidation_key, season'],
  [CONSOLIDATED_AGGREGATED_ACTIVITY_TABLE, 'consolidation_key'],
  [CONSOLIDATED_AGGREGATED_ACTIVITY_MEMES_TABLE, 'consolidation_key, season']
];

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const W = Array.from({ length: 8 }, (_, i) => wallet(i + 1));
const key = (...wallets: string[]) =>
  consolidationTools.buildConsolidationKey(wallets);

async function emptyTouchedTables() {
  for (const table of TOUCHED) {
    await getDataSource().query(`DELETE FROM ${table}`);
  }
}

/** The consolidated rows, without timestamps or block references. */
async function consolidatedState() {
  const state: Record<string, unknown[]> = {};
  for (const [table, order] of CONSOLIDATED) {
    const rows: Record<string, unknown>[] = await getDataSource().query(
      `SELECT * FROM ${table} ORDER BY ${order}`
    );
    state[table] = rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([column]) => !column.endsWith('_at') && column !== 'block_reference'
        )
      )
    );
  }
  return state;
}

async function runLoops() {
  await updateNftOwners();
  await updateAggregatedActivity();
  await updateOwnerBalances();
}

async function resetLoops() {
  await updateNftOwners(true);
  await updateAggregatedActivity(true);
  await updateOwnerBalances(true);
}

/**
 * Writes the keys as the identity mirror does and, in the same transaction,
 * queues the wallets as the mirror's own membership handler does.
 */
async function changeMembership(groups: string[][]) {
  const wallets = groups.flat();
  await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
    await sqlExecutor.execute(
      `DELETE FROM ${ADDRESS_CONSOLIDATION_KEY} WHERE address IN (:wallets)`,
      { wallets },
      { wrappedConnection: connection }
    );
    for (const group of groups.filter((g) => g.length > 1)) {
      for (const address of group) {
        await sqlExecutor.execute(
          `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key)
           VALUES (:address, :key)`,
          { address, key: key(...group) },
          { wrappedConnection: connection }
        );
      }
    }
    await transferReconciliationDb.enqueue(wallets, ['owners', 'activity'], {
      connection
    });
  });
}

async function queued(): Promise<number> {
  const [row]: { n: number }[] = await getDataSource().query(
    `SELECT COUNT(*) AS n FROM ${TRANSFER_RECONCILIATIONS_TABLE}`
  );
  return Number(row.n);
}

describe('holdings re-keyed through the membership queue', () => {
  const env = process.env;

  beforeAll(async () => {
    await connect(
      Object.values(Entities).filter((e) => typeof e === 'function'),
      false
    );
  });

  afterAll(async () => {
    await emptyTouchedTables();
    await disconnect();
    process.env = env;
  });

  beforeEach(async () => {
    // The mirror's handler queues whatever FEATURE_HOLDINGS_MEMBERSHIP_QUEUE
    // says, so the flag stays off here.
    process.env = { ...env };
    delete process.env.FEATURE_HOLDINGS_MEMBERSHIP_QUEUE;
    await emptyTouchedTables();
    // Three cards: with two, the card-set count takes the minimum of an
    // empty list (Infinity) for some wallets.
    await getDataSource().query(
      `INSERT INTO memes_seasons (id, start_index, end_index, count, name, display, boost)
       VALUES (1, 1, 3, 3, 'Season 1', 'SZN1', 0)`
    );
    // Each wallet mints one of card 1; the odd ones one of card 2 as well.
    let block = 100;
    for (let i = 0; i < W.length; i++) {
      const to = W[i];
      for (const tokenId of i % 2 === 0 ? [1, 2] : [1]) {
        await getDataSource().query(
          `INSERT INTO transactions (created_at, transaction, block, transaction_date,
             from_address, to_address, contract, token_id, token_count, value,
             primary_proceeds, royalties, gas_gwei, gas_price, gas_price_gwei, gas)
           VALUES (NOW(), ?, ?, '2026-11-01 00:00:00', ?, ?, ?, ?, 1, 0.06529,
             0.06529, 0, 0, 0, 0, 0)`,
          [
            `0x${(block * 10 + tokenId).toString(16).padStart(64, '0')}`,
            block++,
            NULL_ADDRESS,
            to,
            MEMES_CONTRACT,
            tokenId
          ]
        );
      }
    }
    // Before: W1-W4 are one identity; the rest stand alone.
    await changeMembership([W.slice(0, 4)]);
    await getDataSource().query(
      `DELETE FROM ${TRANSFER_RECONCILIATIONS_TABLE}`
    );
    await resetLoops();
  });

  it('regroups joins, removals and new identities from the queue, as a full reset would', async () => {
    const [w1, w2, w3, w4, w5, w6, w7] = W;
    // W5 joins W1-W4 (a 5-wallet key), W2 then leaves, W6 and W7 form an
    // identity.
    await changeMembership([[w1, w2, w3, w4, w5]]);
    await runLoops();
    await changeMembership([[w1, w3, w4, w5], [w2]]);
    await changeMembership([[w6, w7]]);
    await runLoops();

    expect(await queued()).toBe(0);
    const fromQueue = await consolidatedState();
    expect(
      (
        fromQueue[CONSOLIDATED_OWNERS_BALANCES_TABLE] as {
          consolidation_key: string;
        }[]
      )
        .map((row) => row.consolidation_key)
        .sort()
    ).toEqual(
      // The zero address holds a row too: the mints come from it.
      [NULL_ADDRESS, key(w1, w3, w4, w5), w2, key(w6, w7), W[7]].sort()
    );

    await resetLoops();
    expect(fromQueue).toEqual(await consolidatedState());

    const sweep = await sweepHoldingsKeys({ repair: false });
    expect(sweep.tables.map((result) => result.wallets_to_queue)).toEqual([
      0, 0, 0
    ]);
    // The grouped totals equal the wallets' totals.
    expect(sweep.sums?.nft_tokens_compared).toBeGreaterThan(0);
    expect(sweep.sums?.nft_tokens_differing).toBe(0);
    expect(sweep.sums?.consolidated_total_balance).toBe(
      sweep.sums?.wallet_total_balance
    );
  });

  it('gives the same rows when a group is regrouped across two queue batches', async () => {
    const group = W.slice(0, 5);
    await changeMembership([group]);
    await getDataSource().query(
      `DELETE FROM ${TRANSFER_RECONCILIATIONS_TABLE}`
    );

    await consolidateNftOwners(new Set(group.slice(0, 2)));
    await consolidateNftOwners(new Set(group.slice(2)));
    const inTwoBatches = await consolidatedState();
    await consolidateNftOwners(new Set(group));

    expect(inTwoBatches[NFT_OWNERS_CONSOLIDATION_TABLE]).toEqual(
      (await consolidatedState())[NFT_OWNERS_CONSOLIDATION_TABLE]
    );
  });

  it('finds and repairs a group the queueing missed', async () => {
    const group = W.slice(0, 5);
    // The keys change with nothing queued, as if the mirror's queueing were lost.
    await getDataSource().query(
      `UPDATE ${ADDRESS_CONSOLIDATION_KEY} SET consolidation_key = ? WHERE address IN (?)`,
      [key(...group), group.slice(0, 4)]
    );
    await getDataSource().query(
      `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) VALUES (?, ?)`,
      [group[4], key(...group)]
    );

    const found = await sweepHoldingsKeys({ repair: true });
    expect(found.tables.every((result) => result.wallets_queued > 0)).toBe(
      true
    );
    await runLoops();
    await updateOwnerBalances();

    const repaired = await consolidatedState();
    await resetLoops();
    expect(repaired).toEqual(await consolidatedState());
    expect(
      (await sweepHoldingsKeys({ repair: false })).tables.map(
        (r) => r.wallets_to_queue
      )
    ).toEqual([0, 0, 0]);
  });
});
