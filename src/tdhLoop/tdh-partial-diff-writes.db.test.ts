import 'reflect-metadata';
import {
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  CONSOLIDATED_WALLETS_TDH_MEMES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE,
  IDENTITY_TDH_SYNC_SCOPE_TABLE,
  TDH_EDITIONS_TABLE,
  TDH_NFT_TABLE,
  WALLETS_TDH_MEMES_TABLE,
  WALLETS_TDH_TABLE
} from '@/constants';
import {
  connect,
  disconnect,
  fetchTDHForBlock,
  getDataSource,
  persistConsolidatedTDH,
  persistTDH
} from '@/db';
import {
  ConsolidatedTDH,
  ConsolidatedTDHEditions,
  ConsolidatedTDHMemes,
  HistoricConsolidatedTDH,
  NftTDH,
  TDH,
  TDHBlock,
  TDHEditions,
  TDHMemes,
  TokenTDH
} from '@/entities/ITDH';
import { insertWithoutUpdate } from '@/orm_helpers';
import { setSqlExecutor, SqlExecutor, sqlExecutor } from '@/sql-executor';
import * as batches from '@/tdhLoop/tdh-persistence-batches';
import { snapshotRows } from '@/tdhLoop/tdh-row-diff';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';

/**
 * A partial TDH write must leave every table exactly as the previous path
 * (delete the affected groups, then write every computed row) does, while
 * sending only the rows that change.
 */

const BLOCK = 500;
const OLDER_BLOCK = 499;
const DATE = new Date('2026-11-09T23:59:59Z');
/**
 * A partial run stamps each consolidated row with its own `new Date()`; these
 * cross second boundaries, with a .500 among them.
 */
const RUN = Date.parse('2026-11-10T04:34:11.250Z');
/** The same partial run again, 10 minutes later. */
const RUN_AGAIN = RUN + 10 * 60_000;
const computedAt = (index: number, runAt = RUN) =>
  new Date(runAt + index * 125);
const CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const SEASONS = [1, 2, 3];
const TOKENS = [1, 2, 3, 4];

type Holding = { tdh: number; balance: number };
/** One group (a wallet, or a consolidation key) and what it holds per token. */
type Group = { key: string; holdings: Record<number, Holding> };

const wallet = (i: number) => `0x${String(i).padStart(40, '0')}`;

function groupsBefore(): Group[] {
  return Array.from({ length: 12 }, (_, i) => ({
    key: wallet(i + 1),
    holdings: Object.fromEntries(
      TOKENS.filter((token) => (i + token) % 3 !== 0).map((token) => [
        token,
        // Fractional TDH, as computed; integer columns round it.
        { tdh: (12 - i) * 100 + token * 7.25, balance: 1 + ((i + token) % 2) }
      ])
    )
  }));
}

const groupTdh = (group: Group) =>
  Object.values(group.holdings).reduce((sum, holding) => sum + holding.tdh, 0);

/**
 * Rows of every group as the ranking computes them: overall rank by TDH, and
 * per-token ranks inside the JSON columns. `shuffleKeys` writes JSON objects
 * with their keys in another order (MySQL's JSON type reorders them anyway).
 */
function rankedRows(groups: Group[], shuffleKeys = false) {
  const ordered = [...groups].sort(
    (a, b) => groupTdh(b) - groupTdh(a) || (a.key < b.key ? -1 : 1)
  );
  const tokenRanks = new Map<number, Map<string, number>>();
  for (const token of TOKENS) {
    const holders = groups
      .filter((group) => group.holdings[token])
      .sort(
        (a, b) =>
          b.holdings[token].tdh - a.holdings[token].tdh ||
          (a.key < b.key ? -1 : 1)
      );
    tokenRanks.set(
      token,
      new Map(holders.map((group, index) => [group.key, index + 1]))
    );
  }
  return ordered.map((group, index) => {
    const tokens = TOKENS.filter((token) => group.holdings[token]);
    const memes: TokenTDH[] = tokens.map((token) =>
      shuffleKeys
        ? ({
            tdh: group.holdings[token].tdh,
            balance: group.holdings[token].balance,
            id: token
          } as TokenTDH)
        : ({
            id: token,
            balance: group.holdings[token].balance,
            tdh: group.holdings[token].tdh
          } as TokenTDH)
    );
    const memesRanks = tokens.map((token) =>
      shuffleKeys
        ? { rank: tokenRanks.get(token)!.get(group.key)!, id: token }
        : { id: token, rank: tokenRanks.get(token)!.get(group.key)! }
    );
    return { group, rank: index + 1, memes, memesRanks, tokenRanks };
  });
}

