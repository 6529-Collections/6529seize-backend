import 'reflect-metadata';
import {
  ADDRESS_CONSOLIDATION_KEY,
  IDENTITIES_TABLE,
  MEMES_CONTRACT,
  SUBSCRIPTIONS_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_BALANCES_TABLE,
  SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_ID_LOGS_TABLE,
  SUBSCRIPTIONS_ID_STATE_TABLE,
  SUBSCRIPTIONS_LOGS_TABLE,
  SUBSCRIPTIONS_MODE_TABLE,
  SUBSCRIPTIONS_NFTS_FINAL_TABLE,
  SUBSCRIPTIONS_NFTS_TABLE,
  SUBSCRIPTIONS_REDEEMED_TABLE,
  SUBSCRIPTIONS_TOP_UP_TABLE,
  TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE
} from '@/constants';
import { connect, disconnect } from '@/db';
import {
  NFTFinalSubscription,
  NFTFinalSubscriptionUpload,
  NFTSubscription,
  RedeemedSubscription,
  SubscriptionBalance,
  SubscriptionLog,
  SubscriptionMode,
  SubscriptionTopUp,
  SubscriptionTopUpLatestBlock
} from '@/entities/ISubscription';
import {
  SubscriptionIdBalanceEntity,
  SubscriptionIdChoiceEntity,
  SubscriptionIdFinalEntity,
  SubscriptionIdFinalUploadEntity,
  SubscriptionIdKeyMapEntity,
  SubscriptionIdLogEntity,
  SubscriptionIdModeEntity,
  SubscriptionIdRedeemedEntity,
  SubscriptionIdStateEntity,
  SubscriptionIdTopUpEntity
} from '@/entities/ISubscriptionIdentity';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { mirrorIdentityDirectory } from '../identity/identity-directory';
import {
  scheduleIdentitySwitch,
  SubscriptionsIdentitySwitch,
  subscriptionsIdentitySwitch,
  suspendIdentityTables
} from '../identity/identity-switch';
import {
  fetchDetailsForConsolidationKey,
  fetchFinalSubscription,
  fetchLogsForConsolidationKey,
  fetchRedeemedSubscriptionsForConsolidationKey,
  fetchTopUpsForConsolidationKey
} from '@/api/subscriptions/api.subscriptions.db';
import { subscriptionChangeWriter } from '../records/subscription-writes';
import {
  deferSubscriptionWrites,
  executorSink
} from '@/subscription-key-width/subscription-deferred-writes';
import { cutOpeningFiles } from './opening-build';
import { compareAndMarkVerified } from './opening-compare';
import { loadOpeningFiles, parseOpeningFiles } from './opening-load';
import { verifyOpening } from './opening-verify';

const wallet = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const P1 = `0x${'a1'.padStart(64, '0')}`;
const A = wallet(1);
const B = wallet(2);
const LONE = wallet(4);
const C = wallet(3);
/** Fourteen wallets, too long for subscriptions_redeemed. */
const WIDE = Array.from({ length: 14 }, (_, i) => wallet(0x40 + i)).join('-');
const PAIR = `${A}-${B}`;
const NOV_20 = '2026-11-20 10:00:00.123456';
const NOV_21 = '2026-11-21 11:30:00.654321';
const CUT_MS = Date.parse('2026-11-26T12:00:00Z');

const execute = (sql: string, params?: Record<string, unknown>) =>
  sqlExecutor.execute(sql, params);

/** The identity mirror's principal table, as PR #2516 creates it. */
async function createPrincipalsTable() {
  await execute(`CREATE TABLE IF NOT EXISTS identity_chain_principals (
    principal_id varchar(66) NOT NULL PRIMARY KEY,
    profile_id varchar(50) NOT NULL UNIQUE,
    origin varchar(20) NOT NULL,
    created_at bigint NOT NULL)`);
}

