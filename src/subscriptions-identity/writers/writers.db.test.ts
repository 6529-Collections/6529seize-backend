import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_REPORTS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE,
  TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { connect, disconnect } from '@/db';
import * as Entities from '@/entities/entities';
import { sqlExecutor } from '@/sql-executor';
import { getPublicSubscriptions } from '@/api/subscriptions/api.subscriptions.allowlist';
import { updateSubscriptions } from '@/subscriptionsDaily/subscriptions';
import { describeWithSeed } from '@/tests/_setup/seed';
import { redeemSubscriptions } from '@/transactionsProcessingLoop/subscriptions';
import { mirrorIdentityDirectory } from '../identity/identity-directory';
import {
  IDENTITY_FROM_ENV,
  SHADOW_ENV,
  subscriptionsIdentitySwitch
} from '../identity/identity-switch';
import { cutOpeningFiles } from '../opening/opening-build';
import { compareAndMarkVerified } from '../opening/opening-compare';
import { loadOpeningFiles, parseOpeningFiles } from '../opening/opening-load';
import {
  runIdentityRedemptionWriters,
  runIdentityTopUpWriters
} from './identity-loop-hooks';

const uploadFile = jest.fn();
jest.mock('@/arweave', () => ({
  arweaveFileUploader: {
    uploadFile: (...args: unknown[]) => uploadFile(...args)
  }
}));
jest.mock('@/notifier-discord', () => ({ sendDiscordUpdate: jest.fn() }));
jest.mock('@/subscription-wave-notifier', () => ({
  sendDailySubscriptionsWaveUpdate: jest.fn(),
  sendProcessedTopUpWaveWarning: jest.fn(),
  sendSubscriptionTopUpWaveUpdate: jest.fn(),
  sendNoSubscriptionFoundWaveWarning: jest.fn(),
  sendNoBalanceFoundWaveError: jest.fn(),
  sendInsufficientBalanceWaveError: jest.fn()
}));
jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn()
}));

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const P1 = `0x${'b1'.padStart(64, '0')}`;
/** Bound to P1; its key is itself. */
const A = wallet(1);
const LONE = wallet(4);
const CARD = 1;
const T1 = '2026-11-20 10:00:00.000000';
const T2 = '2026-11-21 11:00:00.000000';

const execute = (sql: string, params?: Record<string, unknown>) =>
  sqlExecutor.execute(sql, params);

async function seed() {
  await execute(`CREATE TABLE IF NOT EXISTS identity_chain_principals (
    principal_id varchar(66) NOT NULL PRIMARY KEY,
    profile_id varchar(50) NOT NULL UNIQUE,
    origin varchar(20) NOT NULL,
    created_at bigint NOT NULL)`);
  await execute(
    `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) VALUES (:a, :a)`,
    { a: A }
  );
  await execute(
    `INSERT INTO ${IDENTITIES_TABLE} (consolidation_key, profile_id, primary_address, tdh, rep, cic, level_raw)
      VALUES (:a, 'profile-1', :a, 0, 0, 0, 0)`,
    { a: A }
  );
  await execute(
    `INSERT INTO identity_chain_principals VALUES (:p, 'profile-1', 'LEGACY', 0)`,
    { p: P1 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance, created_at, updated_at)
      VALUES (:a, 0.5, :t1, :t1), (:lone, 0.2, :t1, :t1)`,
    { a: A, lone: LONE, t1: T1 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_MODE_TABLE} (consolidation_key, automatic, subscribe_all_editions, created_at, updated_at)
      VALUES (:a, true, false, :t1, :t1)`,
    { a: A, t1: T1 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE}
      (consolidation_key, contract, token_id, subscribed, subscribed_count, automatic_subscription, created_at, updated_at)
      VALUES (:lone, :c, :card, true, 1, false, :t2, :t2)`,
    { lone: LONE, c: MEMES_CONTRACT, card: CARD, t2: T2 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
      VALUES ('0xa0', 5, '2026-11-01 00:00:00', :a, 0.5), ('0xa1', 6, '2026-11-01 00:00:00', :lone, 0.2)`,
    { a: A, lone: LONE }
  );
  // Make the identity tables the truth: cut, load, verify, switch time passed.
  const files = await cutOpeningFiles(
    mirrorIdentityDirectory,
    Date.parse('2026-11-26T12:00:00Z')
  );
  const parsed = parseOpeningFiles(files.openingBytes, files.historyBytes);
  await loadOpeningFiles(parsed);
  const g4 = await compareAndMarkVerified(parsed, mirrorIdentityDirectory);
  expect(g4.ok).toBe(true);
  process.env[IDENTITY_FROM_ENV] = '2026-01-01T00:00:00Z';
  subscriptionsIdentitySwitch.invalidate();
}

