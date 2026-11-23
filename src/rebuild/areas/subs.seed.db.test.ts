import 'reflect-metadata';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { MEMES_CONTRACT, NULL_ADDRESS } from '@/constants';
import type { RebuildContext } from '@/rebuild/manifest.types';
import { PROBE_CONSOLIDATION_KEYS } from '@/rebuild/manifests/probe-fixture';
import { subsManifest } from '@/rebuild/manifests/subs.manifest';
import { seedProbeIdentities } from '@/rebuild/run/probe-fixture.steps';
import { connect, disconnect, execSQLWithParams, getDataSource } from '@/db';
import { DbQueryOptions } from '@/db-query.options';
import * as Entities from '@/entities/entities';
import {
  ConnectionWrapper,
  setSqlExecutor,
  SqlExecutor,
  sqlExecutor
} from '@/sql-executor';
import { subscriptionsIdentitySwitch } from '@/subscriptions-identity/identity/identity-switch';
import {
  rebuildLegacyHistoryInCheck,
  rebuildLegacyStateInCheck,
  rebuildSubscriptionsInCheck
} from '@/subscriptions-identity/opening/rebuild-check.steps';
import { splitAllowlistResults } from '@/api/subscriptions/api.subscriptions.allowlist';
import { fetchFinalSubscriptionsByPhase } from '@/api/subscriptions/api.subscriptions.db';
import { persistTopUps } from '@/subscriptionsTopUpLoop/db.subscriptions_topup';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  seedSubscriptionRedemptions,
  seedSubscriptions,
  SubscriptionsSeedDeps,
  seedSubscriptionsSwitch
} from './subs.seed';

jest.mock('@/subscriptionsDaily/subscription-cache', () => ({
  invalidateUpcomingSubscriptionCaches: jest.fn()
}));

/** The identity tables the rebuild fills, and the columns compared. */
const TABLES: readonly [string, string][] = [
  [
    'subscriptions_id_balances',
    'identity_key, balance, created_at, updated_at'
  ],
  ['subscriptions_id_mode', '*'],
  ['subscriptions_id_nfts', '*'],
  ['subscriptions_id_top_up', '*'],
  ['subscriptions_id_logs', '*'],
  ['subscriptions_id_key_map', '*'],
  ['subscriptions_id_nfts_final', '*'],
  ['subscriptions_id_nfts_final_upload', '*'],
  ['subscriptions_id_redeemed', '*'],
  // loaded_at and verified_at are the load's and the check's own times
  // (volatile in the manifest).
  [
    'subscriptions_id_state',
    'id, opening_sha256, history_sha256, opening_uri, history_uri, cut_at, switch_at, suspended_at'
  ],
  // updated_at is housekeeping (volatile in the manifest).
  ['subscriptions_id_cursors', 'id, block'],
  // The signed choice's head, which the rebuild puts back.
  [
    'signed_record_heads',
    'owner, family, rtype, rkey, anchor, claimed_time, event_id'
  ]
];

/**
 * The rollback copy the copy-back rebuilds, without the columns the
 * manifest marks volatile (the rows' own times, the choices' ids).
 */
const LEGACY_TABLES: readonly [string, string][] = [
  ['subscriptions_balances', 'consolidation_key, balance'],
  [
    'subscriptions_mode',
    'consolidation_key, automatic, subscribe_all_editions'
  ],
  [
    'subscriptions_nfts',
    'consolidation_key, contract, token_id, subscribed_count, subscribed, automatic_subscription'
  ],
  [
    'subscriptions_nfts_final',
    'id, consolidation_key, contract, token_id, subscribed_count, airdrop_address, balance, subscribed_at, phase, phase_subscriptions, phase_position, redeemed_count'
  ],
  ['subscriptions_nfts_final_upload', 'contract, token_id, date, upload_url'],
  [
    'subscriptions_redeemed',
    'contract, token_id, address, `transaction`, transaction_date, consolidation_key, value, balance_after, count'
  ]
];