async function seedLegacy() {
  await createPrincipalsTable();
  // The redemption loop has run: the identity writer goes on from its block.
  await execute(
    `INSERT INTO ${TRANSACTIONS_PROCESSED_SUBSCRIPTIONS_BLOCKS_TABLE} (created_at, block, timestamp)
      VALUES (NOW(), 40, 0)`
  );
  await execute(
    `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) VALUES (:a, :k), (:b, :k)`,
    { a: A, b: B, k: PAIR }
  );
  await execute(
    `INSERT INTO ${IDENTITIES_TABLE} (consolidation_key, profile_id, primary_address, tdh, rep, cic, level_raw)
      VALUES (:k, 'profile-1', :a, 0, 0, 0, 0)`,
    { k: PAIR, a: A }
  );
  await execute(
    `INSERT INTO identity_chain_principals VALUES (:p, 'profile-1', 'LEGACY', 0)`,
    { p: P1 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance, created_at, updated_at)
      VALUES (:k, 0.13058, :t1, :t2), (:lone, 0.13471, :t1, :t1)`,
    { k: PAIR, lone: LONE, t1: NOV_20, t2: NOV_21 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_MODE_TABLE} (consolidation_key, automatic, subscribe_all_editions, created_at, updated_at)
      VALUES (:k, true, false, :t1, :t2)`,
    { k: PAIR, t1: NOV_20, t2: NOV_21 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_NFTS_TABLE} (consolidation_key, contract, token_id, subscribed, subscribed_count, automatic_subscription, created_at, updated_at)
      VALUES (:k, :c, 580, true, 1, false, :t1, :t2)`,
    { k: PAIR, c: MEMES_CONTRACT, t1: NOV_20, t2: NOV_21 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount, created_at)
      VALUES ('0xaa', 10, '2026-11-01 00:00:00', :lone, 0.2, :t1),
             ('0xbb', 11, '2026-11-02 00:00:00', :b, 0.13058, :t1)`,
    { lone: LONE, b: B, t1: NOV_20 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_NFTS_FINAL_TABLE}
      (id, consolidation_key, contract, token_id, subscribed_count, airdrop_address, balance,
       subscribed_at, phase, phase_subscriptions, phase_position, redeemed_count, created_at, updated_at)
      VALUES (1001, :lone, :c, 579, 1, :lone, 0.2, :t1, 'Public', 1, 0, 1, :t1, :t1),
             (1005, :lone, :c, 578, 1, :lone, 0.2, :t1, 'Phase 1', 1, 3, 0, :t1, :t1)`,
    { lone: LONE, c: MEMES_CONTRACT, t1: NOV_20 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_REDEEMED_TABLE}
      (contract, token_id, address, transaction, transaction_date, consolidation_key, value, balance_after, count, created_at)
      VALUES (:c, 579, :lone, '0xt1', '2026-11-25 15:00:00', :lone, 0.06529, 0.13471, 1, :t1)`,
    { lone: LONE, c: MEMES_CONTRACT, t1: NOV_20 }
  );
  await execute(
    `INSERT INTO ${SUBSCRIPTIONS_LOGS_TABLE} (consolidation_key, log, additional_info, created_at)
      VALUES (:k, 'Subscribed for Meme #580', NULL, :t2), (:lone, 'Top up', 'x', :t1)`,
    { k: PAIR, lone: LONE, t1: NOV_20, t2: NOV_21 }
  );
}

function switchAt(nowMs: number) {
  return new SubscriptionsIdentitySwitch(undefined, () => nowMs);
}

async function cutAndParse() {
  const files = await cutOpeningFiles(mirrorIdentityDirectory, CUT_MS);
  return {
    files,
    parsed: parseOpeningFiles(files.openingBytes, files.historyBytes)
  };
}

beforeAll(async () => {
  await connect([
    SubscriptionBalance,
    SubscriptionTopUp,
    SubscriptionMode,
    SubscriptionLog,
    NFTSubscription,
    NFTFinalSubscription,
    NFTFinalSubscriptionUpload,
    RedeemedSubscription,
    SubscriptionTopUpLatestBlock,
    SubscriptionIdBalanceEntity,
    SubscriptionIdChoiceEntity,
    SubscriptionIdFinalEntity,
    SubscriptionIdFinalUploadEntity,
    SubscriptionIdKeyMapEntity,
    SubscriptionIdLogEntity,
    SubscriptionIdModeEntity,
    SubscriptionIdRedeemedEntity,
    SubscriptionIdStateEntity,
    SubscriptionIdTopUpEntity
  ]);
});

