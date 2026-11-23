import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  MEMES_CONTRACT,
  NULL_ADDRESS,
  SUBSCRIPTIONS_ADDRESS,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_MODE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_TABLE,
  SUBSCRIPTIONS_ID_CURSORS_TABLE,
  SUBSCRIPTIONS_ID_STATE_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_ID_REDEEMED_TABLE,
  SUBSCRIPTIONS_ID_REPORTS_TABLE,
  SUBSCRIPTIONS_ID_TOP_UP_TABLE,
  SIGNED_RECORD_HEADS_TABLE,
  SIGNED_RECORD_LOG_ENTRIES_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE,
  TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE,
  TRANSACTIONS_TABLE
} from '@/constants';
import { connect, disconnect } from '@/db';
import { Logger } from '@/logging';
import * as Entities from '@/entities/entities';
import { sqlExecutor } from '@/sql-executor';
import { getPublicSubscriptions } from '@/api/subscriptions/api.subscriptions.allowlist';
import { updateSubscriptions } from '@/subscriptionsDaily/subscriptions';
import { describeWithSeed } from '@/tests/_setup/seed';
import { redeemSubscriptions } from '@/transactionsProcessingLoop/subscriptions';
import { mirrorIdentityDirectory } from '../identity/identity-directory';
import {
  claimSubscriptionWrites,
  closeSubscriptionWrites,
  openSubscriptionWrites,
  releaseSubscriptionWrites,
  renewSubscriptionWrites,
  scheduleIdentitySwitch,
  SHADOW_ENV,
  SubscriptionsIdentitySwitch,
  subscriptionsIdentitySwitch,
  suspendIdentityTables,
  SWITCH_CUT_WINDOW_MS,
  subscriptionWritePathNow
} from '../identity/identity-switch';
import { cutOpeningFiles } from '../opening/opening-build';
import { compareAndMarkVerified } from '../opening/opening-compare';
import {
  IDENTITY_DATA_TABLES,
  loadOpeningFiles,
  parseOpeningFiles,
  REDEMPTION_CURSOR_ID
} from '../opening/opening-load';
import { suspendWithJournal } from '../opening/suspend';
import { copyLegacyHistory } from '../opening/legacy-copy';
import {
  JournalSource,
  rebuildIdentityTables,
  setJournalSource,
  verifyPostedJournal
} from '../opening/rebuild';
import type { EthereumFacts } from '../timeline/journal-verify';
import {
  identityTablesHash,
  journal,
  journalBefore,
  journalBodyOf,
  journalCheckpoint,
  JOURNAL_PART_MAX_BYTES,
  journalPosting,
  JOURNAL_POSTING_MAX_AGE_MS,
  journalPostingProbe
} from '../timeline/journal';
import { recordLogDb } from '@/signed-records/record-log/record-log.db';
import {
  RecordLogSegmenter,
  RecordsWavePoster
} from '@/signed-records/record-log/record-log.service';
import { creditIdentityTopUps } from './identity-top-ups';
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
import {
  GO_LIVE_MAX_REFUSED_PERCENT_ENV,
  GO_LIVE_MIN_SIGNED_MATCHES_ENV,
  saveReport,
  shadowReportsMatch
} from './identity-reports';
import { buildIdentityList, SHADOW_ONLY_ID_FROM } from './identity-daily-build';
import { goLive } from '../opening/go-live';
import { subscriptionChangeWriter } from '../records/subscription-writes';

