import 'reflect-metadata';
import {
  MEMES_CONTRACT,
  SUBSCRIPTION_DEFERRED_WRITES_TABLE,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE
} from '@/constants';
import { connect, disconnect } from '@/db';
import * as Entities from '@/entities/entities';
import { sqlExecutor } from '@/sql-executor';
import {
  claimDeferredWrite,
  deferSubscriptionWrites,
  executorSink
} from '@/subscription-key-width/subscription-deferred-writes';
import { subscriptionKeyWidths } from '@/subscription-key-width/subscription-key-width';
import { describeWithSeed } from '@/tests/_setup/seed';
import type { IdentityDirectory } from '../identity/identity-directory';
import { copyLegacyHistory, copyLegacyState } from './legacy-copy';

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
/** A key the legacy tables hold. */
const FITS = wallet(1);
/** A key with a write waiting in the deferred writes queue. */
const WAITING = wallet(2);
/** A key wider than the narrowest legacy key column. */
const WIDE = Array.from({ length: 20 }, (_, i) => wallet(100 + i)).join('-');

/** Each identity is its own key, as for a wallet with no profile. */
const directory: IdentityDirectory = {
  identitiesOf: async (wallets) => new Map(wallets.map((w) => [w, w])),
  consolidationKeysOf: async (keys) => new Map(keys.map((k) => [k, k]))
};

async function waitOn(key: string): Promise<void> {
  await deferSubscriptionWrites(
    [
      {
        kind: 'LOG',
        consolidationKey: key,
        dedupe: `earlier-${key}`,
        payload: {},
        reason: { narrow: [], pendingEarlier: false }
      }
    ],
    executorSink()
  );
}

beforeAll(async () => {
  await connect(
    Object.values(Entities).filter((e) => typeof e === 'function') as never
  );
});

afterAll(async () => {
  await disconnect();
});

describeWithSeed('the rollback copy and the key-width guard', [], () => {
  beforeEach(async () => {
    subscriptionKeyWidths.invalidate();
    const narrowest = await subscriptionKeyWidths.minWidth([
      SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      SUBSCRIPTIONS_REDEEMED_TABLE,
      SUBSCRIPTIONS_BALANCES_TABLE
    ]);
    expect(WIDE.length).toBeGreaterThan(narrowest);
    await waitOn(WAITING);
  });

  it('leaves out the final rows and redemptions of keys the guard holds back, and counts them', async () => {
    for (const key of [FITS, WAITING, WIDE]) {
      await sqlExecutor.execute(
        `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}
          (identity_key, consolidation_key, contract, token_id, subscribed_count,
           airdrop_address, balance)
          VALUES (:identity, :key, :contract, 1, 1, :airdrop, 0.5)`,
        {
          identity: key.slice(0, 42),
          key,
          contract: MEMES_CONTRACT,
          airdrop: key.slice(0, 42)
        }
      );
      await sqlExecutor.execute(
        `INSERT INTO ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}
          (identity_key, contract, token_id, address, \`transaction\`,
           transaction_date, consolidation_key, value, balance_after, count)
          VALUES (:identity, :contract, 1, :address, :hash, NOW(), :key, 0.06, 0.44, 1)`,
        {
          identity: key.slice(0, 42),
          contract: MEMES_CONTRACT,
          address: key.slice(0, 42),
          hash: `0x${key.slice(2, 42)}`,
          key
        }
      );
    }

    expect(await copyLegacyHistory()).toEqual({
      finals: 1,
      redemptions: 1,
      leftOut: 4
    });
    for (const table of [
      SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      SUBSCRIPTIONS_REDEEMED_TABLE
    ]) {
      expect(
        await sqlExecutor.execute(`SELECT consolidation_key FROM ${table}`)
      ).toEqual([{ consolidation_key: FITS }]);
    }
  });

  it('leaves out the balances, modes and choices of keys the guard holds back, and counts them', async () => {
    const wideDirectory: IdentityDirectory = {
      ...directory,
      // The third identity's consolidation key is wider than the tables.
      consolidationKeysOf: async (keys) =>
        new Map(keys.map((k) => [k, k === wallet(3) ? WIDE : k]))
    };
    for (const identity of [FITS, WAITING, wallet(3)]) {
      await sqlExecutor.execute(
        `INSERT INTO ${SUBSCRIPTIONS_ID_BALANCES_TABLE} (identity_key, balance)
          VALUES (:identity, 0.5)`,
        { identity }
      );
    }

    expect(await copyLegacyState(wideDirectory)).toEqual({
      balances: 1,
      modes: 0,
      choices: 0,
      leftOut: 2
    });
    expect(
      await sqlExecutor.execute(
        `SELECT consolidation_key FROM ${SUBSCRIPTIONS_BALANCES_TABLE}`
      )
    ).toEqual([{ consolidation_key: FITS }]);
  });

  it('copies the rows of a key whose waiting writes were all replayed', async () => {
    const replayed = wallet(4);
    await waitOn(replayed);
    // The queue's replay claims each of the key's writes as done.
    const queued = await sqlExecutor.execute<{ sequence: number }>(
      `SELECT sequence FROM ${SUBSCRIPTION_DEFERRED_WRITES_TABLE}
        WHERE consolidation_key = :key ORDER BY sequence`,
      { key: replayed }
    );
    expect(queued).toHaveLength(1);
    for (const { sequence } of queued) {
      expect(
        await claimDeferredWrite(Number(sequence), 'DONE', executorSink())
      ).toBe(true);
    }
    await sqlExecutor.execute(
      `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}
        (identity_key, consolidation_key, contract, token_id, subscribed_count,
         airdrop_address, balance)
        VALUES (:key, :key, :contract, 1, 1, :key, 0.5)`,
      { key: replayed, contract: MEMES_CONTRACT }
    );
    await sqlExecutor.execute(
      `INSERT INTO ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}
        (identity_key, contract, token_id, address, \`transaction\`,
         transaction_date, consolidation_key, value, balance_after, count)
        VALUES (:key, :contract, 1, :key, :hash, NOW(), :key, 0.06, 0.44, 1)`,
      { key: replayed, contract: MEMES_CONTRACT, hash: `0x${'d4'.repeat(32)}` }
    );
    await sqlExecutor.execute(
      `INSERT INTO ${SUBSCRIPTIONS_ID_BALANCES_TABLE} (identity_key, balance)
        VALUES (:key, 0.44)`,
      { key: replayed }
    );

    expect(await copyLegacyHistory()).toMatchObject({
      finals: 1,
      redemptions: 1,
      leftOut: 0
    });
    expect(await copyLegacyState(directory)).toMatchObject({
      balances: 1,
      leftOut: 0
    });
    for (const table of [
      SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      SUBSCRIPTIONS_REDEEMED_TABLE,
      SUBSCRIPTIONS_BALANCES_TABLE
    ]) {
      expect(
        await sqlExecutor.execute(`SELECT consolidation_key FROM ${table}`)
      ).toEqual([{ consolidation_key: replayed }]);
    }
  });
});