afterAll(async () => {
  await disconnect();
});

describeWithSeed('subscriptions opening file', [], () => {
  it('cuts, verifies, loads and compares; the identity tables become the truth after the switch time', async () => {
    await seedLegacy();
    const { files, parsed } = await cutAndParse();
    expect(files.opening.blocked).toEqual([]);
    expect(
      files.opening.balances.map((b) => [b.identityKey, b.balance])
    ).toEqual([
      [P1, 0.13058],
      [LONE, 0.13471]
    ]);
    expect(files.opening.choices.map((c) => c.identityKey)).toEqual([P1]);
    expect(files.opening.topUps.map((t) => t.identityKey)).toEqual([LONE, P1]);

    const report = verifyOpening(parsed);
    expect(report.verdict).toBe('PASS');
    expect(report.conservation.adjustments).toEqual([]);

    await loadOpeningFiles(parsed, CUT_MS + 1);
    expect((await switchAt(CUT_MS).status()).reason).toBe('NO_SWITCH_TIME');
    // A switch time can't be set on an unverified load.
    expect(await scheduleIdentitySwitch(CUT_MS + 5, parsed.openingSha256)).toBe(
      false
    );

    const g4 = await compareAndMarkVerified(
      parsed,
      mirrorIdentityDirectory,
      CUT_MS + 2
    );
    expect(g4.diffs.filter((d) => d.missingCount || d.extraCount)).toEqual([]);
    expect(g4.ok).toBe(true);
    // Only a cut taken at the switch counts: not one from 16 minutes before.
    expect(
      await scheduleIdentitySwitch(
        CUT_MS + 16 * 60 * 1000,
        parsed.openingSha256
      )
    ).toBe(false);
    expect(await scheduleIdentitySwitch(CUT_MS + 5, parsed.openingSha256)).toBe(
      true
    );
    expect((await switchAt(CUT_MS + 4).status()).reason).toBe(
      'BEFORE_SWITCH_TIME'
    );
    expect(await switchAt(CUT_MS + 5).identityTablesAreTruth()).toBe(true);
    // Tables that are the truth are never wiped by another load.
    await expect(loadOpeningFiles(parsed)).rejects.toThrow('suspend them');

    // Dates load back to the microsecond, so queue order is kept.
    const [balance] = await sqlExecutor.execute<{ updated_at: string }>(
      `SELECT DATE_FORMAT(updated_at, '%Y-%m-%d %H:%i:%s.%f') AS updated_at
         FROM ${SUBSCRIPTIONS_ID_BALANCES_TABLE} WHERE identity_key = :p`,
      { p: P1 }
    );
    expect(balance.updated_at).toBe(NOV_21);

    expect(await suspendIdentityTables(CUT_MS + 6)).toBe(true);
    expect((await switchAt(CUT_MS + 7).status()).reason).toBe('SUSPENDED');
    await loadOpeningFiles(parsed);
  });

  it('finds a legacy write after the cut and marks nothing', async () => {
    await seedLegacy();
    const { parsed } = await cutAndParse();
    await loadOpeningFiles(parsed);
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xcc', 12, '2026-11-26 12:00:30', :lone, 1)`,
      { lone: LONE }
    );
    const g4 = await compareAndMarkVerified(parsed, mirrorIdentityDirectory);
    expect(g4.ok).toBe(false);
    expect(
      g4.diffs
        .filter((d) => d.missingCount || d.extraCount)
        .map((d) => [d.section, d.missingCount, d.extraCount])
    ).toEqual([['legacy.topUps', 0, 1]]);
    const [state] = await sqlExecutor.execute<{ verified_at: number | null }>(
      `SELECT verified_at FROM ${SUBSCRIPTIONS_ID_STATE_TABLE}`
    );
    expect(state.verified_at).toBeNull();
    expect(await switchAt(CUT_MS).identityTablesAreTruth()).toBe(false);
  });

  it('refuses to load a file with a key that spans identities', async () => {
    await seedLegacy();
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance) VALUES (:k, 1)`,
      { k: `${A}-${LONE}` }
    );
    const { files, parsed } = await cutAndParse();
    expect(files.opening.blocked).toEqual([
      {
        consolidationKey: `${A}-${LONE}`,
        reason: 'SPANS_IDENTITIES',
        identities: [P1, LONE]
      }
    ]);
    await expect(loadOpeningFiles(parsed)).rejects.toThrow(
      'lists 1 blocked keys'
    );
  });

  it('loads a history log line of a key that now spans identities, once per identity, with distinct ids', async () => {
    await seedLegacy();
    // A line written when A and LONE were one consolidation, since split.
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_LOGS_TABLE} (consolidation_key, log, additional_info, created_at)
        VALUES (:k, 'Subscription Mode set to Manual', NULL, :t1)`,
      { k: `${A}-${LONE}`, t1: NOV_20 }
    );
    const [line] = await sqlExecutor.execute<{ id: number }>(
      `SELECT id FROM ${SUBSCRIPTIONS_LOGS_TABLE} WHERE consolidation_key = :k`,
      { k: `${A}-${LONE}` }
    );
    const { parsed } = await cutAndParse();
    await loadOpeningFiles(parsed);
    const copies = await sqlExecutor.execute<{
      id: number;
      legacy_id: number;
      identity_key: string;
    }>(
      `SELECT id, legacy_id, identity_key FROM ${SUBSCRIPTIONS_ID_LOGS_TABLE}
        WHERE legacy_id = :id ORDER BY id`,
      { id: line.id }
    );
    expect(copies.map((c) => c.identity_key).sort()).toEqual([LONE, P1].sort());
    // The first copy keeps the legacy id; the other takes one above them all.
    expect(Number(copies[0].id)).toBe(Number(line.id));
    const [highest] = await sqlExecutor.execute<{ id: number }>(
      `SELECT MAX(id) AS id FROM ${SUBSCRIPTIONS_LOGS_TABLE}`
    );
    expect(Number(copies[1].id)).toBeGreaterThan(Number(highest.id));
  });

  it('keeps final row ids, merges keys the re-key left apart, and credits waiting top-ups', async () => {
    await seedLegacy();
    // C joined P1's identity, but the re-key was held back: C's own key
    // still holds a balance and a mode.
    await execute(
      `INSERT INTO ${ADDRESS_CONSOLIDATION_KEY} (address, consolidation_key) VALUES (:c, :k)`,
      { c: C, k: `${PAIR}-${C}` }
    );
    await execute(
      `UPDATE ${ADDRESS_CONSOLIDATION_KEY} SET consolidation_key = :k WHERE address IN (:a, :b)`,
      { k: `${PAIR}-${C}`, a: A, b: B }
    );
    await execute(
      `UPDATE ${IDENTITIES_TABLE} SET consolidation_key = :k WHERE profile_id = 'profile-1'`,
      { k: `${PAIR}-${C}` }
    );
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_BALANCES_TABLE} (consolidation_key, balance) VALUES (:c, 0.5)`,
      { c: C }
    );
    await execute(
      `INSERT INTO ${SUBSCRIPTIONS_TOP_UP_TABLE} (hash, block, transaction_date, from_wallet, amount)
        VALUES ('0xc0', 9, '2026-10-01 00:00:00', :c, 0.5)`,
      { c: C }
    );
    // A top-up from a wallet of a 14-wallet identity, waiting in the queue.
    await deferSubscriptionWrites(
      [
        {
          kind: 'TOP_UP',
          consolidationKey: WIDE,
          dedupe: '0xwide',
          payload: {
            topUp: {
              hash: '0xwide',
              block: 12,
              transaction_date: new Date('2026-11-25T09:00:00Z'),
              from_wallet: LONE,
              amount: 0.06529
            }
          },
          reason: { narrow: [], pendingEarlier: false }
        }
      ],
      executorSink()
    );

    const { files, parsed } = await cutAndParse();
    expect(files.opening.blocked).toEqual([]);
    expect(files.opening.merged).toEqual([
      { identityKey: P1, consolidationKeys: [PAIR, C].sort() }
    ]);
    expect(
      files.opening.balances.map((b) => [b.identityKey, b.balance])
    ).toEqual([
      [P1, 0.63058],
      [LONE, 0.2]
    ]);
    expect(
      files.opening.queued.map((q) => [q.kind, q.identityKey, q.effect])
    ).toEqual([['TOP_UP', LONE, 'TOP_UP_CREDITED']]);
    expect(verifyOpening(parsed).conservation.adjustments).toEqual([]);

    await loadOpeningFiles(parsed);
    const ids = await sqlExecutor.execute<{ id: number }>(
      `SELECT id FROM ${SUBSCRIPTIONS_ID_NFTS_FINAL_TABLE} ORDER BY id`
    );
    expect(ids.map((r) => Number(r.id))).toEqual([1001, 1005]);
    const g4 = await compareAndMarkVerified(parsed, mirrorIdentityDirectory);
    expect(g4.diffs.filter((d) => d.missingCount || d.extraCount)).toEqual([]);
    expect(g4.ok).toBe(true);
  });

  it('blocks the cut while a redemption is waiting', async () => {
    await seedLegacy();
    await deferSubscriptionWrites(
      [
        {
          kind: 'REDEMPTION',
          consolidationKey: LONE,
          dedupe: 'r1',
          payload: {},
          reason: { narrow: [], pendingEarlier: true }
        }
      ],
      executorSink()
    );
    const { files, parsed } = await cutAndParse();
    expect(files.opening.blocked).toEqual([
      {
        consolidationKey: LONE,
        reason: 'PENDING_REDEMPTION',
        identities: [LONE]
      }
    ]);
    await expect(loadOpeningFiles(parsed)).rejects.toThrow('blocked keys');
  });

  it('serves the identity tables once they are the truth, and refuses unsigned writes', async () => {
    await seedLegacy();
    const { parsed } = await cutAndParse();
    await loadOpeningFiles(parsed);
    expect(
      (await compareAndMarkVerified(parsed, mirrorIdentityDirectory)).ok
    ).toBe(true);
    // The legacy tables move on; the identity tables don't see it.
    await execute(
      `UPDATE ${SUBSCRIPTIONS_BALANCES_TABLE} SET balance = 9 WHERE consolidation_key = :k`,
      { k: PAIR }
    );
    try {
      subscriptionsIdentitySwitch.invalidate();
      expect((await fetchDetailsForConsolidationKey(PAIR)).balance).toBe(9);

      expect(
        await scheduleIdentitySwitch(Date.now(), parsed.openingSha256)
      ).toBe(true);
      // By the consolidation key, a wallet, or the principal id.
      for (const key of [PAIR, A, P1]) {
        const details = await fetchDetailsForConsolidationKey(key);
        expect([details.balance, details.automatic]).toEqual([0.13058, true]);
        expect(details.consolidation_key).toBe(key);
      }
      const logs = await fetchLogsForConsolidationKey(P1, 10, 1);
      expect(logs.data.map((l: any) => l.log)).toEqual([
        'Subscribed for Meme #580'
      ]);
      const topUps = await fetchTopUpsForConsolidationKey(PAIR, 10, 1);
      expect(topUps.data.map((t: any) => t.hash)).toEqual(['0xbb']);
      const redeemed = await fetchRedeemedSubscriptionsForConsolidationKey(
        LONE,
        10,
        1
      );
      expect(redeemed.data.map((r: any) => r.transaction)).toEqual(['0xt1']);
      expect(
        (await fetchFinalSubscription(LONE, MEMES_CONTRACT, 579))?.id
      ).toBe(1001);
      await expect(
        fetchDetailsForConsolidationKey(`${A}-${LONE}`)
      ).rejects.toThrow('more than one identity');
      await expect(
        subscriptionChangeWriter.write({
          routeKey: PAIR,
          wallet: A,
          walletInKey: true,
          signedRecords: undefined,
          change: {
            type: 'subs.card',
            contract: MEMES_CONTRACT,
            tokenId: 580,
            subscribed: false
          }
        })
      ).rejects.toThrow('Subscription changes are signed now');
    } finally {
      subscriptionsIdentitySwitch.invalidate();
    }
  });

  it('replaces an earlier load whole', async () => {
    await seedLegacy();
    const { parsed } = await cutAndParse();
    await loadOpeningFiles(parsed);
    await loadOpeningFiles(parsed);
    const g4 = await compareAndMarkVerified(parsed, mirrorIdentityDirectory);
    expect(g4.ok).toBe(true);
  });
});