const uploadFile = jest.fn();
jest.mock('@/arweave', () => ({
  arweaveFileUploader: {
    uploadFile: (...args: unknown[]) => uploadFile(...args)
  }
}));
jest.mock('@/notifier-discord', () => ({ sendDiscordUpdate: jest.fn() }));
const noSubscriptionWarning = jest.fn();
jest.mock('@/subscription-wave-notifier', () => ({
  sendDailySubscriptionsWaveUpdate: jest.fn(),
  sendProcessedTopUpWaveWarning: jest.fn(),
  sendSubscriptionTopUpWaveUpdate: jest.fn(),
  sendNoSubscriptionFoundWaveWarning: (...args: unknown[]) =>
    noSubscriptionWarning(...args),
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
const NOV_20 = '2026-11-20 10:00:00.000000';
const NOV_21 = '2026-11-21 11:00:00.000000';

const execute = (sql: string, params?: Record<string, unknown>) =>
  sqlExecutor.execute(sql, params);

/** An unsigned unsubscribe from the open card, as the write route makes it. */
const unsignedUnsubscribe = (key: string) =>
  subscriptionChangeWriter.write({
    routeKey: key,
    wallet: key,
    walletInKey: true,
    signedRecords: undefined,
    change: {
      type: 'subs.card',
      contract: MEMES_CONTRACT,
      tokenId: CARD,
      subscribed: false
    }
  });

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
    { a: A, lone: LONE, t1: NOV_20 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_MODE_TABLE} (consolidation_key, automatic, subscribe_all_editions, created_at, updated_at)
      VALUES (:a, true, false, :t1, :t1)`,
    { a: A, t1: NOV_20 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE}
      (consolidation_key, contract, token_id, subscribed, subscribed_count, automatic_subscription, created_at, updated_at)
      VALUES (:lone, :c, :card, true, 1, false, :t2, :t2)`,
    { lone: LONE, c: MEMES_CONTRACT, card: CARD, t2: NOV_21 }
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

/** The record log's public chain, in log order, as a rebuild reads it. */
const journalSource: JournalSource = {
  async *walk() {
    const rows = await sqlExecutor.execute<{ entry: string }>(
      `SELECT entry FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE} WHERE chain = 'public' ORDER BY id`
    );
    for (const row of rows) {
      yield { entry: JSON.parse(row.entry) };
    }
  }
};

/** Ethereum as the legacy loops recorded it: their top-up and airdrop rows, read now. */
async function ethereumAsRecorded(): Promise<EthereumFacts> {
  const topUps = await sqlExecutor.execute<{
    hash: string;
    block: number;
    from_wallet: string;
    amount: number;
  }>(
    `SELECT hash, block, from_wallet, amount FROM ${SUBSCRIPTIONS_TOP_UP_TABLE}`
  );
  const mints = await sqlExecutor.execute<{
    transaction: string;
    contract: string;
    token_id: number;
    to_address: string;
    token_count: number;
  }>(
    `SELECT \`transaction\`, contract, token_id, to_address, token_count
       FROM ${TRANSACTIONS_TABLE} WHERE from_address = :nullAddress`,
    { nullAddress: NULL_ADDRESS }
  );
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return {
    topUp: async (hash) => {
      const row = topUps.find((t) => same(t.hash, hash));
      return row
        ? {
            from: row.from_wallet,
            to: SUBSCRIPTIONS_ADDRESS,
            valueEth: Number(row.amount),
            block: Number(row.block)
          }
        : null;
    },
    mintedTo: async (hash, contract, tokenId, to) =>
      mints
        .filter(
          (m) =>
            same(m.transaction, hash) &&
            same(m.contract, contract) &&
            Number(m.token_id) === tokenId &&
            same(m.to_address, to)
        )
        .reduce((sum, m) => sum + Number(m.token_count), 0)
  };
}

async function fetchPublished(uri: string): Promise<string> {
  const bytes = published.get(uri);
  if (bytes === undefined) {
    throw new Error(`not published: ${uri}`);
  }
  return bytes;
}

function goLiveForTest() {
  return goLive({
    signedWritesLive: true,
    acceptReportDiffs: true,
    mintedCard: 0,
    postingProbe,
    settleMs: 0
  });
}

/** The record log's closer, as go-live's probe sees it in these tests. */
let closerPosts = true;
const postingProbe = async () => closerPosts;

/** Every identity table, its state and its cursors are lost. */
async function loseIdentityTables() {
  for (const table of [
    ...IDENTITY_DATA_TABLES,
    SUBSCRIPTIONS_ID_STATE_TABLE,
    SUBSCRIPTIONS_ID_CURSORS_TABLE
  ]) {
    await execute(`DELETE FROM ${table}`);
  }
  subscriptionsIdentitySwitch.invalidate();
}

async function identityBalances(): Promise<Record<string, number>> {
  const rows = await sqlExecutor.execute<{
    identity_key: string;
    balance: number;
  }>(`SELECT identity_key, balance FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE}`);
  return Object.fromEntries(
    rows.map((r) => [r.identity_key, Number(r.balance)])
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

describeWithSeed('identity writers after the switch', [], () => {
  beforeEach(() => {
    published.clear();
    uploadFile.mockReset().mockImplementation(async (bytes: Buffer) => {
      const url = `https://example.test/file-${published.size}`;
      published.set(url, bytes.toString('utf8'));
      return { url };
    });
  });
  beforeEach(() => {
    closerPosts = true;
  });
  afterEach(() => {
    delete process.env[SHADOW_ENV];
    subscriptionsIdentitySwitch.invalidate();
  });

  it('builds and publishes the list from the identity tables, with the same row ids in both tables', async () => {
    await seed();
    await updateSubscriptions();

    // Published once to Arweave, the default uploader, with an identity
    // column.
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(uploadFile.mock.calls[0][1]).toBe('text/csv');
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

  it('publishes the list through the uploader it is given in place of Arweave, after the switch and in shadow', async () => {
    const given = jest.fn(
      async (bytes: Buffer, _contentType: string): Promise<{ url: string }> => {
        const url = 'https://example.test/given-1';
        published.set(url, bytes.toString('utf8'));
        return { url };
      }
    );
    const uploadsOf = async (table: string) =>
      (
        await sqlExecutor.execute<{ upload_url: string }>(
          `SELECT upload_url FROM ${table} WHERE token_id = :card`,
          { card: CARD }
        )
      ).map((r) => r.upload_url);

    // After the switch: the identity list, with its identity column.
    await seed();
    await updateSubscriptions({ uploader: { uploadFile: given } });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(given).toHaveBeenCalledTimes(1);
    expect(given.mock.calls[0][1]).toBe('text/csv');
    expect(String(given.mock.calls[0][0])).toContain('identity');
    expect(await uploadsOf(SUBSCRIPTIONS_ID_NFTS_FINAL_UPLOAD_TABLE)).toEqual([
      'https://example.test/given-1'
    ]);
    expect(await uploadsOf(SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE)).toEqual([
      'https://example.test/given-1'
    ]);
  });

  it('in shadow, publishes the legacy list through the uploader it is given in place of Arweave', async () => {
    const given = jest.fn(async (_bytes: Buffer, _contentType: string) => ({
      url: 'https://example.test/given'
    }));
    await seedLegacy();
    await cutAndLoad(false);
    process.env[SHADOW_ENV] = 'true';
    subscriptionsIdentitySwitch.invalidate();
    try {
      await updateSubscriptions({ uploader: { uploadFile: given } });
      expect(uploadFile).not.toHaveBeenCalled();
      expect(given).toHaveBeenCalledTimes(1);
      expect(given.mock.calls[0][1]).toBe('text/csv');
      expect(String(given.mock.calls[0][0])).not.toContain('identity');
      const [upload] = await sqlExecutor.execute<{ upload_url: string }>(
        `SELECT upload_url FROM ${SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE} WHERE token_id = :card`,
        { card: CARD }
      );
      expect(upload.upload_url).toBe('https://example.test/given');
    } finally {
      delete process.env[SHADOW_ENV];
    }
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
      // A list alone doesn't back the switch: the mint's phases and
      // redemptions must have been compared too.
      expect((await shadowReportsMatch(CARD)).problems).toEqual([
        `no phase comparison for card ${CARD}`,
        `no redemption comparison for card ${CARD}`,
        `0 signed records matched since card ${CARD}'s first list; the switch needs 3`
      ]);
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

    const alert = jest.spyOn(Logger.prototype, 'errorWithCode');
    await updateSubscriptions();
    // A known structural difference: no alert.
    expect(
      alert.mock.calls.filter(
        (call) => call[0] === 'SUBSCRIPTIONS_TRUTH_COMPARISON_DIFF'
      )
    ).toHaveLength(0);
    alert.mockRestore();

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

    // The mint: P1's airdrop, charged on both sides. P1's balance is its
    // two legacy keys' together, so its redemption comparison raises no
    // alert either.
    const [p1Row] = await sqlExecutor.execute<{ airdrop_address: string }>(
      `SELECT airdrop_address FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} WHERE identity_key = :p1`,
      { p1: P1 }
    );
    await execute(
      `INSERT INTO ${TRANSACTIONS_TABLE}
        (created_at, transaction, block, transaction_date, from_address, to_address,
         contract, token_id, token_count, value, primary_proceeds, royalties,
         gas_gwei, gas_price, gas_price_gwei, gas)
        VALUES (NOW(), '0xmerged', 50, '2026-11-26 15:00:00', :null, :to, :c, :card,
         1, 0, 0, 0, 0, 0, 0, 0)`,
      {
        null: NULL_ADDRESS,
        to: p1Row.airdrop_address,
        c: MEMES_CONTRACT,
        card: CARD
      }
    );
    await redeemSubscriptions();
    const mintAlert = jest.spyOn(Logger.prototype, 'errorWithCode');
    await runIdentityRedemptionWriters();
    expect(
      mintAlert.mock.calls.filter(
        (call) => call[0] === 'SUBSCRIPTIONS_TRUTH_COMPARISON_DIFF'
      )
    ).toHaveLength(0);
    mintAlert.mockRestore();
    const [redemptions] = await sqlExecutor.execute<{ report: string }>(
      `SELECT report FROM ${SUBSCRIPTIONS_ID_REPORTS_TABLE} WHERE kind = 'REDEMPTIONS'`
    );
    expect(String(redemptions.report)).toContain('compared as the sum');
  });

  it('alerts when the identity list drops someone the legacy list has', async () => {
    await seedLegacy();
    await cutAndLoad(true);
    // LONE's choice is lost on the identity side only.
    await execute(
      `DELETE FROM ${SUBSCRIPTIONS_ID_NFTS_TABLE} WHERE identity_key = :lone`,
      { lone: LONE }
    );
    const alert = jest.spyOn(Logger.prototype, 'errorWithCode');
    await updateSubscriptions();
    expect(
      alert.mock.calls.filter(
        (call) => call[0] === 'SUBSCRIPTIONS_TRUTH_COMPARISON_DIFF'
      )
    ).toHaveLength(1);
    alert.mockRestore();
    const [report] = await sqlExecutor.execute<{ report: string }>(
      `SELECT report FROM ${SUBSCRIPTIONS_ID_REPORTS_TABLE} WHERE kind = 'LIST'`
    );
    const parsed = JSON.parse(String(report.report)) as {
      diffs: { key: string; identity: string | null }[];
      unexplained: number;
    };
    expect(parsed.unexplained).toBe(1);
    expect(parsed.diffs).toEqual([
      expect.objectContaining({ key: LONE, identity: null })
    ]);
  });

  it('rebuilds lost identity tables from the opening and the journal alone, giving the same API answers', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    // After the switch: a top-up, a daily build, a phase pull and an
    // airdrop charged.
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa5', 30, '2026-11-26 13:00:00', :lone, 0.05)`,
      { lone: LONE }
    );
    await runIdentityTopUpWriters();
    await updateSubscriptions();
    await getPublicSubscriptions(MEMES_CONTRACT, CARD);
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
    const tablesBefore = await identityTablesHash({});
    const ethereum = await ethereumAsRecorded();

    // Lose every identity table and the MySQL sources the live writers read
    // (top-ups, transactions, the legacy loop's block), then rebuild.
    await loseIdentityTables();
    for (const table of [
      SUBSCRIPTIONS_TOP_UP_TABLE,
      TRANSACTIONS_TABLE,
      TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE
    ]) {
      await execute(`DELETE FROM ${table}`);
    }
    const result = await rebuildIdentityTables({
      source: journalSource,
      fetch: fetchPublished,
      goLive: true,
      lostDatabase: true,
      ethereum
    });
    expect(result).toEqual(
      expect.objectContaining({ checkpoints: 1, switched: true })
    );
    expect(await identityTablesHash({})).toBe(tablesBefore);
    expect(await answers()).toEqual(before);
  });

  it('refuses to go live from a rebuild after a suspend, whose writes the journal lacks', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    await updateSubscriptions();
    const ethereum = await ethereumAsRecorded();
    expect(await suspendIdentityTables()).toBe(true);
    // Suspended, the identity writers stop: a top-up lands in the legacy
    // tables only, with no journal entry.
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa9', 31, '2026-11-26 14:00:00', :lone, 0.05)`,
      { lone: LONE }
    );
    await runIdentityTopUpWriters();
    expect(await subscriptionsIdentitySwitch.writeModeOrFail()).toBe('OFF');
    const tablesBefore = await identityTablesHash({});

    await expect(
      rebuildIdentityTables({
        source: journalSource,
        fetch: fetchPublished,
        goLive: true,
        lostDatabase: true,
        ethereum
      })
    ).rejects.toThrow(
      'A rebuild goes live only over lost identity tables, and their state row is still there'
    );
    // Nothing moved: still suspended, the tables as they were, the write
    // routes open on the legacy path.
    expect(await subscriptionsIdentitySwitch.writeModeOrFail()).toBe('OFF');
    expect(await identityTablesHash({})).toBe(tablesBefore);
    expect(await subscriptionWritePathNow()).toBe('LEGACY');

    // Identity rows left without their state row are not a lost database
    // either.
    await execute(`DELETE FROM ${SUBSCRIPTIONS_ID_STATE_TABLE}`);
    subscriptionsIdentitySwitch.invalidate();
    await expect(
      rebuildIdentityTables({
        source: journalSource,
        fetch: fetchPublished,
        goLive: true,
        lostDatabase: true,
        ethereum
      })
    ).rejects.toThrow('still holds rows');
    // Over lost tables it goes live, as before.
    await loseIdentityTables();
    const result = await rebuildIdentityTables({
      source: journalSource,
      fetch: fetchPublished,
      goLive: true,
      lostDatabase: true,
      ethereum
    });
    expect(result.switched).toBe(true);
  });

  it('rebuilds past a part posted twice with the same contents, and refuses one posted with other contents', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa5', 30, '2026-11-26 13:00:00', :lone, 0.05)`,
      { lone: LONE }
    );
    await runIdentityTopUpWriters();
    await updateSubscriptions();
    const tablesBefore = await identityTablesHash({});
    const ethereum = await ethereumAsRecorded();
    // The top-up's entry posted again, as after a restore from a backup
    // taken before it was posted.
    const [topUp] = await sqlExecutor.execute<{ id: number; entry: string }>(
      `SELECT id, entry FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE}
        WHERE entry LIKE '%"kind":"top-up"%' ORDER BY id LIMIT 1`
    );
    const repost = (entry: string) =>
      execute(
        `INSERT INTO ${SIGNED_RECORD_LOG_ENTRIES_TABLE} (chain, lane, entry, created_at, segment_seq)
          SELECT chain, lane, :entry, created_at, segment_seq
            FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE} WHERE id = :id`,
        { entry, id: topUp.id }
      );
    await repost(topUp.entry);

    await loseIdentityTables();
    const result = await rebuildIdentityTables({
      source: journalSource,
      fetch: fetchPublished,
      ethereum
    });
    expect(result.missing).toBeNull();
    expect(await identityTablesHash({})).toBe(tablesBefore);

    // The same n and part with other contents: a write that reused a
    // posted n. Nothing is loaded.
    const other = JSON.parse(topUp.entry);
    other.body.at_ms += 1;
    await repost(JSON.stringify(other));
    await loseIdentityTables();
    await expect(
      rebuildIdentityTables({
        source: journalSource,
        fetch: fetchPublished,
        ethereum
      })
    ).rejects.toThrow('posted twice with different contents');
    expect(
      await finalIds(SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE, 'identity_key')
    ).toHaveLength(0);
  });

  it('refuses to go live from a rebuild while the legacy tables hold rows, unless told the database is lost', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    await updateSubscriptions();
    const ethereum = await ethereumAsRecorded();
    await loseIdentityTables();
    await expect(
      rebuildIdentityTables({
        source: journalSource,
        fetch: fetchPublished,
        goLive: true,
        ethereum
      })
    ).rejects.toThrow('The legacy subscription tables hold rows');
    expect(
      await finalIds(SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE, 'identity_key')
    ).toHaveLength(0);
    const result = await rebuildIdentityTables({
      source: journalSource,
      fetch: fetchPublished,
      goLive: true,
      lostDatabase: true,
      ethereum
    });
    expect(result.switched).toBe(true);
  });

  it('journals a suspend, and rebuilds the opening suspended where it stopped', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    await updateSubscriptions();
    const ethereum = await ethereumAsRecorded();
    expect(await suspendWithJournal()).toBe(true);
    expect(await subscriptionsIdentitySwitch.writeModeOrFail()).toBe('OFF');
    const bodies = (
      await sqlExecutor.execute<{ entry: string }>(
        `SELECT entry FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE} ORDER BY id`
      )
    ).map((row) => JSON.parse(row.entry).body);
    const suspend = bodies[bodies.length - 1];
    expect(suspend.kind).toBe('suspend');
    const tablesBefore = await identityTablesHash({});
    // Suspended again, nothing more is journaled.
    expect(await suspendWithJournal()).toBe(true);
    const [{ entries }] = await sqlExecutor.execute<{ entries: number }>(
      `SELECT COUNT(*) AS entries FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE}`
    );
    expect(Number(entries)).toBe(bodies.length);

    await loseIdentityTables();
    await expect(
      rebuildIdentityTables({
        source: journalSource,
        fetch: fetchPublished,
        goLive: true,
        lostDatabase: true,
        ethereum
      })
    ).rejects.toThrow('suspended at n=');
    await loseIdentityTables();
    const result = await rebuildIdentityTables({
      source: journalSource,
      fetch: fetchPublished,
      ethereum
    });
    expect(result.suspendedAtN).toBe(suspend.n);
    expect(await identityTablesHash({})).toBe(tablesBefore);
    expect(await subscriptionsIdentitySwitch.writeModeOrFail()).toBe('OFF');
  });

  it('writes no checkpoint, and alerts, when another opening is loaded while the snapshot is hashed', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    const checkpoints = async () =>
      (
        await sqlExecutor.execute<{ entry: string }>(
          `SELECT entry FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE}`
        )
      ).filter((row) => JSON.parse(row.entry).body?.kind === 'checkpoint')
        .length;
    const before = await checkpoints();
    const realExecute = sqlExecutor.execute.bind(sqlExecutor);
    let swapped = false;
    const spy = jest.spyOn(sqlExecutor, 'execute').mockImplementation(((
      sql: string,
      params?: Record<string, unknown>,
      options?: never
    ) => {
      if (
        !swapped &&
        sql.includes('LOCK IN SHARE MODE') &&
        sql.includes(SUBSCRIPTIONS_ID_STATE_TABLE)
      ) {
        swapped = true;
        // A load commits after the hash: the state names another opening.
        return realExecute(
          `UPDATE ${SUBSCRIPTIONS_ID_STATE_TABLE} SET opening_sha256 = :other WHERE id = 'opening'`,
          { other: 'f'.repeat(64) }
        ).then(() => realExecute(sql, params, options));
      }
      return realExecute(sql, params, options);
    }) as never);
    const alert = jest.spyOn(Logger.prototype, 'errorWithCode');
    try {
      await updateSubscriptions();
    } finally {
      spy.mockRestore();
    }
    expect(swapped).toBe(true);
    expect(await checkpoints()).toBe(before);
    expect(alert).toHaveBeenCalledWith(
      'SUBSCRIPTIONS_JOURNAL_CHECKPOINT_FAILED',
      expect.stringContaining(
        'The opening changed while the checkpoint was hashed'
      )
    );
    alert.mockRestore();
  });

  it('refuses to rebuild over identity tables that are the truth, suspending nothing', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    await expect(
      rebuildIdentityTables({ source: journalSource, fetch: fetchPublished })
    ).rejects.toThrow('The identity tables are the truth');
    expect(await subscriptionsIdentitySwitch.writeModeOrFail()).toBe('TRUTH');
  });

  it('rebuilds a top-up with the identity it was credited to, after the wallet leaves', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    // A tops up 0.1 while bound to P1.
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa7', 30, '2026-11-26 13:00:00', :a, 0.1)`,
      { a: A }
    );
    await runIdentityTopUpWriters();
    // Then A leaves P1: it takes nothing with it.
    await execute(
      `UPDATE ${ADDRESS_CONSOLIDATION_KEY} SET consolidation_key = address WHERE address = :a`,
      { a: A }
    );
    await runIdentityTopUpWriters();
    const live = await identityBalances();
    expect(live[P1]).toBeCloseTo(0.6, 10);
    expect(live[A]).toBeUndefined();
    const tablesBefore = await identityTablesHash({});

    await loseIdentityTables();
    await rebuildIdentityTables({
      source: journalSource,
      fetch: fetchPublished
    });
    expect(await identityBalances()).toEqual(live);
    expect(await identityTablesHash({})).toBe(tablesBefore);
  });

  it('rebuilds a build whose list upload failed, and its airdrop, with no gap', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    uploadFile.mockImplementation(async (bytes: Buffer) => {
      if (bytes.toString('utf8').includes('airdrop_address')) {
        throw new Error('arweave unavailable');
      }
      const url = `https://example.test/file-${published.size}`;
      published.set(url, bytes.toString('utf8'));
      return { url };
    });
    await expect(updateSubscriptions()).rejects.toThrow('arweave unavailable');
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
        VALUES (NOW(), 50, 0)`
    );
    await runIdentityRedemptionWriters();
    expect(
      await balance(SUBSCRIPTIONS_ID_BALANCES_TABLE, 'identity_key', LONE)
    ).toBeCloseTo(0.13471, 10);
    const tablesBefore = await identityTablesHash({});

    await loseIdentityTables();
    const result = await rebuildIdentityTables({
      source: journalSource,
      fetch: fetchPublished
    });
    // The run stopped at the upload, before its checkpoint.
    expect(result.checkpoints).toBe(0);
    expect(await identityTablesHash({})).toBe(tablesBefore);
    expect(
      await finalIds(SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE, 'identity_key')
    ).toHaveLength(2);
  });

  it('stops a rebuild at a checkpoint that a write outside the journal changed', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    // A write that bypasses the journal, then a build checkpoints it.
    await execute(
      `UPDATE ${SUBSCRIPTIONS_ID_BALANCES_TABLE} SET balance = balance + 1 WHERE identity_key = :lone`,
      { lone: LONE }
    );
    await updateSubscriptions();
    const ethereum = await ethereumAsRecorded();

    await loseIdentityTables();
    // Going live needs the journal checked against Ethereum.
    await expect(
      rebuildIdentityTables({
        source: journalSource,
        fetch: fetchPublished,
        goLive: true,
        lostDatabase: true
      })
    ).rejects.toThrow('checked against Ethereum');
    await expect(
      rebuildIdentityTables({
        source: journalSource,
        fetch: fetchPublished,
        goLive: true,
        lostDatabase: true,
        ethereum
      })
    ).rejects.toThrow(/differ/);
    // Left suspended and not the truth; the write routes are open again.
    expect(await subscriptionsIdentitySwitch.writeModeOrFail()).toBe('OFF');
    expect(await subscriptionWritePathNow()).toBe('LEGACY');
  });

  it('rebuilds when a phase pull commits while a build is under way', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    // The card's final rows, and the build's checkpoint.
    await updateSubscriptions();
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      const options = { wrappedConnection: connection };
      // The build's first plain read fixes its snapshot.
      await sqlExecutor.execute(
        `SELECT phase FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}
          WHERE contract = :c AND token_id = :card`,
        { c: MEMES_CONTRACT, card: CARD },
        options
      );
      // Meanwhile a phase pull splits the card's rows and commits, journaled.
      await getPublicSubscriptions(MEMES_CONTRACT, CARD);
      // The build journals the card's final rows: the latest committed
      // ones, not its snapshot's. (A build may not journal balances: the
      // verifier refuses that.)
      await journal(
        {
          kind: 'build',
          inputs: { contract: MEMES_CONTRACT, token_id: CARD },
          rows: [
            {
              table: 'final',
              keys: [{ contract: MEMES_CONTRACT, token_id: CARD }]
            }
          ]
        },
        options
      );
    });
    await journalCheckpoint();
    const tablesBefore = await identityTablesHash({});

    await loseIdentityTables();
    const result = await rebuildIdentityTables({
      source: journalSource,
      fetch: fetchPublished
    });
    expect(result).toEqual(
      expect.objectContaining({ checkpoints: 2, missing: null })
    );
    expect(await identityTablesHash({})).toBe(tablesBefore);
  });

  it('stops a rebuild on a journal that breaks the money rules, before loading anything, and alerts', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xab', 32, '2026-11-26 13:00:00', :lone, 0.3)`,
      { lone: LONE }
    );
    expect(await creditIdentityTopUps()).toBe(1);
    const posted = (
      await sqlExecutor.execute<{ entry: string }>(
        `SELECT entry FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE} WHERE chain = 'public' ORDER BY id`
      )
    ).map((row) => JSON.parse(row.entry));
    const n = posted.find((e) => e.body?.kind === 'top-up').body.n;
    await loseIdentityTables();
    /** Rebuilds from the posted journal with its top-up's balance row changed. */
    const rebuildWith = (change: (row: Record<string, unknown>) => void) => {
      const entries = JSON.parse(JSON.stringify(posted));
      const credited = entries
        .find((e: { body?: { kind?: string } }) => e.body?.kind === 'top-up')
        .body.changes.find((c: { table: string }) => c.table === 'balances');
      expect(Number(credited.after.balance)).toBe(0.5);
      change(credited.after);
      return rebuildIdentityTables({
        source: {
          async *walk() {
            for (const entry of entries) {
              yield { entry };
            }
          }
        },
        fetch: fetchPublished
      });
    };
    const alert = jest.spyOn(Logger.prototype, 'errorWithCode');
    try {
      // 0.01 more than the transfer brought.
      await expect(
        rebuildWith((row) => {
          row.balance = 0.51;
        })
      ).rejects.toThrow(
        `n=${n} top-up: the balance of ${LONE} is 0.51 after a top-up of 0.3 to 0.2; expected 0.5`
      );
      expect(alert).toHaveBeenCalledWith(
        'SUBSCRIPTIONS_JOURNAL_VERIFY_FAILED',
        expect.stringContaining('is 0.51 after a top-up of 0.3')
      );
      // The right amount, written to another identity's row under LONE's
      // key: the rebuild would check LONE's row and write the other's.
      const other = `0x${'ee'.padStart(64, '0')}`;
      await expect(
        rebuildWith((row) => {
          row.identity_key = other;
        })
      ).rejects.toThrow(
        `n=${n} top-up: the balances change {"identity_key":"${LONE}"}: its after row is another row`
      );
      // Ethereum could not be read: nothing is loaded either, and it alerts.
      alert.mockClear();
      await expect(
        rebuildIdentityTables({
          source: {
            async *walk() {
              for (const entry of posted) {
                yield { entry };
              }
            }
          },
          fetch: fetchPublished,
          ethereum: {
            topUp: async () => {
              throw new Error('provider unavailable');
            },
            mintedTo: async () => 0
          }
        })
      ).rejects.toThrow('provider unavailable');
      expect(alert).toHaveBeenCalledWith(
        'SUBSCRIPTIONS_JOURNAL_VERIFY_FAILED',
        expect.stringContaining('could not be checked: provider unavailable')
      );
    } finally {
      alert.mockRestore();
    }
    // Nothing was loaded.
    expect(await identityBalances()).toEqual({});
  });

  it('says what is missing when the posted journal ends before live, and stays suspended', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xaa', 31, '2026-11-26 13:00:00', :lone, 0.3)`,
      { lone: LONE }
    );
    await creditIdentityTopUps();
    const rows = await sqlExecutor.execute<{ entry: string }>(
      `SELECT entry FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE} WHERE chain = 'public' ORDER BY id`
    );
    // The last entry was still in the open segment, not yet posted. The
    // counter row survives in the live database.
    for (const table of [
      ...IDENTITY_DATA_TABLES,
      SUBSCRIPTIONS_ID_STATE_TABLE
    ]) {
      await execute(`DELETE FROM ${table}`);
    }
    subscriptionsIdentitySwitch.invalidate();
    const result = await rebuildIdentityTables({
      source: {
        async *walk() {
          for (const row of rows.slice(0, rows.length - 1)) {
            yield { entry: JSON.parse(row.entry) };
          }
        }
      },
      fetch: fetchPublished
    });
    expect(result.missing).toContain("live's counter");
    expect(await subscriptionsIdentitySwitch.writeModeOrFail()).toBe('OFF');
  });

  it('refuses go-live while the journal is not being posted', async () => {
    await seedLegacy();
    closerPosts = false;
    const result = await goLiveForTest();
    expect(result.switched).toBe(false);
    expect(result.steps.join(' ')).toContain('a probe entry was not posted');
  });

  it("proves posting with a probe entry that leaves the open entries when it's posted", async () => {
    await seedLegacy();
    // Nobody posts: the probe waits, then says no.
    expect(await journalPostingProbe({ timeoutMs: 300, pollMs: 50 })).toBe(
      false
    );
    // The closer posts (the entry leaves the open entries) while it waits.
    const posting = journalPostingProbe({ timeoutMs: 5000, pollMs: 50 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await execute(
      `DELETE FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE} WHERE lane = 'subs-shadow'`
    );
    expect(await posting).toBe(true);
  });

  it('charges one airdrop block of 5,000 tokens in one write whose parts all fit', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    const N = 1000;
    const EDITIONS = 5;
    const ids = Array.from({ length: N }, (_, i) => wallet(0x3000 + i));
    for (let i = 0; i < N; i += 250) {
      const chunk = ids.slice(i, i + 250);
      const params = {
        ...Object.fromEntries(chunk.map((w, j) => [`w${j}`, w])),
        c: MEMES_CONTRACT,
        card: CARD
      };
      await execute(
        `INSERT INTO ${SUBSCRIPTIONS_ID_BALANCES_TABLE} (identity_key, balance) VALUES ${chunk.map((_, j) => `(:w${j}, 1)`).join(', ')}`,
        params
      );
      await execute(
        `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE}
          (identity_key, consolidation_key, contract, token_id, subscribed_count,
           airdrop_address, balance, subscribed_at, phase, phase_subscriptions,
           phase_position, redeemed_count)
          VALUES ${chunk
            .map(
              (_, j) =>
                `(:w${j}, :w${j}, :c, :card, ${EDITIONS}, :w${j}, 1, '2026-11-20 00:00:00', 'Phase 1', ${N}, ${i + j}, 0)`
            )
            .join(', ')}`,
        params
      );
      // All in one block: 1,000 airdrops of 5 tokens.
      await execute(
        `INSERT INTO ${TRANSACTIONS_TABLE}
          (created_at, transaction, block, transaction_date, from_address, to_address,
           contract, token_id, token_count, value, primary_proceeds, royalties,
           gas_gwei, gas_price, gas_price_gwei, gas)
          VALUES ${chunk
            .map(
              (_, j) =>
                `(NOW(), :tx${j}, 100, '2026-11-26 15:00:00', :null, :w${j}, :c, :card, ${EDITIONS}, 0, 0, 0, 0, 0, 0, 0)`
            )
            .join(', ')}`,
        {
          ...params,
          null: NULL_ADDRESS,
          ...Object.fromEntries(
            chunk.map((_, j) => [
              `tx${j}`,
              `0x${(0x5000 + i + j).toString(16).padStart(64, '0')}`
            ])
          )
        }
      );
    }
    await execute(
      `INSERT INTO ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE} (created_at, block, timestamp)
        VALUES (NOW(), 100, 0)`
    );
    await runIdentityRedemptionWriters();
    const [charged] = await sqlExecutor.execute<{ n: number }>(
      `SELECT SUM(count) AS n FROM ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}`
    );
    expect(Number(charged.n)).toBe(N * EDITIONS);
    const entries = (
      await sqlExecutor.execute<{ entry: string }>(
        `SELECT entry FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE} ORDER BY id`
      )
    ).map((row) => ({
      bytes: Buffer.byteLength(row.entry),
      entry: JSON.parse(row.entry)
    }));
    expect(Math.max(...entries.map((e) => e.bytes))).toBeLessThanOrEqual(
      JOURNAL_PART_MAX_BYTES
    );
    const redemption = entries
      .map((e) => e.entry.body)
      .filter((body) => body?.kind === 'redemption');
    expect(redemption.length).toBeGreaterThan(1);
    expect(new Set(redemption.map((body) => body.n)).size).toBe(1);
    expect(
      redemption.flatMap((body) => body.inputs.charges as unknown[])
    ).toHaveLength(N * EDITIONS);
  }, 900000);

  it('reports a last write posted only in part as the tail, and stays suspended', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    // A write of several parts (a long list in its inputs, no row changed).
    await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      journal(
        {
          kind: 'phase',
          inputs: {
            contract: MEMES_CONTRACT,
            token_id: CARD,
            phase: 'Phase 1'
          },
          spread: {
            key: 'padding',
            items: Array.from({ length: 4000 }, (_, i) => 'x'.repeat(500) + i)
          }
        },
        { wrappedConnection: connection }
      )
    );
    const rows = await sqlExecutor.execute<{ entry: string }>(
      `SELECT entry FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE} WHERE chain = 'public' ORDER BY id`
    );
    const lastParts = rows
      .map((r) => JSON.parse(r.entry).body)
      .filter((body) => body?.kind === 'phase');
    expect(lastParts[0].parts).toBeGreaterThan(1);
    const [counter] = await sqlExecutor.execute<{ block: number }>(
      `SELECT block FROM ${SUBSCRIPTIONS_ID_CURSORS_TABLE} WHERE id = 'journal'`
    );
    // The segment ended after the write's first part.
    const postedInPart = {
      async *walk() {
        for (const row of rows.slice(0, rows.length - lastParts.length + 1)) {
          yield { entry: JSON.parse(row.entry) };
        }
      }
    };
    const alert = jest.spyOn(Logger.prototype, 'errorWithCode');
    const tailAlerts = () =>
      alert.mock.calls.filter(
        (call) => call[0] === 'SUBSCRIPTIONS_JOURNAL_TAIL_MISSING'
      ).length;
    // With the database lost, the rest of the write is gone: it alerts.
    await loseIdentityTables();
    const result = await rebuildIdentityTables({
      source: postedInPart,
      fetch: fetchPublished
    });
    expect(result.missing).toContain('ends inside write');
    expect(await subscriptionsIdentitySwitch.writeModeOrFail()).toBe('OFF');
    expect(tailAlerts()).toBe(1);
    // With the live database there (its counter), the closer posts the
    // rest: reported, not alerted.
    await loseIdentityTables();
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_ID_CURSORS_TABLE} (id, block, updated_at) VALUES ('journal', :n, 0)`,
      { n: counter.block }
    );
    const again = await rebuildIdentityTables({
      source: postedInPart,
      fetch: fetchPublished
    });
    expect(again.missing).toContain('ends inside write');
    expect(tailAlerts()).toBe(1);
    alert.mockRestore();
  });

  it('alerts on a difference after the switch only when no known cause explains it', async () => {
    const alert = jest.spyOn(Logger.prototype, 'errorWithCode');
    const report = (unexplained: number | undefined) =>
      saveReport({
        kind: 'LIST',
        mode: 'TRUTH',
        contract: MEMES_CONTRACT,
        tokenId: CARD,
        verdict: 'DIFF',
        legacyRows: 1,
        identityRows: 2,
        diffs: [{ key: P1, legacy: null, identity: 'x' }],
        notes: [`second legacy row of one identity, not written: ${A}`],
        unexplained
      });
    await report(0);
    expect(alert).not.toHaveBeenCalled();
    await report(1);
    await report(undefined);
    expect(alert).toHaveBeenCalledTimes(2);
    expect(alert.mock.calls[0][0]).toBe('SUBSCRIPTIONS_TRUTH_COMPARISON_DIFF');
    alert.mockRestore();
  });

  it('keeps every journal entry small for a build and a mint over 900 identities with long histories', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    const N = 900;
    const HISTORY = 25;
    const ids = Array.from({ length: N }, (_, i) => wallet(0x1000 + i));
    for (let i = 0; i < N; i += 300) {
      const chunk = ids.slice(i, i + 300);
      const params = Object.fromEntries(chunk.map((w, j) => [`w${j}`, w]));
      await execute(
        `INSERT INTO ${SUBSCRIPTIONS_ID_BALANCES_TABLE} (identity_key, balance) VALUES ${chunk.map((_, j) => `(:w${j}, 1)`).join(', ')}`,
        params
      );
      await execute(
        `INSERT INTO ${SUBSCRIPTIONS_ID_MODE_TABLE} (identity_key, automatic) VALUES ${chunk.map((_, j) => `(:w${j}, true)`).join(', ')}`,
        params
      );
      // Each has an automatic row for each of the last HISTORY cards.
      await execute(
        `INSERT INTO ${SUBSCRIPTIONS_ID_NFTS_TABLE}
          (identity_key, contract, token_id, subscribed, subscribed_count, automatic_subscription)
          VALUES ${chunk
            .flatMap((_, j) =>
              Array.from(
                { length: HISTORY },
                (__, k) => `(:w${j}, :c, ${1000 + k}, true, 1, true)`
              )
            )
            .join(', ')}`,
        { ...params, c: MEMES_CONTRACT }
      );
    }
    // The seed above is written directly; this test checks entry sizes,
    // not a rebuild.
    await updateSubscriptions();
    const finals = await finalIds(
      SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
      'identity_key'
    );
    expect(finals.length).toBeGreaterThan(N);
    // The mint: one airdrop to each listed wallet, then the redemption runs.
    const airdropTo = await sqlExecutor.execute<{ airdrop_address: string }>(
      `SELECT airdrop_address FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} WHERE token_id = :card`,
      { card: CARD }
    );
    for (let i = 0; i < airdropTo.length; i += 300) {
      const chunk = airdropTo.slice(i, i + 300);
      await execute(
        `INSERT INTO ${TRANSACTIONS_TABLE}
          (created_at, transaction, block, transaction_date, from_address, to_address,
           contract, token_id, token_count, value, primary_proceeds, royalties,
           gas_gwei, gas_price, gas_price_gwei, gas)
          VALUES ${chunk
            .map(
              (_, j) =>
                `(NOW(), :tx${j}, ${100 + Math.floor((i + j) / 50)}, '2026-11-26 15:00:00', :null, :to${j}, :c, :card, 1, 0, 0, 0, 0, 0, 0, 0)`
            )
            .join(', ')}`,
        {
          null: NULL_ADDRESS,
          c: MEMES_CONTRACT,
          card: CARD,
          ...Object.fromEntries(
            chunk.flatMap((row, j) => [
              [`tx${j}`, `0x${(i + j).toString(16).padStart(64, '0')}`],
              [`to${j}`, row.airdrop_address]
            ])
          )
        }
      );
    }
    await execute(
      `INSERT INTO ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE} (created_at, block, timestamp)
        VALUES (NOW(), 200, 0)`
    );
    for (let run = 0; run < 10; run++) {
      await runIdentityRedemptionWriters();
    }
    const [charged] = await sqlExecutor.execute<{ n: number }>(
      `SELECT COUNT(*) AS n FROM ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}`
    );
    expect(Number(charged.n)).toBe(airdropTo.length);
    const [biggest] = await sqlExecutor.execute<{ bytes: number }>(
      `SELECT MAX(OCTET_LENGTH(entry)) AS bytes FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE}`
    );
    expect(Number(biggest.bytes)).toBeLessThanOrEqual(JOURNAL_PART_MAX_BYTES);
  }, 900000);

  it('puts back the signed record heads of the choices it rebuilds', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    const eventId = `0x${'ab'.repeat(32)}`;
    // A choice as the signed write path journals it (here with no row
    // changed): its record's order key is in the entry.
    await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
      journal(
        {
          kind: 'choice',
          inputs: {
            event_id: eventId,
            owner: P1,
            type: 'subs.mode',
            key: '',
            anchor: 900,
            claimed_time: 1795694700007
          }
        },
        { wrappedConnection: connection }
      )
    );
    await loseIdentityTables();
    await execute(`DELETE FROM ${SIGNED_RECORD_HEADS_TABLE}`);
    await rebuildIdentityTables({
      source: journalSource,
      fetch: fetchPublished
    });
    const heads = await sqlExecutor.execute<{
      owner: string;
      family: string;
      rtype: string;
      rkey: string;
      anchor: number;
      claimed_time: number;
      event_id: string;
    }>(
      `SELECT owner, family, rtype, rkey, anchor, claimed_time, event_id FROM ${SIGNED_RECORD_HEADS_TABLE}`
    );
    expect(
      heads.map((h) => [
        h.owner,
        h.family,
        h.rtype,
        h.rkey,
        Number(h.anchor),
        Number(h.claimed_time),
        h.event_id
      ])
    ).toEqual([[P1, 'ps', 'subs.mode', '', 900, 1795694700007, eventId]]);
  });

  it("refuses a money write that breaks the journal's rules, and alerts", async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    const alert = jest.spyOn(Logger.prototype, 'errorWithCode');
    await expect(
      sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
        const options = { wrappedConnection: connection };
        const before = await journalBefore(
          {
            rows: [
              { table: 'balances', keys: [{ identity_key: LONE }] },
              { table: 'top_up', keys: [{ hash: '0xbad' }] }
            ]
          },
          options
        );
        // A top-up of 0.1 that credits 1.
        await sqlExecutor.execute(
          `UPDATE ${SUBSCRIPTIONS_ID_BALANCES_TABLE} SET balance = balance + 1 WHERE identity_key = :lone`,
          { lone: LONE },
          options
        );
        await sqlExecutor.execute(
          `INSERT INTO ${SUBSCRIPTIONS_ID_TOP_UP_TABLE}
            (hash, block, transaction_date, from_wallet, amount, identity_key)
            VALUES ('0xbad', 31, '2026-11-26 13:00:00', :lone, 0.1, :lone)`,
          { lone: LONE },
          options
        );
        await journal(
          {
            kind: 'top-up',
            inputs: {
              hash: '0xbad',
              block: 31,
              transaction_date: '2026-11-26 13:00:00',
              from_wallet: LONE,
              amount: 0.1,
              identity_key: LONE
            },
            before
          },
          options
        );
      })
    ).rejects.toThrow("breaks the journal's money rules");
    expect(alert).toHaveBeenCalledWith(
      'SUBSCRIPTIONS_JOURNAL_VERIFY_FAILED',
      expect.stringContaining('top-up')
    );
    alert.mockRestore();
    // Nothing of it was made.
    expect(
      await balance(SUBSCRIPTIONS_ID_BALANCES_TABLE, 'identity_key', LONE)
    ).toBeCloseTo(0.2, 10);
  });

  it("refuses every write while live's journal counter is behind the posted journal, until a new opening", async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa5', 30, '2026-11-26 13:00:00', :lone, 0.05)`,
      { lone: LONE }
    );
    await runIdentityTopUpWriters();
    // A restore from an older backup: live's counter is back before the
    // last posted write.
    await execute(
      `UPDATE ${SUBSCRIPTIONS_ID_CURSORS_TABLE} SET block = block - 1 WHERE id = 'journal'`
    );
    const alert = jest.spyOn(Logger.prototype, 'errorWithCode');
    setJournalSource(() => journalSource);
    try {
      expect(
        await verifyPostedJournal({
          ethereum: await ethereumAsRecorded(),
          fetch: fetchPublished
        })
      ).toBe('behind');
    } finally {
      setJournalSource(null);
    }
    expect(alert).toHaveBeenCalledWith(
      'SUBSCRIPTIONS_JOURNAL_BEHIND',
      expect.stringContaining('Suspend, then go-live')
    );

    // Every write refuses and changes nothing.
    const balancesBefore = await identityBalances();
    const tablesBefore = await identityTablesHash({});
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa6', 31, '2026-11-26 14:00:00', :lone, 0.05)`,
      { lone: LONE }
    );
    await expect(runIdentityTopUpWriters()).rejects.toThrow(
      'behind the posted journal'
    );
    expect(await identityBalances()).toEqual(balancesBefore);
    expect(await identityTablesHash({})).toBe(tablesBefore);
    alert.mockRestore();

    // The runbook: suspend, then go-live loads a new opening, and the
    // writers go on.
    expect(await suspendIdentityTables()).toBe(true);
    expect((await goLiveForTest()).switched).toBe(true);
    await runIdentityTopUpWriters();
    const [marker] = await sqlExecutor.execute(
      `SELECT id FROM ${SUBSCRIPTIONS_ID_CURSORS_TABLE} WHERE id = 'journal-behind'`
    );
    expect(marker).toBeUndefined();
  });

  it('checks the posted journal daily once a records-wave source is bound', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa5', 30, '2026-11-26 13:00:00', :lone, 0.05)`,
      { lone: LONE }
    );
    await runIdentityTopUpWriters();
    expect(await verifyPostedJournal()).toBe('not-bound');
    setJournalSource(() => journalSource);
    try {
      expect(
        await verifyPostedJournal({
          ethereum: await ethereumAsRecorded(),
          fetch: fetchPublished
        })
      ).toBe('passed');
    } finally {
      setJournalSource(null);
    }
  });

  it('rebuilds and verifies a mint of 3,500 tokens in one block, charged in one write of many parts', async () => {
    await seedLegacy();
    const N = 3500;
    const ids = Array.from({ length: N }, (_, i) => wallet(0x8000 + i));
    // In the legacy tables before the cut, so the opening holds them.
    for (let i = 0; i < N; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const params = {
        ...Object.fromEntries(chunk.map((w, j) => [`w${j}`, w])),
        c: MEMES_CONTRACT,
        card: CARD
      };
      await execute(
        `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance) VALUES ${chunk.map((_, j) => `(:w${j}, 1)`).join(', ')}`,
        params
      );
      await execute(
        `INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE}
          (consolidation_key, contract, token_id, subscribed, subscribed_count, automatic_subscription)
          VALUES ${chunk.map((_, j) => `(:w${j}, :c, :card, true, 1, false)`).join(', ')}`,
        params
      );
    }
    expect((await goLiveForTest()).switched).toBe(true);
    await updateSubscriptions();
    const listed = await sqlExecutor.execute<{ airdrop_address: string }>(
      `SELECT airdrop_address FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} WHERE token_id = :card`,
      { card: CARD }
    );
    expect(listed.length).toBeGreaterThanOrEqual(N);
    for (let i = 0; i < listed.length; i += 500) {
      const chunk = listed.slice(i, i + 500);
      await execute(
        `INSERT INTO ${TRANSACTIONS_TABLE}
          (created_at, transaction, block, transaction_date, from_address, to_address,
           contract, token_id, token_count, value, primary_proceeds, royalties,
           gas_gwei, gas_price, gas_price_gwei, gas)
          VALUES ${chunk
            .map(
              (_, j) =>
                `(NOW(), :tx${j}, 100, '2026-11-26 15:00:00', :null, :to${j}, :c, :card, 1, 0, 0, 0, 0, 0, 0, 0)`
            )
            .join(', ')}`,
        {
          null: NULL_ADDRESS,
          c: MEMES_CONTRACT,
          card: CARD,
          ...Object.fromEntries(
            chunk.flatMap((row, j) => [
              [
                `tx${j}`,
                `0x${(0x9000 + i + j).toString(16).padStart(64, '0')}`
              ],
              [`to${j}`, row.airdrop_address]
            ])
          )
        }
      );
    }
    await execute(
      `INSERT INTO ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE} (created_at, block, timestamp)
        VALUES (NOW(), 100, 0)`
    );
    await runIdentityRedemptionWriters();
    const parts = (
      await sqlExecutor.execute<{ entry: string }>(
        `SELECT entry FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE} ORDER BY id`
      )
    )
      .map((row) => JSON.parse(row.entry).body)
      .filter((body) => body?.kind === 'redemption');
    expect(parts.length).toBeGreaterThan(1);
    expect(
      parts.flatMap((body) => body.inputs.charges as unknown[])
    ).toHaveLength(listed.length);
    const ethereum = await ethereumAsRecorded();
    const tablesBefore = await identityTablesHash({});

    await loseIdentityTables();
    const result = await rebuildIdentityTables({
      source: journalSource,
      fetch: fetchPublished,
      ethereum
    });
    expect(result.missing).toBeNull();
    expect(await identityTablesHash({})).toBe(tablesBefore);
  }, 900000);

  describe('the go-live gate and the signed records compared in shadow', () => {
    const MINTED = 579;
    /** A shadow report of the minted card; a refused record carries its cause. */
    const report = (kind: string, verdict: string, cause?: string) =>
      execute(
        `INSERT INTO ${SUBSCRIPTIONS_ID_REPORTS_TABLE} (kind, mode, token_id, verdict, report, created_at)
          VALUES (:kind, 'SHADOW', :card, :verdict, :report, 0)`,
        {
          kind,
          card: MINTED,
          verdict,
          report: JSON.stringify({
            notes: cause ? [`subs.card e-${cause}`, cause] : []
          })
        }
      );
    /** The minted card's list, phase and redemption comparisons match. */
    const mintMatches = async () => {
      for (const kind of ['LIST', 'PHASE', 'REDEMPTIONS']) {
        await report(kind, 'MATCH');
      }
    };
    const records = async (verdict: string, count: number, cause?: string) => {
      for (let i = 0; i < count; i++) {
        await report('RECORD', verdict, cause);
      }
    };

    it('refuses the switch with fewer signed records matched than the setting asks', async () => {
      await mintMatches();
      await records('MATCH', 2);
      expect((await shadowReportsMatch(MINTED)).problems).toEqual([
        `2 signed records matched since card ${MINTED}'s first list; the switch needs 3`
      ]);
      await records('MATCH', 1);
      expect(await shadowReportsMatch(MINTED)).toEqual(
        expect.objectContaining({ ok: true, problems: [] })
      );
      // The setting moves the bar.
      process.env[GO_LIVE_MIN_SIGNED_MATCHES_ENV] = '5';
      try {
        expect((await shadowReportsMatch(MINTED)).problems).toEqual([
          `3 signed records matched since card ${MINTED}'s first list; the switch needs 5`
        ]);
      } finally {
        delete process.env[GO_LIVE_MIN_SIGNED_MATCHES_ENV];
      }
    });

    it('refuses the switch while refused records reach the set share, and lists them by reason', async () => {
      await mintMatches();
      await records('MATCH', 8);
      await records('REFUSED', 1, 'invalid-record:not-bound');
      await records('REFUSED', 1, 'refused:STALE_SIGNED_RECORD');
      const gate = await shadowReportsMatch(MINTED);
      expect(gate.problems).toEqual([
        '2 of 10 signed records were refused (20%); the switch needs under 20%'
      ]);
      expect(gate.checked).toEqual(
        expect.arrayContaining([
          `signed records since card ${MINTED}'s first list: 10 compared, 8 matched, 2 refused`,
          'signed records refused: 1 invalid-record:not-bound',
          'signed records refused: 1 refused:STALE_SIGNED_RECORD'
        ])
      );
      // The setting moves the share.
      process.env[GO_LIVE_MAX_REFUSED_PERCENT_ENV] = '25';
      try {
        expect((await shadowReportsMatch(MINTED)).ok).toBe(true);
      } finally {
        delete process.env[GO_LIVE_MAX_REFUSED_PERCENT_ENV];
      }
    });

    it("passes one person's bad header among many matches", async () => {
      await mintMatches();
      await records('MATCH', 9);
      await records('REFUSED', 1, 'invalid-record:sig');
      const gate = await shadowReportsMatch(MINTED);
      expect(gate).toEqual(expect.objectContaining({ ok: true, problems: [] }));
      expect(gate.checked).toContain(
        'signed records refused: 1 invalid-record:sig'
      );
    });

    it('prints the signed record counts in go-live, refuses on them, and switches when differences are accepted', async () => {
      await seedLegacy();
      await mintMatches();
      await records('MATCH', 1);
      await records('REFUSED', 2, 'invalid-record:not-bound');
      const run = (acceptReportDiffs: boolean) =>
        goLive({
          signedWritesLive: true,
          acceptReportDiffs,
          mintedCard: MINTED,
          postingProbe
        });
      const refused = await run(false);
      expect(refused.switched).toBe(false);
      expect(refused.steps).toEqual(
        expect.arrayContaining([
          `checked signed records since card ${MINTED}'s first list: 3 compared, 1 matched, 2 refused`,
          'checked signed records refused: 2 invalid-record:not-bound',
          `problem: 1 signed records matched since card ${MINTED}'s first list; the switch needs 3`,
          'problem: 2 of 3 signed records were refused (67%); the switch needs under 20%',
          'refused: the shadow comparisons do not match'
        ])
      );
      expect(await subscriptionWritePathNow()).toBe('LEGACY');
      expect((await run(true)).switched).toBe(true);
    });
  });

  it('stops a rebuild at a write missing from the journal, though no later write or checkpoint touches its rows', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    // Two top-ups after the switch, to two identities.
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa5', 30, '2026-11-26 13:00:00', :lone, 0.05),
          ('0xa6', 31, '2026-11-26 13:05:00', :a, 0.1)`,
      { lone: LONE, a: A }
    );
    expect(await creditIdentityTopUps()).toBe(2);
    const rows = await sqlExecutor.execute<{ entry: string }>(
      `SELECT entry FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE} WHERE chain = 'public' ORDER BY id`
    );
    const bodies = rows.map((row) => journalBodyOf(JSON.parse(row.entry)));
    const topUps = bodies.filter((body) => body?.kind === 'top-up');
    expect(topUps).toHaveLength(2);
    // The first top-up was never posted; nothing after it touches its rows.
    const lost = topUps[0]!.n;
    expect(lost).toBeLessThan(topUps[1]!.n);
    const gapped: JournalSource = {
      async *walk() {
        for (const row of rows) {
          const entry = JSON.parse(row.entry);
          if (journalBodyOf(entry)?.n !== lost) {
            yield { entry };
          }
        }
      }
    };
    // The daily check of the posted journal finds the gap, and alerts.
    const alert = jest.spyOn(Logger.prototype, 'errorWithCode');
    setJournalSource(() => gapped);
    try {
      expect(
        await verifyPostedJournal({
          ethereum: await ethereumAsRecorded(),
          fetch: fetchPublished
        })
      ).toBe('failed');
      expect(alert).toHaveBeenCalledWith(
        'SUBSCRIPTIONS_JOURNAL_VERIFY_FAILED',
        expect.stringContaining(
          `n=${lost} is missing between n=${lost - 1} and n=${lost + 1}: a write was never posted`
        )
      );
    } finally {
      setJournalSource(null);
      alert.mockRestore();
    }
    // A rebuild from it stops before loading anything.
    const tablesBefore = await identityTablesHash({});
    await loseIdentityTables();
    await expect(
      rebuildIdentityTables({ source: gapped, fetch: fetchPublished })
    ).rejects.toThrow(
      `n=${lost} is missing between n=${lost - 1} and n=${lost + 1}, a write that was never posted`
    );
    // With the write, the same rebuild holds.
    const result = await rebuildIdentityTables({
      source: journalSource,
      fetch: fetchPublished
    });
    expect(result.missing).toBeNull();
    expect(await identityTablesHash({})).toBe(tablesBefore);
  });

  it('alerts when journal entries wait in sealed segments whose heads fail to post', async () => {
    await seedLegacy();
    expect((await goLiveForTest()).switched).toBe(true);
    const closer = (post: RecordsWavePoster['post']) =>
      new RecordLogSegmenter({
        store: recordLogDb,
        pinner: {
          pin: async () => 'bafy-test',
          fetch: async () => Buffer.alloc(0)
        },
        archiver: { upload: async () => 'arweave-test' },
        poster: { post },
        wave: { drops: async function* () {} },
        serviceWallets: [],
        providers: []
      });
    // The closer seals every open entry; posting the head fails.
    await closer(async () => {
      throw new Error('the records wave did not answer');
    }).closeSegments({});
    const [queue] = await sqlExecutor.execute<{
      sealed: number | string;
      open: number | string;
    }>(
      `SELECT SUM(segment_seq IS NOT NULL) AS sealed, SUM(segment_seq IS NULL) AS open
        FROM ${SIGNED_RECORD_LOG_ENTRIES_TABLE} WHERE chain = 'public'`
    );
    expect(Number(queue.sealed)).toBeGreaterThan(0);
    expect(Number(queue.open)).toBe(0);
    // Within the limit nothing is wrong yet; past it the loop alerts.
    expect(await journalPosting()).toEqual({ ok: true, reason: null });
    await execute(
      `UPDATE ${SIGNED_RECORD_LOG_ENTRIES_TABLE} SET created_at = created_at - :age`,
      { age: JOURNAL_POSTING_MAX_AGE_MS + 60_000 }
    );
    const alert = jest.spyOn(Logger.prototype, 'errorWithCode');
    try {
      await runIdentityTopUpWriters();
      expect(alert).toHaveBeenCalledWith(
        'SUBSCRIPTIONS_JOURNAL_STALE',
        expect.stringContaining('unposted')
      );
    } finally {
      alert.mockRestore();
    }
    // Once the head posts, its entries leave the table and all is well.
    expect(await closer(async () => 'head-drop-1').postHeads({})).toBe(1);
    expect(await journalPosting()).toEqual({ ok: true, reason: null });
  });

  it('backs the switch only with matching list, phase and redemption comparisons of the minted card', async () => {
    const report = (kind: string, token: number | null, verdict: string) =>
      execute(
        `INSERT INTO ${SUBSCRIPTIONS_ID_REPORTS_TABLE} (kind, mode, token_id, verdict, report, created_at)
          VALUES (:kind, 'SHADOW', :token, :verdict, '{}', 0)`,
        { kind, token, verdict }
      );
    // Wednesday's mint differs, Thursday's list matches.
    await report('LIST', 579, 'MATCH');
    await report('PHASE', 579, 'DIFF');
    await report('REDEMPTIONS', 579, 'DIFF');
    await report('LIST', 580, 'MATCH');
    const verdict = await shadowReportsMatch(579);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining('PHASE comparison'),
        expect.stringContaining('REDEMPTIONS comparison')
      ])
    );
    await execute(`DELETE FROM ${SUBSCRIPTIONS_ID_REPORTS_TABLE}`);
    await report('LIST', 579, 'MATCH');
    await report('PHASE', 579, 'MATCH');
    await report('REDEMPTIONS', 579, 'MATCH');
    // Signed changes work: three matched.
    for (let i = 0; i < 3; i++) {
      await report('RECORD', null, 'MATCH');
    }
    await report('LIST', 580, 'MATCH');
    expect(await shadowReportsMatch(579)).toEqual(
      expect.objectContaining({ ok: true, problems: [] })
    );
  });

  it('in shadow, gives identity-only rows ids the legacy table never hands out', async () => {
    await seedLegacy();
    await cutAndLoad(false);
    // X subscribes on the identity side only (as a wide identity would).
    const X = wallet(0x99);
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_ID_BALANCES_TABLE} (identity_key, balance) VALUES (:x, 1)`,
      { x: X }
    );
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_ID_MODE_TABLE} (identity_key, automatic) VALUES (:x, true)`,
      { x: X }
    );
    const first = await buildIdentityList({
      tokenId: CARD,
      buildAtMs: Date.parse('2026-11-25T00:01:00Z'),
      idOf: (identity) =>
        identity === P1 ? 1 : identity === LONE ? 2 : undefined
    });
    // The legacy table hands the next card ids 3 and 4.
    const second = await buildIdentityList({
      tokenId: CARD + 1,
      buildAtMs: Date.parse('2026-11-27T00:01:00Z'),
      idOf: (identity) => (identity === P1 ? 3 : undefined)
    });
    const idOf = (rows: { identityKey: string; id: number }[], key: string) =>
      rows.find((r) => r.identityKey === key)?.id;
    expect(idOf(first.rows, P1)).toBe(1);
    expect(idOf(first.rows, X)).toBe(SHADOW_ONLY_ID_FROM);
    expect(idOf(second.rows, P1)).toBe(3);
    expect(idOf(second.rows, X)).toBe(SHADOW_ONLY_ID_FROM + 1);
  });

  it('pauses unsigned writes during go-live and refuses them right after the switch, whatever a cache says', async () => {
    await seedLegacy();
    // Another container warmed its cache before go-live.
    const otherContainer = new SubscriptionsIdentitySwitch();
    expect(await otherContainer.writeMode()).toBe('OFF');
    await closeSubscriptionWrites();
    await expect(unsignedUnsubscribe(LONE)).rejects.toThrow('paused');
    await openSubscriptionWrites();
    const result = await goLive({
      signedWritesLive: true,
      acceptReportDiffs: true,
      mintedCard: 0,
      postingProbe,
      settleMs: 0
    });
    expect(result.switched).toBe(true);
    expect(result.steps).toContain('unsigned writes paused');
    // Its cache still says OFF; the write route reads the row now.
    expect(await otherContainer.writeMode()).toBe('OFF');
    await expect(unsignedUnsubscribe(LONE)).rejects.toThrow('signed now');
  });

  it('keeps unsigned writes paused through the load and the publish, until the switch', async () => {
    await seedLegacy();
    // LONE unsubscribes from the open card while go-live uploads the files,
    // after the load has run.
    let during = 'not tried';
    uploadFile.mockImplementation(async (bytes: Buffer) => {
      if (during === 'not tried') {
        try {
          await unsignedUnsubscribe(LONE);
          during = 'accepted';
        } catch (error) {
          during = (error as Error).message;
        }
      }
      const url = `https://example.test/file-${published.size}`;
      published.set(url, bytes.toString('utf8'));
      return { url };
    });
    const result = await goLive({
      signedWritesLive: true,
      acceptReportDiffs: true,
      mintedCard: 0,
      postingProbe,
      settleMs: 0
    });
    expect(result.switched).toBe(true);
    expect(during).toContain('paused');
    // Refused, so both sides still have LONE subscribed.
    const subscribed = async (table: string, keyColumn: string) =>
      (
        await sqlExecutor.execute<{ subscribed: number }>(
          `SELECT subscribed FROM ${table} WHERE ${keyColumn} = :k AND token_id = :card`,
          { k: LONE, card: CARD }
        )
      ).map((row) => Number(row.subscribed));
    expect(
      await subscribed(SUBSCRIPTIONS_NFTS_TABLE, 'consolidation_key')
    ).toEqual([1]);
    expect(
      await subscribed(SUBSCRIPTIONS_ID_NFTS_TABLE, 'identity_key')
    ).toEqual([1]);
  });

  it('lets one go-live, load or rebuild hold the write pause at a time', async () => {
    await seedLegacy();
    const now = Date.now();
    expect(await claimSubscriptionWrites(now)).toBe(true);
    expect(await claimSubscriptionWrites(now + 1000)).toBe(false);
    // A second go-live, or a rebuild, refuses while the first holds it.
    const refused = await goLiveForTest();
    expect(refused.switched).toBe(false);
    expect(refused.steps.join('\n')).toContain('holds the write pause');
    await expect(
      rebuildIdentityTables({ source: journalSource, fetch: fetchPublished })
    ).rejects.toThrow('holds the write pause');
    // A pause older than the switch window was left by a run that died.
    expect(await claimSubscriptionWrites(now + SWITCH_CUT_WINDOW_MS + 1)).toBe(
      true
    );
    await openSubscriptionWrites();
    expect((await goLiveForTest()).switched).toBe(true);
  });

  it("lifts only its own write pause: a run that outlived the window can't lift the next run's", async () => {
    await seedLegacy();
    const first = Date.now();
    expect(await claimSubscriptionWrites(first)).toBe(true);
    // The first run outlives the switch window; a second one takes over.
    const second = first + SWITCH_CUT_WINDOW_MS + 1;
    expect(await claimSubscriptionWrites(second)).toBe(true);
    // The first run can neither renew the pause nor lift it.
    expect(await renewSubscriptionWrites(first, second + 1)).toBe(false);
    await releaseSubscriptionWrites(first);
    expect(await subscriptionWritePathNow(second + 2)).toBe('PAUSED');
    // The second renews and lifts its own.
    expect(await renewSubscriptionWrites(second, second + 3)).toBe(true);
    await releaseSubscriptionWrites(second + 3);
    expect(await subscriptionWritePathNow(second + 4)).toBe('LEGACY');
  });

  it('ignores a writes-closed marker older than the switch window, and open-writes deletes it', async () => {
    await seedLegacy();
    const now = Date.now();
    await closeSubscriptionWrites(now - SWITCH_CUT_WINDOW_MS - 1000);
    expect(await subscriptionWritePathNow(now)).toBe('LEGACY');
    await closeSubscriptionWrites(now);
    expect(await subscriptionWritePathNow(now)).toBe('PAUSED');
    await openSubscriptionWrites();
    expect(await subscriptionWritePathNow(now)).toBe('LEGACY');
  });

  it('after the switch, posts redemption warnings from the identity side only', async () => {
    await seed();
    noSubscriptionWarning.mockReset();
    // An airdrop to an address on no list, identity or legacy.
    const STRANGER = wallet(0x77);
    await execute(
      `INSERT INTO ${TRANSACTIONS_TABLE}
        (created_at, transaction, block, transaction_date, from_address, to_address,
         contract, token_id, token_count, value, primary_proceeds, royalties,
         gas_gwei, gas_price, gas_price_gwei, gas)
        VALUES (NOW(), '0xstray', 50, '2026-11-26 15:00:00', :null, :to, :c, :card,
         1, 0, 0, 0, 0, 0, 0, 0)`,
      { null: NULL_ADDRESS, to: STRANGER, c: MEMES_CONTRACT, card: CARD }
    );
    await execute(
      `INSERT INTO ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE} (created_at, block, timestamp)
        VALUES (NOW(), 49, 0)`
    );
    await redeemSubscriptions();
    expect(noSubscriptionWarning).not.toHaveBeenCalled();
    await runIdentityRedemptionWriters();
    expect(noSubscriptionWarning).toHaveBeenCalledTimes(1);
    expect(noSubscriptionWarning.mock.calls[0][0]).toEqual(
      expect.objectContaining({ airdropAddress: STRANGER })
    );
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

  it("copies the rollback copy's final rows, list upload and redemptions back from the identity tables exactly", async () => {
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
    // Every column but the rows' own write times on each side (created_at,
    // and updated_at on final rows), which the manifest marks volatile.
    const finalsOf = () =>
      sqlExecutor.execute(
        `SELECT id, consolidation_key, contract, token_id, subscribed_count,
                airdrop_address, balance, subscribed_at, phase,
                phase_subscriptions, phase_position, redeemed_count
           FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE} ORDER BY id`
      );
    const redeemedOf = () =>
      sqlExecutor.execute(
        `SELECT contract, token_id, address, \`transaction\`, transaction_date,
                consolidation_key, value, balance_after, count
           FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}
          ORDER BY \`transaction\`, consolidation_key`
      );
    const uploadsOf = () =>
      sqlExecutor.execute(
        `SELECT contract, token_id, date, upload_url
           FROM ${SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE} ORDER BY token_id`
      );
    const finals = await finalsOf();
    const uploads = await uploadsOf();
    const redeemed = await redeemedOf();
    expect(finals.length).toBeGreaterThan(0);
    expect(uploads).toHaveLength(1);
    expect(redeemed).toHaveLength(1);

    await execute(`DELETE FROM ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}`);
    await execute(`DELETE FROM ${SUBSCRIPTIONS_NFTS_FINAL_UPLOAD_TABLE}`);
    await execute(`DELETE FROM ${SUBSCRIPTIONS_REDEEMED_TABLE}`);
    expect(await copyLegacyHistory()).toEqual({
      finals: finals.length,
      uploads: 1,
      redemptions: 1,
      leftOut: 0
    });
    expect(await finalsOf()).toEqual(finals);
    expect(await uploadsOf()).toEqual(uploads);
    expect(await redeemedOf()).toEqual(redeemed);
  });

  it('charges an airdrop once when a load commits after the run read its cursor', async () => {
    await seedLegacy();
    await cutAndLoad(false);
    process.env[SHADOW_ENV] = 'true';
    subscriptionsIdentitySwitch.invalidate();
    await updateSubscriptions();
    // Two editions on both lists, so a second charge would find one left.
    for (const table of [
      SUBSCRIPTIONS_NFTS_FINAL_TABLE,
      SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE
    ]) {
      await execute(
        `UPDATE ${table} SET subscribed_count = 2 WHERE consolidation_key = :lone`,
        { lone: LONE }
      );
    }
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
    // The legacy loop charges the airdrop.
    await redeemSubscriptions();

    // The identity run reads its cursor and the airdrop. Before its
    // transaction starts, a load commits: cut from the legacy tables, which
    // already hold the charge, with the cursor at the airdrop's block.
    const runTransaction =
      sqlExecutor.executeNativeQueriesInTransaction.bind(sqlExecutor);
    const transaction = jest
      .spyOn(sqlExecutor, 'executeNativeQueriesInTransaction')
      .mockImplementationOnce(async (...args) => {
        await cutAndLoad(false);
        return runTransaction(...args);
      });
    try {
      await runIdentityRedemptionWriters();
    } finally {
      transaction.mockRestore();
    }
    await runIdentityRedemptionWriters();

    // Charged once, by the load. Without the cursor check the run charged
    // it again into the loaded tables: 0.06942.
    expect(
      await balance(SUBSCRIPTIONS_ID_BALANCES_TABLE, 'identity_key', LONE)
    ).toBe(0.13471);
    const [redeemed] = await sqlExecutor.execute<{ count: number }>(
      `SELECT SUM(count) AS count FROM ${SUBSCRIPTIONS_ID_REDEEMED_TABLE}`
    );
    expect(Number(redeemed.count)).toBe(1);
    const [cursor] = await sqlExecutor.execute<{ block: number }>(
      `SELECT block FROM ${SUBSCRIPTIONS_ID_CURSORS_TABLE} WHERE id = :id`,
      { id: REDEMPTION_CURSOR_ID }
    );
    expect(Number(cursor.block)).toBe(50);
  });

  it('after the switch, charges up to the highest memes block while the legacy loop is behind', async () => {
    await seed();
    await updateSubscriptions();
    await execute(
      `INSERT INTO ${TRANSACTIONS_TABLE}
        (created_at, transaction, block, transaction_date, from_address, to_address,
         contract, token_id, token_count, value, primary_proceeds, royalties,
         gas_gwei, gas_price, gas_price_gwei, gas)
        VALUES (NOW(), '0xmint', 50, '2026-11-26 15:00:00', :null, :lone, :c, :card,
         1, 0, 0, 0, 0, 0, 0, 0)`,
      {
        null: NULL_ADDRESS,
        lone: LONE,
        c: MEMES_CONTRACT.toLowerCase(),
        card: CARD
      }
    );
    // The legacy loop has not run since: its processed block is still 1.
    await runIdentityRedemptionWriters();
    await runIdentityRedemptionWriters();

    // Charged once in the identity tables, the truth; not yet in legacy.
    // Bounded by the legacy loop's block, the run would charge nothing.
    expect(
      await balance(SUBSCRIPTIONS_ID_BALANCES_TABLE, 'identity_key', LONE)
    ).toBe(0.13471);
    expect(
      await balance(SUBSCRIPTIONS_BALANCES_TABLE, 'consolidation_key', LONE)
    ).toBe(0.2);
    const [cursor] = await sqlExecutor.execute<{ block: number }>(
      `SELECT block FROM ${SUBSCRIPTIONS_ID_CURSORS_TABLE} WHERE id = :id`,
      { id: REDEMPTION_CURSOR_ID }
    );
    expect(Number(cursor.block)).toBe(50);
    // The comparison names what it could not compare yet, with no
    // unexplained difference, so it raises no alert.
    const reports = await sqlExecutor.execute<{ report: string }>(
      `SELECT report FROM ${SUBSCRIPTIONS_ID_REPORTS_TABLE} WHERE kind = 'REDEMPTIONS'`
    );
    expect(reports).toHaveLength(1);
    const report = JSON.parse(reports[0].report);
    expect(report.mode).toBe('TRUTH');
    expect(report.diffs).toEqual([]);
    expect(report.unexplained).toBe(0);
    expect(report.notes).toEqual([
      "1 airdrop transaction(s) after the legacy loop's block 1: not compared; the legacy loop had not charged them"
    ]);
  });

  it('after the switch, compares the airdrop the legacy loop charged and names the later one, for one identity in one run', async () => {
    await seed();
    await updateSubscriptions();
    // Two editions for LONE on both lists, so both airdrops find one.
    for (const [table, column] of [
      [SUBSCRIPTIONS_NFTS_FINAL_TABLE, 'consolidation_key'],
      [SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE, 'identity_key']
    ]) {
      await execute(
        `UPDATE ${table} SET subscribed_count = 2 WHERE ${column} = :lone AND token_id = :card`,
        { lone: LONE, card: CARD }
      );
    }
    const airdrop = (hash: string, block: number) =>
      execute(
        `INSERT INTO ${TRANSACTIONS_TABLE}
          (created_at, transaction, block, transaction_date, from_address, to_address,
           contract, token_id, token_count, value, primary_proceeds, royalties,
           gas_gwei, gas_price, gas_price_gwei, gas)
          VALUES (NOW(), :hash, :block, '2026-11-26 15:00:00', :null, :lone, :c, :card,
           1, 0, 0, 0, 0, 0, 0, 0)`,
        {
          hash,
          block,
          null: NULL_ADDRESS,
          lone: LONE,
          c: MEMES_CONTRACT.toLowerCase(),
          card: CARD
        }
      );
    // The legacy loop charges the airdrop at block 40, and stops there.
    await airdrop('0xlow', 40);
    await redeemSubscriptions();
    await airdrop('0xhigh', 50);
    await runIdentityRedemptionWriters();

    // The identity side charged both; legacy only the first.
    expect(
      await balance(SUBSCRIPTIONS_ID_BALANCES_TABLE, 'identity_key', LONE)
    ).toBe(0.06942);
    expect(
      await balance(SUBSCRIPTIONS_BALANCES_TABLE, 'consolidation_key', LONE)
    ).toBe(0.13471);
    const reports = await sqlExecutor.execute<{ report: string }>(
      `SELECT report FROM ${SUBSCRIPTIONS_ID_REPORTS_TABLE} WHERE kind = 'REDEMPTIONS'`
    );
    expect(reports).toHaveLength(1);
    const report = JSON.parse(reports[0].report);
    // The airdrop at block 40 is compared and matches; the one at 50 and
    // LONE's balance are named as not compared.
    expect(report.diffs).toEqual([]);
    expect(report.unexplained).toBe(0);
    expect(report.notes).toEqual([
      "1 airdrop transaction(s) after the legacy loop's block 40: not compared; the legacy loop had not charged them",
      `balance of ${LONE} not compared: charged after the legacy loop's block too`
    ]);
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

  it("leaves the identity's mode row as it was when the folded wallet brings no mode", async () => {
    await seed();
    const W = wallet(8);
    // Less than a card: a balance and no mode.
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xa4', 62, '2026-11-26 13:00:00', :w, 0.05)`,
      { w: W }
    );
    await runIdentityTopUpWriters();
    const modeOf = (key: string) =>
      sqlExecutor.execute<{
        automatic: number;
        subscribe_all_editions: number;
        created_at: string;
        updated_at: string;
      }>(
        `SELECT automatic, subscribe_all_editions, CAST(created_at AS CHAR) AS created_at,
            CAST(updated_at AS CHAR) AS updated_at
          FROM ${SUBSCRIPTIONS_ID_MODE_TABLE} WHERE identity_key = :key`,
        { key }
      );
    expect(await modeOf(W)).toEqual([]);
    const before = await modeOf(P1);
    expect(before).toHaveLength(1);
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
    expect(await modeOf(P1)).toEqual(before);
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