async function finalIds(table: string, keyColumn: string) {
  return sqlExecutor.execute<{ id: number; key: string; phase: string | null }>(
    `SELECT id, ${keyColumn} AS \`key\`, phase FROM ${table}
      WHERE contract = :c AND token_id = :card ORDER BY id`,
    { c: MEMES_CONTRACT, card: CARD }
  );
}

async function balance(table: string, column: string, key: string) {
  const [row] = await sqlExecutor.execute<{ balance: number }>(
    `SELECT balance FROM ${table} WHERE ${column} = :key`,
    { key }
  );
  return row ? Number(row.balance) : null;
}

beforeAll(async () => {
  await connect(
    Object.values(Entities).filter((e) => typeof e === 'function') as never
  );
});

afterAll(async () => {
  await disconnect();
});

describeWithSeed('identity writers after the switch', [], () => {
  beforeEach(() => {
    uploadFile
      .mockReset()
      .mockResolvedValue({ url: 'https://example.test/list.csv' });
  });
  afterEach(() => {
    delete process.env[IDENTITY_FROM_ENV];
    subscriptionsIdentitySwitch.invalidate();
  });

  it('builds and publishes the list from the identity tables, with the same row ids in both tables', async () => {
    await seed();
    await updateSubscriptions();

    // Published once, with an identity column.
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(String(uploadFile.mock.calls[0][0])).toContain('identity');
    const identityRows = await finalIds(
      SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
      'identity_key'
    );
    const legacyRows = await finalIds(
      SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      'consolidation_key'
    );
    expect(identityRows.map((r) => r.key).sort()).toEqual([P1, LONE].sort());
    expect(legacyRows.map((r) => Number(r.id))).toEqual(
      identityRows.map((r) => Number(r.id))
    );
    const idOfLegacy = new Map(legacyRows.map((r) => [r.key, Number(r.id)]));
    const idOfIdentity = new Map(
      identityRows.map((r) => [r.key, Number(r.id)])
    );
    expect(idOfLegacy.get(A)).toBe(idOfIdentity.get(P1));
    expect(idOfLegacy.get(LONE)).toBe(idOfIdentity.get(LONE));

    const [report] = await sqlExecutor.execute<{ verdict: string }>(
      `SELECT verdict FROM ${SUBSCRIPTIONS_ID_REPORTS_TABLE} WHERE kind = 'LIST'`
    );
    expect(report.verdict).toBe('MATCH');

    // A phase pull splits the identity rows and writes both tables by id.
    const { airdrops } = await getPublicSubscriptions(MEMES_CONTRACT, CARD);
    expect(airdrops.map((a) => a.wallet).sort()).toEqual([A, LONE].sort());
    expect(
      (await finalIds(SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE, 'identity_key')).map(
        (r) => [Number(r.id), r.phase]
      )
    ).toEqual(
      (await finalIds(SUBSCRIPTIONS_NFTS_FINAL_TABLE, 'consolidation_key')).map(
        (r) => [Number(r.id), r.phase]
      )
    );
  });

  it('in shadow, publishes the legacy list and builds the identity list beside it with the same ids', async () => {
    await seed();
    delete process.env[IDENTITY_FROM_ENV];
    process.env[SHADOW_ENV] = 'true';
    subscriptionsIdentitySwitch.invalidate();
    try {
      await updateSubscriptions();
      expect(uploadFile).toHaveBeenCalledTimes(1);
      // The published file is the legacy one: no identity column.
      expect(String(uploadFile.mock.calls[0][0])).not.toContain('identity');
      expect(
        (await finalIds(SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE, 'identity_key')).map(
          (r) => Number(r.id)
        )
      ).toEqual(
        (
          await finalIds(SUBSCRIPTIONS_NFTS_FINAL_TABLE, 'consolidation_key')
        ).map((r) => Number(r.id))
      );
      const [report] = await sqlExecutor.execute<{
        verdict: string;
        mode: string;
      }>(
        `SELECT verdict, mode FROM ${SUBSCRIPTIONS_ID_REPORTS_TABLE} WHERE kind = 'LIST'`
      );
      expect(report).toEqual({ verdict: 'MATCH', mode: 'SHADOW' });
    } finally {
      delete process.env[SHADOW_ENV];
    }
  });

  it('charges an airdrop once in the identity tables, the same as the legacy loop', async () => {
    await seed();
    await updateSubscriptions();
    await execute(
      `INSERT INTO ${TRANSACTIONS_TABLE}
        (created_at, transaction, block, transaction_date, from_address, to_address,
         contract, token_id, token_count, value, primary_proceeds, royalties,
         gas_gwei, gas_price, gas_price_gwei, gas)
        VALUES (NOW(), '0xmint', 50, '2026-11-26 15:00:00', :null, :lone, :c, :card,
         1, 0, 0, 0, 0, 0, 0, 0)`,
      { null: NULL_ADDRESS, lone: LONE, c: MEMES_CONTRACT, card: CARD }
    );
    await execute(
      `INSERT INTO ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE} (created_at, block, timestamp)
        VALUES (NOW(), 49, 0)`
    );
    await redeemSubscriptions();
    await runIdentityRedemptionWriters();
    await runIdentityRedemptionWriters();

    expect(
      await balance(SUBSCRIPTIONS_ID_BALANCES_TABLE, 'identity_key', LONE)
    ).toBe(0.13471);
    expect(
      await balance(SUBSCRIPTIONS_BALANCES_TABLE, 'consolidation_key', LONE)
    ).toBe(0.13471);
    const [report] = await sqlExecutor.execute<{ verdict: string }>(
      `SELECT verdict FROM ${SUBSCRIPTIONS_ID_REPORTS_TABLE} WHERE kind = 'REDEMPTIONS'`
    );
    expect(report.verdict).toBe('MATCH');
  });

  it("credits a new top-up to the sender's identity once", async () => {
    await seed();
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa2', 60, '2026-11-26 13:00:00', :a, 0.1)`,
      { a: A }
    );
    await runIdentityTopUpWriters();
    await runIdentityTopUpWriters();
    expect(
      await balance(SUBSCRIPTIONS_ID_BALANCES_TABLE, 'identity_key', P1)
    ).toBe(0.6);
  });

  it('folds a wallet that binds after the opening into its identity', async () => {
    await seed();
    const W = wallet(7);
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa3', 61, '2026-11-26 13:00:00', :w, 0.25)`,
      { w: W }
    );
    await runIdentityTopUpWriters();
    expect(
      await balance(SUBSCRIPTIONS_ID_BALANCES_TABLE, 'identity_key', W)
    ).toBe(0.25);
    // W joins P1's identity on the chain; the mirror re-keys it.
    await execute(
      `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) VALUES (:w, :k)`,
      { w: W, k: `${A}-${W}` }
    );
    await execute(
      `UPDATE ${ADDRESS_CONSOLIDATION_KEY} SET consolidation_key = :k WHERE address = :a`,
      { k: `${A}-${W}`, a: A }
    );
    await execute(
      `UPDATE ${IDENTITIES_TABLE} SET consolidation_key = :k WHERE profile_id = 'profile-1'`,
      { k: `${A}-${W}` }
    );
    await runIdentityTopUpWriters();
    expect(
      await balance(SUBSCRIPTIONS_ID_BALANCES_TABLE, 'identity_key', W)
    ).toBe(null);
    expect(
      await balance(SUBSCRIPTIONS_ID_BALANCES_TABLE, 'identity_key', P1)
    ).toBe(0.75);
  });
});
