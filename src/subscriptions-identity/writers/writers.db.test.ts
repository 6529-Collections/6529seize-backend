import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_CURSORS_TABLE,
  SUBSCRIPTIONS_ID_STATE_TABLE,
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
  scheduleIdentitySwitch,
  SHADOW_ENV,
  subscriptionsIdentitySwitch
} from '../identity/identity-switch';
import { cutOpeningFiles } from '../opening/opening-build';
import { compareAndMarkVerified } from '../opening/opening-compare';
import {
  IDENTITY_DATA_TABLES,
  loadOpeningFiles,
  parseOpeningFiles
} from '../opening/opening-load';
import { publishOpeningFiles } from '../opening/published-chain';
import { rebuildIdentityTables } from '../opening/rebuild';
import {
  fetchDetailsForConsolidationKey,
  fetchFinalSubscription,
  fetchLogsForConsolidationKey,
  fetchRedeemedSubscriptionsForConsolidationKey,
  fetchSubscriptionUploads,
  fetchTopUpsForConsolidationKey
} from '@/api/subscriptions/api.subscriptions.db';
import {
  runIdentityRedemptionWriters,
  runIdentityTopUpWriters
} from './identity-loop-hooks';
import { shadowReportsMatch } from './identity-reports';

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
const C = wallet(3);
const LONE = wallet(4);
const CARD = 1;
const T1 = '2026-11-20 10:00:00.000000';
const T2 = '2026-11-21 11:00:00.000000';

const execute = (sql: string, params?: Record<string, unknown>) =>
  sqlExecutor.execute(sql, params);

/** What the (mocked) uploader has published, by URL. */
const published = new Map<string, string>();

/** The legacy state, with the redemption loop's cursor at block 1. */
async function seedLegacy() {
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
  await execute(
    `INSERT INTO ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE} (created_at, block, timestamp)
      VALUES (NOW(), 1, 0)`
  );
}

/** Cut, load and verify; with `goLive`, set the switch time to now. */
async function cutAndLoad(goLive: boolean) {
  const files = await cutOpeningFiles(
    mirrorIdentityDirectory,
    Date.parse('2026-11-26T12:00:00Z')
  );
  const parsed = parseOpeningFiles(files.openingBytes, files.historyBytes);
  await loadOpeningFiles(parsed);
  const g4 = await compareAndMarkVerified(parsed, mirrorIdentityDirectory);
  expect(g4.ok).toBe(true);
  if (goLive) {
    expect(await scheduleIdentitySwitch(Date.now(), parsed.openingSha256)).toBe(
      true
    );
  }
  subscriptionsIdentitySwitch.invalidate();
  return files;
}

