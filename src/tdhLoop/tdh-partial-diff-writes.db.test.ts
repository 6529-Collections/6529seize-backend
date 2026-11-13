import 'reflect-metadata';
import {
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  CONSOLIDATED_WALLETS_TDH_MEMES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE,
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

import {
  BLOCK,
  DATE,
  RUN_AGAIN,
  SEASONS,
  Group,
  wallet,
  groupsBefore,
  walletRows,
  consolidatedRows,
  seasonRows,
  editionRows,
  nftRows,
  walletGroupsAfter,
  consolidatedGroupsAfter,
  seedWorld,
  partialRun,
  countWrites,
  NOTHING,
  dump
} from '@/tests/fixtures/partial-tdh-world.fixture';

/**
 * A partial TDH write must leave every table exactly as the previous path
 * (delete the affected groups, then write every computed row) does, while
 * sending only the rows that change.
 */

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
