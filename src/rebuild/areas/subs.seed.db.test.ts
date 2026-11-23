import 'reflect-metadata';
import * as fs from 'node:fs';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { RebuildContext } from '@/rebuild/manifest.types';
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
import { persistTopUps } from '@/subscriptionsTopUpLoop/db.subscriptions_topup';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  SeedTopUp,
  seedSubscriptions,
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
  ['subscriptions_id_cursors', 'id, block']
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
  ['subscriptions_nfts_final', '*'],
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
 * made-up transaction hashes: the run makes them on anvil instead.
 */
function creditedTopUps(): SeedTopUp {
  let block = 1_000;
  return async (wallet, amountEth) => {
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
  };
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

  it('seeds a switched opening and rebuilds the identity tables from its files and journal alone, then the rollback copy from them', async () => {
    const env = subsManifest.flags;
    const deps = { topUp: creditedTopUps() };
    await seedProbeIdentities();
    await seedSubscriptions(contextOf('subs.seed', files, null), deps);
    await seedSubscriptionsSwitch(
      contextOf('subs.switch', files, dir),
      env,
      deps
    );
    expect(await subscriptionsIdentitySwitch.writeModeOrFail()).toBe('TRUTH');
    const before = await snapshot();
    expect(before.subscriptions_id_balances).toHaveLength(2);
    expect(before.subscriptions_id_top_up).toHaveLength(3);
    const legacyBefore = await snapshot(LEGACY_TABLES);
    expect(legacyBefore.subscriptions_balances).toHaveLength(2);

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
    const deps = { topUp: creditedTopUps() };
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

  it('fails a rebuild whose journal never reached a closed segment', async () => {
    const env = subsManifest.flags;
    await expect(
      rebuildSubscriptionsInCheck(contextOf('subs.identity', files, null), env)
    ).rejects.toThrow('never reached a closed segment');
  });
});