async function seed() {
  await seedLegacy();
  await cutAndLoad(true);
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
    published.clear();
    uploadFile.mockReset().mockImplementation(async (bytes: Buffer) => {
      const url = `https://example.test/file-${published.size}`;
      published.set(url, bytes.toString('utf8'));
      return { url };
    });
  });
  afterEach(() => {
    delete process.env[SHADOW_ENV];
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
    await seedLegacy();
    await cutAndLoad(false);
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
      // go-live checks these: a later shadow DIFF stops it.
      expect((await shadowReportsMatch()).ok).toBe(true);
      await execute(
        `INSERT INTO ${SUBSCRIPTIONS_ID_REPORTS_TABLE} (kind, mode, verdict, report, created_at)
          VALUES ('PHASE', 'SHADOW', 'DIFF', '{}', 0)`
      );
      expect(await shadowReportsMatch()).toEqual({
        ok: false,
        detail: `1 shadow comparisons differ since card ${CARD}: PHASE`
      });
    } finally {
      delete process.env[SHADOW_ENV];
    }
  });

  it('gives one shared id to one legacy row of an identity whose re-key was held back', async () => {
    await seedLegacy();
    // C joined A's identity, but the legacy re-key was held back: C's own
    // key still holds a balance and an automatic mode.
    await execute(
      `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) VALUES (:c, :k)`,
      { c: C, k: `${A}-${C}` }
    );
    await execute(
      `UPDATE ${ADDRESS_CONSOLIDATION_KEY} SET consolidation_key = :k WHERE address = :a`,
      { k: `${A}-${C}`, a: A }
    );
    await execute(
      `UPDATE ${IDENTITIES_TABLE} SET consolidation_key = :k WHERE profile_id = 'profile-1'`,
      { k: `${A}-${C}` }
    );
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance) VALUES (:c, 0.5)`,
      { c: C }
    );
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_MODE_TABLE} (consolidation_key, automatic, subscribe_all_editions)
        VALUES (:c, true, false)`,
      { c: C }
    );
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xc0', 4, '2026-11-01 00:00:00', :c, 0.5)`,
      { c: C }
    );
    // The airdrop rule needs a TDH wallet for a two-wallet key.
    const required = await sqlExecutor.execute<{ c: string }>(
      `SELECT column_name AS c FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = 'tdh'
          AND is_nullable = 'NO' AND column_default IS NULL`
    );
    const columns = required.map((r) => r.c);
    await execute(
      `INSERT INTO tdh (${columns.map((n) => `\`${n}\``).join(', ')})
        VALUES (${columns
          .map((n) =>
            n === 'wallet'
              ? `'${A}'`
              : n === 'date'
                ? 'NOW()'
                : n === 'boosted_tdh'
                  ? '10'
                  : '0'
          )
          .join(', ')})`
    );
    await cutAndLoad(true);

    await updateSubscriptions();

    const identityRows = await finalIds(
      SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
      'identity_key'
    );
    const legacyRows = await finalIds(
      SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      'consolidation_key'
    );
    const p1Id = identityRows.find((r) => r.key === P1)?.id;
    expect(p1Id).toBeDefined();
    // One of A's and C's legacy rows shares P1's id; the other is left out.
    expect(
      legacyRows.filter((r) => Number(r.id) === Number(p1Id))
    ).toHaveLength(1);
    expect(legacyRows.filter((r) => r.key === A || r.key === C)).toHaveLength(
      1
    );
    expect(uploadFile).toHaveBeenCalledTimes(1);
    const [report] = await sqlExecutor.execute<{
      verdict: string;
      report: string;
    }>(
      `SELECT verdict, report FROM ${SUBSCRIPTIONS_ID_REPORTS_TABLE} WHERE kind = 'LIST'`
    );
    expect(report.verdict).toBe('DIFF');
    expect(String(report.report)).toContain(
      'second legacy row of one identity'
    );
  });

  it('rebuilds empty identity tables from the published chain and the sources, giving the same API answers', async () => {
    await seedLegacy();
    const files = await cutAndLoad(true);
    await publishOpeningFiles(files);
    // After the switch: a top-up, a daily build (published with its build
    // record) and an airdrop charged.
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa5', 30, '2026-11-26 13:00:00', :lone, 0.05)`,
      { lone: LONE }
    );
    await runIdentityTopUpWriters();
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
    await redeemSubscriptions();
    await runIdentityRedemptionWriters();

    const answers = async () => {
      const out: Record<string, unknown> = {};
      for (const key of [A, P1, LONE]) {
        const strip = (rows: any[], fields: string[]) =>
          rows.map((r) => fields.map((f) => String(r[f])).join('|')).sort();
        out[key] = {
          details: await fetchDetailsForConsolidationKey(key),
          final: (({
            id,
            identity_key,
            subscribed_count,
            airdrop_address,
            balance
          }: any) => ({
            id,
            identity_key,
            subscribed_count,
            airdrop_address,
            balance
          }))((await fetchFinalSubscription(key, MEMES_CONTRACT, CARD)) ?? {}),
          redeemed: strip(
            (await fetchRedeemedSubscriptionsForConsolidationKey(key, 50, 1))
              .data,
            ['transaction', 'count', 'value', 'balance_after']
          ),
          topUps: strip(
            (await fetchTopUpsForConsolidationKey(key, 50, 1)).data,
            ['hash', 'amount']
          ),
          logs: strip((await fetchLogsForConsolidationKey(key, 200, 1)).data, [
            'log',
            'additional_info'
          ])
        };
      }
      out.uploads = (
        await fetchSubscriptionUploads(MEMES_CONTRACT, 10, 1)
      ).data.map((u: any) => u.upload_url);
      return out;
    };
    const before = await answers();
    const [state] = await sqlExecutor.execute<{
      head_uri: string;
      head_sha256: string;
    }>(`SELECT head_uri, head_sha256 FROM ${SUBSCRIPTIONS_ID_STATE_TABLE}`);
    expect(state.head_uri).not.toBe(files.openingSha256);

    // Lose every identity table, then rebuild from the head.
    for (const table of [
      ...IDENTITY_DATA_TABLES,
      SUBSCRIPTIONS_ID_STATE_TABLE,
      SUBSCRIPTIONS_ID_CURSORS_TABLE
    ]) {
      await execute(`DELETE FROM ${table}`);
    }
    subscriptionsIdentitySwitch.invalidate();
    const result = await rebuildIdentityTables({
      head: { uri: state.head_uri, sha256: state.head_sha256 },
      fetch: async (uri) => {
        const bytes = published.get(uri);
        if (bytes === undefined) {
          throw new Error(`not published: ${uri}`);
        }
        return bytes;
      }
    });
    expect(result).toEqual(
      expect.objectContaining({
        buildRecords: 1,
        topUpsCredited: 1,
        airdropsCharged: 1
      })
    );
    expect(await answers()).toEqual(before);
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

  it('turns automatic mode on for a first top-up as the legacy mode change does', async () => {
    await seed();
    const W = wallet(8);
    // W unsubscribed from the upcoming card before it had a balance.
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_TABLE}
        (identity_key, contract, token_id, subscribed, subscribed_count, automatic_subscription)
        VALUES (:w, :c, :card, false, 1, false)`,
      { w: W, c: MEMES_CONTRACT, card: CARD }
    );
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa4', 62, '2026-11-26 14:00:00', :w, 0.1)`,
      { w: W }
    );
    await runIdentityTopUpWriters();
    const [mode] = await sqlExecutor.execute<{
      automatic: number;
      updated_at: string;
    }>(
      `SELECT automatic, DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s') AS updated_at
         FROM ${SUBSCRIPTIONS_ID_MODE_TABLE} WHERE identity_key = :w`,
      { w: W }
    );
    // The mode time is the top-up's transaction time, so a rebuild writes it too.
    expect([Number(mode.automatic), mode.updated_at]).toEqual([
      1,
      '2026-11-26 14:00:00'
    ]);
    const [row] = await sqlExecutor.execute<{ subscribed: number }>(
      `SELECT subscribed FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE} WHERE identity_key = :w`,
      { w: W }
    );
    expect(Number(row.subscribed)).toBe(1);
    const lines = await sqlExecutor.execute<{ log: string }>(
      `SELECT log FROM ${SUBSCRIPTIONS_ID_LOGS_TABLE} WHERE identity_key = :w ORDER BY id`,
      { w: W }
    );
    expect(lines.map((l) => l.log)).toEqual([
      'Subscription Mode set to Automatic',
      `Subscribed to Meme #${CARD}`
    ]);
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