function baseTdhFields(group: Group, rank: number) {
  const tdh = groupTdh(group);
  return {
    balance: Object.values(group.holdings).reduce((s, h) => s + h.balance, 0),
    unique_memes: Object.keys(group.holdings).length,
    memes_cards_sets: 0,
    tdh,
    boost: 1.1,
    boosted_tdh: tdh * 1.1,
    tdh__raw: tdh,
    tdh_rank: rank
  };
}

function walletRows(groups: Group[], shuffleKeys = false): TDH[] {
  return rankedRows(groups, shuffleKeys).map(
    ({ group, rank, memes, memesRanks }) =>
      ({
        ...baseTdhFields(group, rank),
        wallet: group.key,
        block: BLOCK,
        date: DATE,
        tdh_rank_memes: rank,
        tdh_rank_gradients: -1,
        tdh_rank_nextgen: -1,
        genesis: 0,
        nakamoto: 0,
        boosted_memes_tdh: groupTdh(group) * 1.1,
        memes_tdh: groupTdh(group),
        memes_tdh__raw: groupTdh(group),
        memes_balance: 1,
        memes,
        memes_ranks: memesRanks,
        gradients_balance: 0,
        boosted_gradients_tdh: 0,
        gradients_tdh: 0,
        gradients_tdh__raw: 0,
        gradients: [],
        gradients_ranks: [],
        nextgen_balance: 0,
        boosted_nextgen_tdh: 0,
        nextgen_tdh: 0,
        nextgen_tdh__raw: 0,
        nextgen: [],
        nextgen_ranks: [],
        boost_breakdown: shuffleKeys
          ? { total: 1.1, memes_card_sets: { available: 0, acquired: 0 } }
          : { memes_card_sets: { acquired: 0, available: 0 }, total: 1.1 }
      }) as TDH
  );
}

/**
 * Consolidated rows as the consolidation computes them: `boosted_tdh_rate` 0
 * (the write sets it), and, in a partial run (`computed`), a new `date`.
 */
function consolidatedRows(
  groups: Group[],
  { shuffleKeys = false, computed = false, runAt = RUN } = {}
) {
  return walletRows(groups, shuffleKeys).map(
    ({ wallet: key, ...row }, index) =>
      ({
        ...row,
        date: computed ? computedAt(index, runAt) : DATE,
        consolidation_key: key,
        consolidation_display: key,
        boosted_tdh_rate: 0,
        wallets: key.split('-')
      }) as ConsolidatedTDH
  );
}

/** Season rows: per-season TDH (fractional here) and per-season rank. */
function seasonRows(groups: Group[], tieForFirst = false) {
  return SEASONS.flatMap((season) =>
    [...groups]
      .sort((a, b) => groupTdh(b) - groupTdh(a) || (a.key < b.key ? -1 : 1))
      .map((group, index) => ({
        key: group.key,
        season,
        balance: season,
        unique_memes: 1,
        memes_cards_sets: 0,
        // A .5 tie is stored rounded half away from zero.
        tdh: tieForFirst && index === 0 ? 2.5 : groupTdh(group) / season,
        boost: 1.1,
        boosted_tdh: (groupTdh(group) / season) * 1.1,
        tdh__raw: groupTdh(group) / season,
        tdh_rank: index + 1
      }))
  );
}

