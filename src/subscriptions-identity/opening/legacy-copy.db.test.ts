import 'reflect-metadata';
import {
  MEMES_CONTRACT,
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
  deferSubscriptionWrites,
  executorSink,
  SUBSCRIPTION_WRITE_TABLES
} from '@/subscription-key-width/subscription-deferred-writes';
import { subscriptionKeyWidths } from '@/subscription-key-width/subscription-key-width';
import { describeWithSeed } from '@/tests/_setup/seed';
import type { IdentityDirectory } from '../identity/identity-directory';
import { copyLegacyHistory, copyLegacyState } from './legacy-copy';

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
/** A key the legacy tables hold. */
const FITS = wallet(1);
/** A key that fits but has an earlier write waiting in the queue. */
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

/** A final row and a redemption for a key, on the identity side. */
async function identityHistory(key: string): Promise<void> {
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

const keysIn = async (table: string) =>
  (
    await sqlExecutor.execute<{ consolidation_key: string }>(
      `SELECT consolidation_key FROM ${table} ORDER BY consolidation_key`
    )
  ).map((row) => row.consolidation_key);

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
    const narrowest = await subscriptionKeyWidths.minWidth(
      SUBSCRIPTION_WRITE_TABLES
    );
    expect(WIDE.length).toBeGreaterThan(narrowest);
    expect(WAITING.length).toBeLessThanOrEqual(narrowest);
    await waitOn(WAITING);
  });

  it('leaves out the final rows and redemptions of keys wider than the legacy columns, and counts them', async () => {
    for (const key of [FITS, WAITING, WIDE]) {
      await identityHistory(key);
    }

    expect(await copyLegacyHistory()).toEqual({
      finals: 2,
      uploads: 0,
      redemptions: 2,
      leftOut: 2
    });
    for (const table of [
      SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      SUBSCRIPTIONS_REDEEMED_TABLE
    ]) {
      expect(await keysIn(table)).toEqual([FITS, WAITING]);
    }
  });

  it('leaves out the balances, modes and choices of keys wider than the legacy columns, and counts them', async () => {
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
      balances: 2,
      modes: 0,
      choices: 0,
      leftOut: 1
    });
    expect(await keysIn(SUBSCRIPTIONS_BALANCES_TABLE)).toEqual([FITS, WAITING]);
  });

  it('copies the rows of a fitting key with an earlier write still waiting, which production holds until the replay, so the rows compare differently', async () => {
    // Production's rollback copy: the waiting key's writes are held back,
    // so only the fitting key has legacy rows.
    for (const key of [FITS, WAITING]) {
      await identityHistory(key);
    }
    await copyLegacyHistory();
    await sqlExecutor.execute(
      `DELETE FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} WHERE consolidation_key = :key`,
      { key: WAITING }
    );
    await sqlExecutor.execute(
      `DELETE FROM ${SUBSCRIPTIONS_REDEEMED_TABLE} WHERE consolidation_key = :key`,
      { key: WAITING }
    );
    const production = {
      finals: await keysIn(SUBSCRIPTIONS_NFTS_FINAL_TABLE),
      redemptions: await keysIn(SUBSCRIPTIONS_REDEEMED_TABLE)
    };
    expect(production).toEqual({ finals: [FITS], redemptions: [FITS] });

    // The rebuild's copy applies the width rule only, without the queue.
    await sqlExecutor.execute(`DELETE FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`);
    await sqlExecutor.execute(`DELETE FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}`);
    await copyLegacyHistory();
    const rebuilt = {
      finals: await keysIn(SUBSCRIPTIONS_NFTS_FINAL_TABLE),
      redemptions: await keysIn(SUBSCRIPTIONS_REDEEMED_TABLE)
    };
    // The waiting key's rows are extra, so a row comparison of the two
    // sides shows them rather than hiding them.
    expect(rebuilt).toEqual({
      finals: [FITS, WAITING],
      redemptions: [FITS, WAITING]
    });
    expect(rebuilt).not.toEqual(production);
  });
});
