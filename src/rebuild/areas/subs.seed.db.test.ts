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
import { parseSegmentFile } from '@/signed-records/record-log/record-log-format';
import { journalBodyOf } from '@/subscriptions-identity/timeline/journal';
import {
  rebuildLegacyHistoryInCheck,
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
import {
  WIDE_KEY,
  WIDE_PRINCIPAL,
  WIDE_TOP_UP,
  WIDE_WALLETS
} from './subs.wide-identity';

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
    mark: { name: 'head', chainHeight: null, ethBlock: null },
    final: false
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

/**
 * The listed waves' drop metrics are what their drops make them, as drop
 * creation leaves them: each wave has drops, its row's chat and
 * participatory counts and latest drop time match them, and so does each
 * author's row. Plain SQL, not the metrics recount, so the seed's metrics
 * aren't checked against themselves.
 */
async function expectDropMetricsOfDrops(
  waveIds: readonly string[]
): Promise<void> {
  for (const wave_id of waveIds) {
    const [row] = await sqlExecutor.execute<{
      drops_count: number;
      participatory_drops_count: number;
      latest_drop_timestamp: number;
    }>(
      `select drops_count, participatory_drops_count, latest_drop_timestamp
         from wave_metrics where wave_id = :wave_id`,
      { wave_id }
    );
    const [want] = await sqlExecutor.execute<{
      chat: number;
      participatory: number;
      latest: number;
    }>(
      `select sum(drop_type = 'CHAT') as chat,
              sum(drop_type = 'PARTICIPATORY') as participatory,
              max(created_at) as latest
         from drops where wave_id = :wave_id`,
      { wave_id }
    );
    expect(Number(want.chat) + Number(want.participatory)).toBeGreaterThan(0);
    expect(row).toBeDefined();
    expect(Number(row.drops_count)).toBe(Number(want.chat));
    expect(Number(row.participatory_drops_count)).toBe(
      Number(want.participatory)
    );
    expect(Number(row.latest_drop_timestamp)).toBe(Number(want.latest));
  }
  const authorsOff = await sqlExecutor.execute(
    `select d.wave_id, d.author_id
       from (select wave_id, author_id,
                    sum(drop_type = 'CHAT') as chat,
                    sum(drop_type = 'PARTICIPATORY') as participatory,
                    max(created_at) as latest
               from drops
              where wave_id in (:waveIds)
              group by wave_id, author_id) d
       left join wave_dropper_metrics m
         on m.wave_id = d.wave_id and m.dropper_id = d.author_id
      where m.wave_id is null
         or m.drops_count <> d.chat
         or m.participatory_drops_count <> d.participatory
         or m.latest_drop_timestamp <> d.latest`,
    { waveIds }
  );
  expect(authorsOff).toEqual([]);
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

/**
 * The kinds of the subscriptions journal's entries in the record log's
 * public chain: in its closed segments (whose entries leave the entries
 * table once their head drop is posted), then its open entries.
 */
async function journalKinds(): Promise<string[]> {
  const segments = await sqlExecutor.execute<{ content: Buffer }>(
    `select content from signed_record_log_segments
      where chain = 'public' order by seq`
  );
  const open = await sqlExecutor.execute<{ entry: string }>(
    `select entry from signed_record_log_entries
      where chain = 'public' and segment_seq is null order by id`
  );
  return [
    ...segments.flatMap(
      (row) => parseSegmentFile(Buffer.from(row.content), []).entries
    ),
    ...open.map((row) => JSON.parse(row.entry))
  ]
    .map((entry) => journalBodyOf(entry))
    .filter((body) => body !== null)
    .map((body) => body!.kind);
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
    // The wide identity's top-up is queued whole: a real TOP_UP row, and no
    // legacy top-up row.
    const queuedTopUps = () =>
      sqlExecutor.execute<{
        consolidation_key: string;
        hash: string;
        replayed_at: unknown;
      }>(
        `select consolidation_key,
                json_unquote(json_extract(payload, '$.topUp.hash')) as hash,
                replayed_at
           from subscription_deferred_writes where kind = 'TOP_UP'`
      );
    const [queued] = await queuedTopUps();
    expect(queued).toEqual({
      consolidation_key: WIDE_KEY,
      hash: expect.any(String),
      replayed_at: null
    });
    expect(
      await sqlExecutor.execute(
        `select hash from subscriptions_top_up where from_wallet = :wallet`,
        { wallet: WIDE_TOP_UP.wallet }
      )
    ).toEqual([]);

    await seedSubscriptionsSwitch(
      contextOf('subs.switch', files, dir),
      env,
      deps
    );
    expect(await subscriptionsIdentitySwitch.writeModeOrFail()).toBe('TRUTH');
    // The cut credited it once to the wide identity's principal, and keyed
    // the identity by the queue entry's key; the entry stays pending.
    expect(
      await sqlExecutor.execute(
        `select hash, identity_key, amount from subscriptions_id_top_up
          where from_wallet = :wallet`,
        { wallet: WIDE_TOP_UP.wallet }
      )
    ).toEqual([
      {
        hash: queued.hash,
        identity_key: WIDE_PRINCIPAL,
        amount: Number(WIDE_TOP_UP.amount)
      }
    ]);
    expect(
      await sqlExecutor.execute(
        `select consolidation_key from subscriptions_id_key_map
          where identity_key = :principal`,
        { principal: WIDE_PRINCIPAL }
      )
    ).toEqual([{ consolidation_key: WIDE_KEY }]);
    expect(await queuedTopUps()).toEqual([queued]);
    // Every wide wallet is keyed to the wide identity, and the records
    // service's wallet keeps its own key.
    const keyOf = async (address: string) =>
      (
        await sqlExecutor.execute<{ consolidation_key: string }>(
          `select consolidation_key from address_consolidation_keys
            where address = :address`,
          { address }
        )
      ).map((row) => row.consolidation_key);
    for (const wallet of WIDE_WALLETS) {
      expect(await keyOf(wallet)).toEqual([WIDE_KEY]);
    }
    expect(await keyOf(env.SIGNED_RECORDS_SERVICE_WALLET as string)).toEqual([
      env.SIGNED_RECORDS_SERVICE_WALLET
    ]);
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
    // And the records wave's drop metrics, as drop creation leaves them.
    await expectDropMetricsOfDrops([env.SIGNED_RECORDS_WAVE_ID]);

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
    await expectDropMetricsOfDrops([env.SIGNED_RECORDS_WAVE_ID]);
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
    // Card 1's subscription phase is in the identity final rows the rebuild
    // must give back, from the journal's phase entry.
    expect(await journalKinds()).toContain('phase');
    expect(
      before.subscriptions_id_nfts_final.map(
        (row) => JSON.parse(row as string).phase
      )
    ).toEqual(['Phase 0']);
    // The probe wallets' and the wide identity's.
    expect(before.subscriptions_id_balances).toHaveLength(3);
    expect(before.subscriptions_id_top_up).toHaveLength(4);
    // The signed choice after the switch: its head, in the subscriptions'
    // family and type.
    expect(
      before.signed_record_heads.map((row) => {
        const { family, rtype } = JSON.parse(row as string);
        return [family, rtype];
      })
    ).toEqual([['ps', 'subs.all-editions']]);
    const legacyBefore = await snapshot(LEGACY_TABLES);
    // The wide identity's key is too long for the legacy columns: no row.
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

  it("pulls card 1's subscriptions into a phase on both sides, journaled, and the mint seed's later split leaves it alone", async () => {
    const env = subsManifest.flags;
    const deps = creditedTopUps();
    await seedProbeIdentities();
    await seedSubscriptions(contextOf('subs.seed', files, null), deps);
    await seedSubscriptionsSwitch(
      contextOf('subs.switch', files, dir),
      env,
      deps
    );
    const phases = (table: string) =>
      sqlExecutor.execute<{ phase: string | null }>(
        `select phase from ${table} where token_id = 1`
      );
    const expectPhase0 = async () => {
      expect(await phases('subscriptions_id_nfts_final')).toEqual([
        { phase: 'Phase 0' }
      ]);
      expect(await phases('subscriptions_nfts_final')).toEqual([
        { phase: 'Phase 0' }
      ]);
      // The final-phase route answers the first wallet under that phase.
      expect(
        await fetchFinalSubscriptionsByPhase(MEMES_CONTRACT, 1, 'Phase 0')
      ).toEqual([{ wallet: PROBE_CONSOLIDATION_KEYS[0], amount: 1 }]);
    };
    await expectPhase0();
    expect(await journalKinds()).toContain('phase');
    expect(await openLanes()).toEqual([]);

    // The mint seed's split of card 1, its wallets and spots as it runs it
    // (src/mint-log/mint-log-rebuild.seed.ts): the first wallet, card 1's
    // subscriber, whose row already has its phase, and the second, which
    // isn't on card 1's list. No phase is written and nothing is journaled.
    const phaseCount = (await journalKinds()).filter(
      (kind) => kind === 'phase'
    ).length;
    await splitAllowlistResults(MEMES_CONTRACT, 1, 'Phase 1', [
      {
        id: 'probe-1-1',
        wallet: PROBE_CONSOLIDATION_KEYS[0],
        phaseId: 'phase-1',
        allowlistId: 'allowlist-1',
        phaseComponentId: 'component-1',
        amount: 1
      },
      {
        id: 'probe-1-2',
        wallet: PROBE_CONSOLIDATION_KEYS[1],
        phaseId: 'phase-1',
        allowlistId: 'allowlist-1',
        phaseComponentId: 'component-1',
        amount: 3
      }
    ]);
    await expectPhase0();
    expect(
      (await journalKinds()).filter((kind) => kind === 'phase')
    ).toHaveLength(phaseCount);
    expect(await openLanes()).toEqual([]);
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