function editionRows(groups: Group[]) {
  return groups.flatMap((group) =>
    Object.entries(group.holdings).map(([token, holding]) => ({
      key: group.key,
      contract: CONTRACT,
      id: Number(token),
      edition_id: 1,
      balance: holding.balance,
      days_held: Math.round(holding.tdh),
      // These fixture rates sum exactly regardless of MySQL's join order.
      hodl_rate: holding.tdh / 1024
    }))
  );
}

function nftRows(groups: Group[]): NftTDH[] {
  const { tokenRanks } = rankedRows(groups)[0];
  return groups.flatMap((group) =>
    Object.entries(group.holdings).map(([token, holding]) => ({
      id: Number(token),
      contract: CONTRACT,
      consolidation_key: group.key,
      balance: holding.balance,
      tdh: holding.tdh,
      boost: 1,
      boosted_tdh: holding.tdh * 1.1,
      tdh__raw: holding.tdh,
      tdh_rank: tokenRanks.get(Number(token))!.get(group.key)!
    }))
  );
}

/** The partial write's change: wallet 3 holds more, so ranks shift. */
function walletGroupsAfter(): Group[] {
  return groupsBefore().map((group) =>
    group.key === wallet(3)
      ? {
          key: group.key,
          holdings: { ...group.holdings, 1: { tdh: 5_000.75, balance: 3 } }
        }
      : group
  );
}

/** The consolidated change: groups 2 and 3 merge, and a new group appears. */
function consolidatedGroupsAfter(): Group[] {
  const before = groupsBefore();
  const merged: Group = {
    key: `${wallet(2)}-${wallet(3)}`,
    holdings: Object.fromEntries(
      TOKENS.map((token) => [
        token,
        {
          tdh:
            (before[1].holdings[token]?.tdh ?? 0) +
            (before[2].holdings[token]?.tdh ?? 0),
          balance:
            (before[1].holdings[token]?.balance ?? 0) +
            (before[2].holdings[token]?.balance ?? 0)
        }
      ]).filter(([, holding]) => (holding as Holding).tdh > 0)
    )
  };
  return [
    ...before.filter(
      (group) => group.key !== wallet(2) && group.key !== wallet(3)
    ),
    merged,
    { key: wallet(13), holdings: { 2: { tdh: 77.5, balance: 1 } } }
  ];
}

async function seedWorld() {
  const manager = getDataSource().manager;
  const before = groupsBefore();
  await insertWithoutUpdate(manager.getRepository(TDH), [
    ...walletRows(before),
    { ...walletRows(before)[0], block: OLDER_BLOCK }
  ]);
  await insertWithoutUpdate(
    manager.getRepository(TDHMemes),
    seasonRows(before, true).map(({ key, ...row }) => ({
      ...row,
      wallet: key
    }))
  );
  await insertWithoutUpdate(
    manager.getRepository(TDHEditions),
    editionRows(before).map(({ key, ...row }) => ({ ...row, wallet: key }))
  );
  // The consolidated level as the nightly full rewrite leaves it, its boosted
  // TDH rates set.
  await persistConsolidatedTDH(
    BLOCK,
    consolidatedRows(before),
    seasonRows(before).map(
      ({ key, ...row }) =>
        ({ ...row, consolidation_key: key }) as ConsolidatedTDHMemes
    ),
    editionRows(before).map(
      ({ key, ...row }) =>
        ({ ...row, consolidation_key: key }) as ConsolidatedTDHEditions
    ),
    nftRows(before),
    { mode: 'FULL' },
    DATE
  );
  await insertWithoutUpdate(manager.getRepository(HistoricConsolidatedTDH), [
    { ...consolidatedRows(before)[0], block: OLDER_BLOCK }
  ]);
}