async function snapshot(
  tables: readonly [string, string][] = TABLES
): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const [table, columns] of tables) {
    const all = await sqlExecutor.execute<Record<string, unknown>>(
      `select ${columns} from ${table}`
    );
    rows[table] = all.map((row) => JSON.stringify(row)).sort();
  }
  return rows;
}

/** The run's files source: the seed files over loopback, as /ar/ and /ipfs/. */
async function serveFiles(dir: string): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const id = decodeURIComponent((req.url ?? '').split('/').pop() ?? '');
    const file = path.join(dir, id);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function contextOf(
  stepId: string,
  files: string,
  seedFilesDir: string | null
): RebuildContext {
  return {
    area: 'subs',
    stepId,
    sources: {
      gateway: null,
      relays: null,
      ethereum: null,
      files,
      repo: null
    },
    seedFilesDir,
    mark: { name: 'head', chainHeight: null, ethBlock: null }
  };
}

/**
 * The steps run on TypeORM query runners, as in the run (doInDbContext):
 * the top-up loop's write needs one. This runs the production executor's
 * statements on the test's data source.
 */
class TypeOrmExecutor extends SqlExecutor {
  execute<T>(
    sql: string,
    params?: Record<string, any>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    return execSQLWithParams(sql, params, options);
  }

  async executeNativeQueriesInTransaction<T>(
    executable: (connection: ConnectionWrapper<any>) => Promise<T>
  ): Promise<T> {
    const runner = getDataSource().createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const result = await executable({ connection: runner });
      await runner.commitTransaction();
      return result;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}

beforeAll(async () => {
  await connect(
    Object.values(Entities).filter((e) => typeof e === 'function') as never
  );
});

afterAll(async () => {
  await disconnect();
});

/**
 * Top-ups as the top-up loop's discovery credits them (persistTopUps), with
 * made-up transaction hashes, one block each: the run makes them on anvil
 * instead.
 */
function creditedTopUps(): SubscriptionsSeedDeps {
  let block = 1_000;
  return {
    topUp: async (wallet, amountEth) => {
      block += 1;
      await persistTopUps([
        {
          hash: `0x${block.toString(16).padStart(64, '0')}`,
          block,
          transaction_date: new Date('2026-01-01T00:00:00Z'),
          from_wallet: wallet,
          amount: Number(amountEth)
        }
      ]);
    },
    head: async () => block
  };
}

/**
 * The holdings seed's mint of card 1 to the first probe wallet, as its
 * transactions loop indexes it: an airdrop from the null address in a
 * block after the seeds'. A test fixture only: the run mints it on anvil.
 */
async function mintCardOne(): Promise<void> {
  await sqlExecutor.execute(
    `insert into transactions
      (created_at, transaction, block, transaction_date, from_address, to_address,
       contract, token_id, token_count, value, primary_proceeds, royalties,
       gas_gwei, gas_price, gas_price_gwei, gas)
      values (now(), :hash, 2000, '2026-01-02 15:00:00', :from, :to, :contract,
       1, 1, 0, 0, 0, 0, 0, 0, 0)`,
    {
      hash: `0x${'c1'.padStart(64, '0')}`,
      from: NULL_ADDRESS,
      to: PROBE_CONSOLIDATION_KEYS[0],
      contract: MEMES_CONTRACT.toLowerCase()
    }
  );
}

/** The record log's `lane` values that have entries no segment closed yet. */
async function openLanes(): Promise<string[]> {
  return (
    await sqlExecutor.execute<{ lane: string }>(
      `select distinct lane from signed_record_log_entries
        where segment_seq is null order by lane`
    )
  ).map((row) => row.lane);
}

/** Inserts a row, filling NOT NULL columns without a default with zeros. */
async function insertFilled(
  table: string,
  values: Record<string, unknown>
): Promise<void> {
  const required = await sqlExecutor.execute<{ c: string; t: string }>(
    `select column_name as c, data_type as t from information_schema.columns
      where table_schema = database() and table_name = :table
        and is_nullable = 'NO' and column_default is null
        and extra not like '%auto_increment%'`,
    { table }
  );
  const row: Record<string, unknown> = { ...values };
  for (const { c, t } of required) {
    if (!(c in row)) {
      row[c] = /date|time/.test(t)
        ? '2026-01-01 00:00:00'
        : /char|text/.test(t)
          ? ''
          : 0;
    }
  }
  const columns = Object.keys(row);
  await sqlExecutor.execute(
    `insert into ${table} (${columns.map((c) => `\`${c}\``).join(', ')})
      values (${columns.map((c) => `:${c}`).join(', ')})`,
    row
  );
}

describeWithSeed('the subscriptions rebuild check', [], () => {
  let dir: string;
  let server: http.Server;
  let files: string;

  beforeEach(async () => {
    setSqlExecutor(new TypeOrmExecutor());
    // A test fixture only: the identity mirror's principals table, which the
    // cut reads. The identity mirror (#2516) owns it and creates it; until
    // that is in, the test schema has no entity for it.
    await sqlExecutor.execute(`CREATE TABLE IF NOT EXISTS identity_chain_principals (
      principal_id varchar(66) NOT NULL PRIMARY KEY,
      profile_id varchar(50) NOT NULL UNIQUE,
      origin varchar(20) NOT NULL,
      created_at bigint NOT NULL)`);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs-seed-'));
    server = await serveFiles(dir);
    files = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('seeds a switched opening, a list and its redemption, and rebuilds the identity tables from its files and journal alone, then the rollback copy from them', async () => {
    const env = subsManifest.flags;
    const deps = creditedTopUps();
    await seedProbeIdentities();
    await seedSubscriptions(contextOf('subs.seed', files, null), deps);
    await seedSubscriptionsSwitch(
      contextOf('subs.switch', files, dir),
      env,
      deps
    );
    expect(await subscriptionsIdentitySwitch.writeModeOrFail()).toBe('TRUTH');
    // With the identity tables there and the truth, the seed closed every
    // record log entry it wrote.
    expect(await openLanes()).toEqual([]);
    // Each head drop it posted is followed by its author, as drop creation
    // does.
    const headDrops = await sqlExecutor.execute<{ id: string }>(
      `select id from drops where wave_id = :wave order by id`,
      { wave: env.SIGNED_RECORDS_WAVE_ID }
    );
    expect(headDrops.length).toBeGreaterThan(0);
    expect(
      await sqlExecutor.execute(
        `select subscriber_id, target_id, target_type, target_action, wave_id
           from identity_subscriptions
          where target_type = 'DROP' order by target_id`
      )
    ).toEqual(
      headDrops.map((drop) => ({
        subscriber_id: env.SIGNED_RECORDS_SERVICE_PROFILE_ID,
        target_id: drop.id,
        target_type: 'DROP',
        target_action: 'DROP_REPLIED',
        wave_id: env.SIGNED_RECORDS_WAVE_ID
      }))
    );

    // Card 1's list: the first wallet, whose top-up covers a card and
    // turned automatic mode on, on both sides with one id, published into
    // the seed files.
    const finals = () =>
      sqlExecutor.execute<{ id: number; airdrop_address: string }>(
        `select id, airdrop_address from subscriptions_nfts_final
          where token_id = 1 order by id`
      );
    const identityFinals = () =>
      sqlExecutor.execute<{ id: number; airdrop_address: string }>(
        `select id, airdrop_address from subscriptions_id_nfts_final
          where token_id = 1 order by id`
      );
    expect((await finals()).map((r) => r.airdrop_address)).toEqual([
      PROBE_CONSOLIDATION_KEYS[0]
    ]);
    expect(await identityFinals()).toEqual(await finals());
    const [upload] = await sqlExecutor.execute<{ upload_url: string }>(
      `select upload_url from subscriptions_id_nfts_final_upload where token_id = 1`
    );
    const uploaded = upload.upload_url.split('/').pop()!;
    expect(fs.readFileSync(path.join(dir, uploaded), 'utf8')).toContain(
      PROBE_CONSOLIDATION_KEYS[0]
    );

    // The holdings seed mints card 1; the redemption charges it.
    await mintCardOne();
    await seedSubscriptionRedemptions(
      contextOf('subs.redemptions', files, dir),
      env
    );
    expect(await openLanes()).toEqual([]);
    const redeemed = (table: string) =>
      sqlExecutor.execute<{ address: string }>(
        `select address from ${table} where token_id = 1`
      );
    expect(await redeemed('subscriptions_redeemed')).toEqual([
      { address: PROBE_CONSOLIDATION_KEYS[0] }
    ]);
    expect(await redeemed('subscriptions_id_redeemed')).toEqual(
      await redeemed('subscriptions_redeemed')
    );
    const [charged] = await sqlExecutor.execute<{
      legacy: number;
      identity: number;
    }>(
      `select (select balance from subscriptions_balances where consolidation_key = :key) as legacy,
              (select balance from subscriptions_id_balances where identity_key = :key) as identity`,
      { key: PROBE_CONSOLIDATION_KEYS[0] }
    );
    expect(Number(charged.identity)).toBeLessThan(0.25);
    expect(Number(charged.legacy)).toBe(Number(charged.identity));

    const before = await snapshot();
    expect(before.subscriptions_id_balances).toHaveLength(2);
    expect(before.subscriptions_id_top_up).toHaveLength(3);
    // The signed choice after the switch: its head, in the subscriptions'
    // family and type.
    expect(
      before.signed_record_heads.map((row) => {
        const { family, rtype } = JSON.parse(row as string);
        return [family, rtype];
      })
    ).toEqual([['ps', 'subs.all-editions']]);
    const legacyBefore = await snapshot(LEGACY_TABLES);
    expect(legacyBefore.subscriptions_balances).toHaveLength(2);
    expect(legacyBefore.subscriptions_nfts_final).toHaveLength(1);
    expect(legacyBefore.subscriptions_nfts_final_upload).toHaveLength(1);
    expect(legacyBefore.subscriptions_redeemed).toHaveLength(1);

    // The drop: every table the rebuilders write, from empty.
    for (const [table] of [...TABLES, ...LEGACY_TABLES]) {
      await sqlExecutor.execute(`delete from ${table}`);
    }
    subscriptionsIdentitySwitch.invalidate();

    await rebuildSubscriptionsInCheck(
      contextOf('subs.identity', files, null),
      env
    );
    expect(await snapshot()).toEqual(before);
    subscriptionsIdentitySwitch.invalidate();
    expect(await subscriptionsIdentitySwitch.writeModeOrFail()).toBe('TRUTH');

    await rebuildLegacyHistoryInCheck();
    await rebuildLegacyStateInCheck();
    expect(await snapshot(LEGACY_TABLES)).toEqual(legacyBefore);
  });

  it("refuses to close another record log lane's open entries into the journal's segment", async () => {
    const env = subsManifest.flags;
    const deps = creditedTopUps();
    await seedProbeIdentities();
    // An entry of another record log lane, left open by its own seed.
    await sqlExecutor.execute(
      `insert into signed_record_log_entries (chain, lane, entry, created_at, segment_seq)
        values ('public', 'other', '{}', 0, null)`
    );
    await seedSubscriptions(contextOf('subs.seed', files, null), deps);
    await expect(
      seedSubscriptionsSwitch(contextOf('subs.switch', files, dir), env, deps)
    ).rejects.toThrow('Open record log entries of other lanes (other)');
  });

  it('refuses a redemption loop processed block at genesis, which the loop would take as its first run', async () => {
    await seedProbeIdentities();
    await expect(
      seedSubscriptions(contextOf('subs.seed', files, null), {
        topUp: async () => undefined,
        head: async () => 0
      })
    ).rejects.toThrow('processed block must be past genesis, not 0');
  });

  it('refuses to build a list once a card is minted: the switch seed runs before the holdings seed', async () => {
    const env = subsManifest.flags;
    const deps = creditedTopUps();
    await seedProbeIdentities();
    await seedSubscriptions(contextOf('subs.seed', files, null), deps);
    // The holdings seed's card 1, there too early.
    await insertFilled('nfts', { id: 1, contract: MEMES_CONTRACT });
    await expect(
      seedSubscriptionsSwitch(contextOf('subs.switch', files, dir), env, deps)
    ).rejects.toThrow(
      'but card 1 is minted already: subs.seed and subs.switch must run before holdings.seed'
    );
  });

  it('fails the redemption seed, naming the holdings seed, when no card is minted at all', async () => {
    const env = subsManifest.flags;
    const deps = creditedTopUps();
    await seedProbeIdentities();
    await seedSubscriptions(contextOf('subs.seed', files, null), deps);
    await seedSubscriptionsSwitch(
      contextOf('subs.switch', files, dir),
      env,
      deps
    );
    await expect(
      seedSubscriptionRedemptions(
        contextOf('subs.redemptions', files, dir),
        env
      )
    ).rejects.toThrow(
      "charged no airdrop: card 1 isn't minted: holdings.seed hasn't run (it lands with #2551)"
    );
  });

  it("after the switch, another area's phase split of card 1 journals in lane `subs`, for the seed that ran it to close", async () => {
    const env = subsManifest.flags;
    const deps = creditedTopUps();
    await seedProbeIdentities();
    await seedSubscriptions(contextOf('subs.seed', files, null), deps);
    await seedSubscriptionsSwitch(
      contextOf('subs.switch', files, dir),
      env,
      deps
    );
    expect(await openLanes()).toEqual([]);
    // The distribution's phase split, as the mint seed runs it for card 1:
    // the subscriptions module writes the phase to the identity final rows
    // and journals it.
    await splitAllowlistResults(MEMES_CONTRACT, 1, 'Phase 1', [
      {
        id: 'phase-split-1',
        wallet: PROBE_CONSOLIDATION_KEYS[0],
        phaseId: 'phase-1',
        allowlistId: 'allowlist-1',
        phaseComponentId: 'component-1',
        amount: 1
      },
      {
        id: 'phase-split-2',
        wallet: PROBE_CONSOLIDATION_KEYS[1],
        phaseId: 'phase-1',
        allowlistId: 'allowlist-1',
        phaseComponentId: 'component-1',
        amount: 3
      }
    ]);
    expect(await openLanes()).toEqual(['subs']);
    // The split names card 1's phase on both sides, and the final-phase
    // route answers it under that name, not under any other.
    const phases = (table: string) =>
      sqlExecutor.execute<{ phase: string | null }>(
        `select phase from ${table} where token_id = 1`
      );
    expect(await phases('subscriptions_id_nfts_final')).toEqual([
      { phase: 'Phase 1' }
    ]);
    expect(await phases('subscriptions_nfts_final')).toEqual([
      { phase: 'Phase 1' }
    ]);
    expect(
      await fetchFinalSubscriptionsByPhase(MEMES_CONTRACT, 1, 'Phase 1')
    ).toEqual([{ wallet: PROBE_CONSOLIDATION_KEYS[0], amount: 1 }]);
    expect(
      await fetchFinalSubscriptionsByPhase(MEMES_CONTRACT, 1, 'Subscriptions')
    ).toEqual([]);
  });

  it("fails the redemption seed, naming the order, when cards are minted but card 1's airdrop was not charged", async () => {
    const env = subsManifest.flags;
    const deps = creditedTopUps();
    await seedProbeIdentities();
    await seedSubscriptions(contextOf('subs.seed', files, null), deps);
    await seedSubscriptionsSwitch(
      contextOf('subs.switch', files, dir),
      env,
      deps
    );
    // Card 1 is there, but no airdrop of it after the list.
    await insertFilled('nfts', { id: 1, contract: MEMES_CONTRACT });
    await expect(
      seedSubscriptionRedemptions(
        contextOf('subs.redemptions', files, dir),
        env
      )
    ).rejects.toThrow(
      'charged no airdrop of card 1 (identity 0, legacy 0): subs.switch must build its list before holdings.seed mints the card'
    );
  });

  it('fails a rebuild whose journal never reached a closed segment', async () => {
    const env = subsManifest.flags;
    await expect(
      rebuildSubscriptionsInCheck(contextOf('subs.identity', files, null), env)
    ).rejects.toThrow('never reached a closed segment');
  });
});