/** One partial run, both levels, as the reconsolidation computes them. */
async function partialRun(writeAllRows: boolean, runAt = RUN) {
  const storedTdh = snapshotRows(
    getDataSource().getMetadata(TDH),
    await fetchTDHForBlock(BLOCK)
  );
  const walletsAfter = walletGroupsAfter();
  // Wallet 4 is affected too, with nothing to change.
  const affectedWallets = [wallet(3), wallet(4)];
  await persistTDH(
    BLOCK,
    walletRows(walletsAfter, true),
    seasonRows(walletsAfter, true).map(
      ({ key, ...row }) => ({ ...row, wallet: key }) as TDHMemes
    ),
    editionRows(walletsAfter).map(
      ({ key, ...row }) => ({ ...row, wallet: key }) as TDHEditions
    ),
    affectedWallets,
    { storedTdh, writeAllRows }
  );
  const groupsAfter = consolidatedGroupsAfter();
  await persistConsolidatedTDH(
    BLOCK,
    consolidatedRows(groupsAfter, { shuffleKeys: true, computed: true, runAt }),
    seasonRows(groupsAfter).map(
      ({ key, ...row }) =>
        ({ ...row, consolidation_key: key }) as ConsolidatedTDHMemes
    ),
    editionRows(groupsAfter).map(
      ({ key, ...row }) =>
        ({ ...row, consolidation_key: key }) as ConsolidatedTDHEditions
    ),
    nftRows(groupsAfter),
    {
      mode: 'PARTIAL',
      // Group 5 is replaced too, with nothing to change.
      wallets: [wallet(2), wallet(3), wallet(5), wallet(13)],
      consolidationKeysToReplace: [wallet(2), wallet(3), wallet(5)]
    },
    DATE,
    { writeAllRows }
  );
}

const TABLES: Record<string, string> = {
  [WALLETS_TDH_TABLE]: 'wallet, block',
  [WALLETS_TDH_MEMES_TABLE]: 'wallet, season',
  [TDH_EDITIONS_TABLE]: 'contract, id, edition_id, wallet',
  [CONSOLIDATED_WALLETS_TDH_TABLE]: 'block, consolidation_key',
  [CONSOLIDATED_WALLETS_TDH_MEMES_TABLE]: 'consolidation_key, season',
  [CONSOLIDATED_TDH_EDITIONS_TABLE]:
    'contract, id, edition_id, consolidation_key',
  [HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE]: 'block, consolidation_key',
  [TDH_NFT_TABLE]: 'id, contract, consolidation_key'
};

/**
 * Rows sent in full, rows of which only one column is refreshed, and rows
 * deleted by key (the reference path deletes by scope instead).
 */
async function countWrites(write: () => Promise<void>) {
  const written: Record<string, number> = {};
  const refreshed: Record<string, number> = {};
  const deleted: Record<string, number> = {};
  const count = (
    counts: Record<string, number>,
    table: string,
    rows: number
  ) => {
    counts[table] = (counts[table] ?? 0) + rows;
  };
  const upsert = batches.upsertTdhInBatches;
  const refresh = batches.refreshTdhColumnInBatches;
  const remove = batches.deleteTdhRowsInBatches;
  const upsertSpy = jest
    .spyOn(batches, 'upsertTdhInBatches')
    .mockImplementation(async (repository, rows) => {
      count(written, repository.metadata.tableName, rows.length);
      return upsert(repository, rows);
    });
  const refreshSpy = jest
    .spyOn(batches, 'refreshTdhColumnInBatches')
    .mockImplementation(async (repository, rows, column) => {
      count(refreshed, repository.metadata.tableName, rows.length);
      return refresh(repository, rows, column);
    });
  const deleteSpy = jest
    .spyOn(batches, 'deleteTdhRowsInBatches')
    .mockImplementation(async (repository, keys) => {
      count(deleted, repository.metadata.tableName, keys.length);
      return remove(repository, keys);
    });
  try {
    await write();
  } finally {
    upsertSpy.mockRestore();
    refreshSpy.mockRestore();
    deleteSpy.mockRestore();
  }
  return { written, refreshed, deleted };
}

/** No row of any table. */
const NOTHING = Object.fromEntries(
  Object.keys(TABLES).map((table) => [table, 0])
);

/** Every row of every table, as stored, and MySQL's table checksums. */
async function dump() {
  const tables: Record<string, unknown[]> = {};
  for (const [table, order] of Object.entries(TABLES)) {
    tables[table] = await sqlExecutor.execute<Record<string, unknown>>(
      `select * from ${table} order by ${order}`
    );
  }
  const checksums = await sqlExecutor.execute(
    `checksum table ${Object.keys(TABLES).join(', ')}`
  );
  return {
    tables,
    checksums,
    blocks: await sqlExecutor.execute(
      `select block_number, timestamp, merkle_root from tdh_blocks order by block_number`
    ),
    scope: await sqlExecutor.execute(
      `select generation, kind, value from ${IDENTITY_TDH_SYNC_SCOPE_TABLE} order by generation, kind, value`
    )
  };
}

describe('partial TDH writes send only the rows that change', () => {
  let appExecutor: SqlExecutor;

  beforeAll(async () => {
    await connect([
      TDH,
      TDHMemes,
      TDHEditions,
      ConsolidatedTDH,
      ConsolidatedTDHMemes,
      ConsolidatedTDHEditions,
      HistoricConsolidatedTDH,
      NftTDH,
      TDHBlock
    ]);
    // The app's executor: its transactions hand out TypeORM query runners.
    appExecutor = sqlExecutor;
  });

  afterAll(async () => {
    await disconnect();
  });

  beforeEach(async () => {
    // The shared per-test hook installs the test executor before each test.
    setSqlExecutor(appExecutor);
    await resetTestDatabase();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function runAndDump(writeAllRows: boolean) {
    await resetTestDatabase();
    await seedWorld();
    const counts = await countWrites(() => partialRun(writeAllRows));
    return { state: await dump(), ...counts };
  }

  it('leaves every table as writing every row does, byte for byte, sending only new and changed rows', async () => {
    const reference = await runAndDump(true);
    const changedOnly = await runAndDump(false);

    expect(changedOnly.state).toEqual(reference.state);
    // The fixture moves ranks for part of each table, not all of it.
    const wallets = walletGroupsAfter();
    const groups = consolidatedGroupsAfter();
    expect(reference.written).toEqual({
      [WALLETS_TDH_TABLE]: wallets.length,
      [WALLETS_TDH_MEMES_TABLE]: wallets.length * SEASONS.length,
      [TDH_EDITIONS_TABLE]: editionRows(wallets).length,
      [CONSOLIDATED_WALLETS_TDH_TABLE]: groups.length,
      [CONSOLIDATED_WALLETS_TDH_MEMES_TABLE]: groups.length * SEASONS.length,
      [CONSOLIDATED_TDH_EDITIONS_TABLE]: editionRows(groups).length,
      [HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE]: groups.length,
      [TDH_NFT_TABLE]: nftRows(groups).length
    });
    expect(reference.refreshed).toEqual({});
    for (const [table, rows] of Object.entries(changedOnly.written)) {
      expect(rows).toBeLessThan(reference.written[table]);
    }
    // Each consolidated row has a new computation time: the rows not sent in
    // full get that column alone.
    expect(changedOnly.refreshed).toEqual({
      [CONSOLIDATED_WALLETS_TDH_TABLE]:
        groups.length - changedOnly.written[CONSOLIDATED_WALLETS_TDH_TABLE],
      [HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE]:
        groups.length -
        changedOnly.written[HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE]
    });
    // Editions carry no ranks. Wallet 3 gains token 1; wallet 4, in scope
    // too, is unchanged.
    expect(changedOnly.written[TDH_EDITIONS_TABLE]).toBe(1);
    expect(changedOnly.deleted[TDH_EDITIONS_TABLE]).toBe(0);
    // Groups 2 and 3 are gone (merged), the merged group and group 13 are
    // new, and group 5, in scope too, is unchanged.
    const merged = `${wallet(2)}-${wallet(3)}`;
    expect(changedOnly.written[CONSOLIDATED_TDH_EDITIONS_TABLE]).toBe(
      editionRows(groups).filter((row) =>
        [merged, wallet(13)].includes(row.key)
      ).length
    );
    expect(changedOnly.deleted[CONSOLIDATED_TDH_EDITIONS_TABLE]).toBe(
      editionRows(groupsBefore()).filter((row) =>
        [wallet(2), wallet(3)].includes(row.key)
      ).length
    );
    // Group rows: groups 2 and 3 are gone, and group 5 moved up a rank, so
    // its stored row is deleted and written again.
    expect(changedOnly.deleted[CONSOLIDATED_WALLETS_TDH_TABLE]).toBe(3);
  });

  it('stores a half as MySQL rounds it into an integer column: away from zero', async () => {
    const manager = getDataSource().manager;
    const row = (seasonTdh: number, season: number) => ({
      wallet: wallet(1),
      season,
      balance: 1,
      unique_memes: 1,
      memes_cards_sets: 0,
      tdh: seasonTdh,
      boost: 1,
      boosted_tdh: seasonTdh,
      tdh__raw: seasonTdh,
      tdh_rank: 1
    });
    await insertWithoutUpdate(manager.getRepository(TDHMemes), [
      row(2.5, 1),
      row(-2.5, 2),
      row(1.4999999999999998, 3)
    ]);

    const stored = await sqlExecutor.execute<{ tdh: number }>(
      `select tdh from ${WALLETS_TDH_MEMES_TABLE} order by season`
    );
    expect(stored.map((it) => Number(it.tdh))).toEqual([3, -3, 1]);
  });

  it('stores the same bytes either way when MySQL rounds a JSON double', async () => {
    const precise = (row: TDH): TDH => ({
      ...row,
      memes: row.memes.map((meme, i) => ({
        ...meme,
        tdh: i === 0 ? 27.900000000000002 : 1234.5678901234567
      }))
    });
    async function run(writeAllRows: boolean) {
      await resetTestDatabase();
      const groups = groupsBefore();
      // The nightly rewrite wrote values that MySQL rounds when storing.
      await insertWithoutUpdate(
        getDataSource().manager.getRepository(TDH),
        walletRows(groups).map(precise)
      );
      // As updateTDH: the rows read back, rounded, written again for every
      // wallet but one.
      const snapshot = await fetchTDHForBlock(BLOCK);
      expect(snapshot[0].memes.map((meme: TokenTDH) => meme.tdh)).toEqual([
        27.9, 1234.567890123457, 1234.567890123457
      ]);
      await persistTDH(BLOCK, snapshot as TDH[], [], [], [wallet(5)], {
        storedTdh: snapshotRows(getDataSource().getMetadata(TDH), snapshot),
        writeAllRows
      });
      return {
        rows: await sqlExecutor.execute(
          `select * from ${WALLETS_TDH_TABLE} order by wallet, block`
        ),
        checksum: await sqlExecutor.execute(
          `checksum table ${WALLETS_TDH_TABLE}`
        )
      };
    }

    expect(await run(false)).toEqual(await run(true));
  });

  /**
   * Starts a write to an unchanged row of `table` on another connection once
   * the partial write has read that table, and returns the order in which
   * the partial write committed and the other write went through.
   */
  async function concurrentWriteOrder(
    table: string,
    otherWrite: string,
    partialWrite: () => Promise<void>
  ): Promise<string[]> {
    const events: string[] = [];
    let other: Promise<void> | undefined;
    const upsert = batches.upsertTdhInBatches;
    const spy = jest
      .spyOn(batches, 'upsertTdhInBatches')
      .mockImplementation(async (repository, rows) => {
        if (!other && repository.metadata.tableName === table) {
          const runner = getDataSource().createQueryRunner();
          other = runner
            .query(otherWrite)
            .then(() => {
              events.push('other write');
            })
            .finally(() => runner.release());
          await new Promise((resolve) => setTimeout(resolve, 500));
          events.push('partial write still open');
        }
        return upsert(repository, rows);
      });
    try {
      await partialWrite();
    } finally {
      spy.mockRestore();
    }
    events.push('partial write committed');
    await other;
    return events;
  }

  it('locks the rows it compares: a concurrent writer waits until the partial write commits', async () => {
    await seedWorld();
    const groups = groupsBefore();
    const order = [
      'partial write still open',
      'partial write committed',
      'other write'
    ];

    // Wallet level: wallet 9's memes rows are compared, not written. (Its
    // deletes, which scan the table, lock every row here already.)
    expect(
      await concurrentWriteOrder(
        WALLETS_TDH_MEMES_TABLE,
        `update ${WALLETS_TDH_MEMES_TABLE} set balance = balance + 1 where wallet = '${wallet(9)}'`,
        () =>
          persistTDH(
            BLOCK,
            walletRows(groups, true),
            seasonRows(groups, true).map(
              ({ key, ...row }) => ({ ...row, wallet: key }) as TDHMemes
            ),
            editionRows(groups).map(
              ({ key, ...row }) => ({ ...row, wallet: key }) as TDHEditions
            ),
            [wallet(5)],
            {
              storedTdh: snapshotRows(
                getDataSource().getMetadata(TDH),
                walletRows(groups)
              )
            }
          )
      )
    ).toEqual(order);

    // Consolidated level: group 9's memes rows are compared, not written;
    // only the locking read holds them.
    expect(
      await concurrentWriteOrder(
        CONSOLIDATED_WALLETS_TDH_MEMES_TABLE,
        `update ${CONSOLIDATED_WALLETS_TDH_MEMES_TABLE} set balance = balance + 1 where consolidation_key = '${wallet(9)}'`,
        () =>
          persistConsolidatedTDH(
            BLOCK,
            consolidatedRows(groups, { shuffleKeys: true, computed: true }),
            seasonRows(groups).map(
              ({ key, ...row }) =>
                ({ ...row, consolidation_key: key }) as ConsolidatedTDHMemes
            ),
            editionRows(groups).map(
              ({ key, ...row }) =>
                ({ ...row, consolidation_key: key }) as ConsolidatedTDHEditions
            ),
            nftRows(groups),
            {
              mode: 'PARTIAL',
              wallets: [wallet(5)],
              consolidationKeysToReplace: [wallet(5)]
            },
            DATE
          )
      )
    ).toEqual(order);
  });

  it('writes nothing outside the affected groups when the write changes no value', async () => {
    // As the first run of each pair in prod: one key replaced, nothing else
    // changed but each consolidated row's computation time.
    async function run(writeAllRows: boolean) {
      await resetTestDatabase();
      await seedWorld();
      const before = await dump();
      // A stale rate on an unchanged row: not compared, but still corrected.
      await sqlExecutor.execute(
        `update ${CONSOLIDATED_WALLETS_TDH_TABLE} set boosted_tdh_rate = 999 where consolidation_key = :key`,
        { key: wallet(7) }
      );
      expect(
        await sqlExecutor.execute(
          `select boosted_tdh_rate from ${CONSOLIDATED_WALLETS_TDH_TABLE} where consolidation_key = :key`,
          { key: wallet(7) }
        )
      ).toEqual([{ boosted_tdh_rate: 999 }]);
      const groups = groupsBefore();
      const storedTdh = snapshotRows(
        getDataSource().getMetadata(TDH),
        await fetchTDHForBlock(BLOCK)
      );
      const counts = await countWrites(async () => {
        await persistTDH(
          BLOCK,
          walletRows(groups, true),
          seasonRows(groups, true).map(
            ({ key, ...row }) => ({ ...row, wallet: key }) as TDHMemes
          ),
          editionRows(groups).map(
            ({ key, ...row }) => ({ ...row, wallet: key }) as TDHEditions
          ),
          [wallet(5)],
          { storedTdh, writeAllRows }
        );
        await persistConsolidatedTDH(
          BLOCK,
          consolidatedRows(groups, { shuffleKeys: true, computed: true }),
          seasonRows(groups).map(
            ({ key, ...row }) =>
              ({ ...row, consolidation_key: key }) as ConsolidatedTDHMemes
          ),
          editionRows(groups).map(
            ({ key, ...row }) =>
              ({ ...row, consolidation_key: key }) as ConsolidatedTDHEditions
          ),
          nftRows(groups),
          {
            mode: 'PARTIAL',
            wallets: [wallet(5)],
            consolidationKeysToReplace: [wallet(5)]
          },
          DATE,
          { writeAllRows }
        );
      });
      return { before, after: await dump(), ...counts };
    }

    const reference = await run(true);
    const changedOnly = await run(false);

    expect(changedOnly.after).toEqual(reference.after);
    // Wallet 5 and group 5, in scope, are unchanged too: nothing is sent but
    // each consolidated row's computation time.
    expect(changedOnly.written).toEqual(NOTHING);
    expect(changedOnly.deleted).toEqual(NOTHING);
    expect(changedOnly.refreshed).toEqual({
      [CONSOLIDATED_WALLETS_TDH_TABLE]: 12,
      [HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE]: 12
    });
    // Apart from the consolidated rows' computation time, nothing changed,
    // and the stale rate is back to the computed one.
    const stamped = [
      CONSOLIDATED_WALLETS_TDH_TABLE,
      HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE
    ];
    const withoutDates = (tables: Record<string, unknown[]>) =>
      Object.fromEntries(
        Object.entries(tables).map(([table, rows]) => [
          table,
          stamped.includes(table)
            ? rows.map((row) => ({ ...(row as object), date: undefined }))
            : rows
        ])
      );
    expect(withoutDates(changedOnly.after.tables)).toEqual(
      withoutDates(changedOnly.before.tables)
    );
    expect(
      changedOnly.after.tables[CONSOLIDATED_WALLETS_TDH_TABLE].map(
        (row) => (row as { date: Date }).date
      )
    ).not.toContainEqual(DATE);
  });

  it('sends nothing but the computation times when the same partial write runs again', async () => {
    async function twice(writeAllRows: boolean) {
      await resetTestDatabase();
      await seedWorld();
      await partialRun(writeAllRows);
      const again = await countWrites(() =>
        partialRun(writeAllRows, RUN_AGAIN)
      );
      return { state: await dump(), ...again };
    }

    const reference = await twice(true);
    const changedOnly = await twice(false);

    expect(changedOnly.state).toEqual(reference.state);
    expect(changedOnly.written).toEqual(NOTHING);
    expect(changedOnly.deleted).toEqual(NOTHING);
    const groups = consolidatedGroupsAfter().length;
    expect(changedOnly.refreshed).toEqual({
      [CONSOLIDATED_WALLETS_TDH_TABLE]: groups,
      [HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE]: groups
    });
  });

  it('compares the affected wallets with their TDH rows as stored at the write, not as the snapshot saw them', async () => {
    async function run(writeAllRows: boolean) {
      await resetTestDatabase();
      await seedWorld();
      const groups = groupsBefore();
      const storedTdh = snapshotRows(
        getDataSource().getMetadata(TDH),
        await fetchTDHForBlock(BLOCK)
      );
      // A same-block rerun rewrites wallet 5's row after the snapshot.
      await sqlExecutor.execute(
        `update ${WALLETS_TDH_TABLE} set tdh = tdh + 1 where wallet = :wallet and block = :block`,
        { wallet: wallet(5), block: BLOCK }
      );
      await persistTDH(
        BLOCK,
        walletRows(groups, true),
        seasonRows(groups, true).map(
          ({ key, ...row }) => ({ ...row, wallet: key }) as TDHMemes
        ),
        editionRows(groups).map(
          ({ key, ...row }) => ({ ...row, wallet: key }) as TDHEditions
        ),
        [wallet(5)],
        { storedTdh, writeAllRows }
      );
      return sqlExecutor.execute(
        `select * from ${WALLETS_TDH_TABLE} order by wallet, block`
      );
    }

    expect(await run(false)).toEqual(await run(true));
  });
});
