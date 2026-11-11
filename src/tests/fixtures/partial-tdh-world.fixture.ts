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
  TDHEditions,
  TDHMemes,
  TokenTDH
} from '@/entities/ITDH';
import { insertWithoutUpdate } from '@/orm_helpers';
import { sqlExecutor } from '@/sql-executor';
import * as batches from '@/tdhLoop/tdh-persistence-batches';
import { snapshotRows } from '@/tdhLoop/tdh-row-diff';

/**
 * The world of the partial TDH write tests: groups, the rows the TDH loops
 * compute for them, seeding, one partial run, and what the tables hold.
 */

export const BLOCK = 500;
export const OLDER_BLOCK = 499;
export const DATE = new Date('2026-11-09T23:59:59Z');
/**
 * A partial run stamps each consolidated row with its own `new Date()`; these
 * cross second boundaries, with a .500 among them.
 */
export const RUN = Date.parse('2026-11-10T04:34:11.250Z');
/** The same partial run again, 10 minutes later. */
export const RUN_AGAIN = RUN + 10 * 60_000;
export const computedAt = (index: number, runAt = RUN) =>
  new Date(runAt + index * 125);
export const CONTRACT = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
export const SEASONS = [1, 2, 3];
export const TOKENS = [1, 2, 3, 4];

export type Holding = { tdh: number; balance: number };
/** One group (a wallet, or a consolidation key) and what it holds per token. */
export type Group = { key: string; holdings: Record<number, Holding> };

export const wallet = (i: number) => `0x${String(i).padStart(40, '0')}`;

/** `count` groups (12 by default), each holding two or three tokens. */
export function groupsBefore(count = 12): Group[] {
  return Array.from({ length: count }, (_, i) => ({
    key: wallet(i + 1),
    holdings: Object.fromEntries(
      TOKENS.filter((token) => (i + token) % 3 !== 0).map((token) => [
        token,
        // Fractional TDH, as computed; integer columns round it.
        {
          tdh: (count - i) * 100 + token * 7.25,
          balance: 1 + ((i + token) % 2)
        }
      ])
    )
  }));
}

export const groupTdh = (group: Group) =>
  Object.values(group.holdings).reduce((sum, holding) => sum + holding.tdh, 0);

/**
 * Rows of every group as the ranking computes them: overall rank by TDH, and
 * per-token ranks inside the JSON columns. `shuffleKeys` writes JSON objects
 * with their keys in another order (MySQL's JSON type reorders them anyway).
 */
export function rankedRows(groups: Group[], shuffleKeys = false) {
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

export function baseTdhFields(group: Group, rank: number) {
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

export function walletRows(groups: Group[], shuffleKeys = false): TDH[] {
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
export function consolidatedRows(
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
export function seasonRows(groups: Group[], tieForFirst = false) {
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

export function editionRows(groups: Group[]) {
  return groups.flatMap((group) =>
    Object.entries(group.holdings).map(([token, holding]) => ({
      key: group.key,
      contract: CONTRACT,
      id: Number(token),
      edition_id: 1,
      balance: holding.balance,
      days_held: Math.round(holding.tdh),
      hodl_rate: holding.tdh / 1000
    }))
  );
}

export function nftRows(groups: Group[]): NftTDH[] {
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
export function walletGroupsAfter(): Group[] {
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
export function consolidatedGroupsAfter(): Group[] {
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

/** The world before the partial write, as the nightly full rewrite leaves it. */
export async function seedWorld(before = groupsBefore()) {
  const manager = getDataSource().manager;
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
export async function partialRun(writeAllRows: boolean, runAt = RUN) {
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

export const TABLES: Record<string, string> = {
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
export async function countWrites(write: () => Promise<void>) {
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
export const NOTHING = Object.fromEntries(
  Object.keys(TABLES).map((table) => [table, 0])
);

/**
 * Every row of every table, as stored, and MySQL's table checksums. The
 * boosted TDH rate compares to 12 significant digits, and its table has no
 * checksum: MySQL sums a group's edition rates in its join order, which can
 * change between two runs of the same write (on either path).
 */
export async function dump() {
  const tables: Record<string, unknown[]> = {};
  for (const [table, order] of Object.entries(TABLES)) {
    const rows = await sqlExecutor.execute<Record<string, unknown>>(
      `select * from ${table} order by ${order}`
    );
    tables[table] =
      table === CONSOLIDATED_WALLETS_TDH_TABLE
        ? rows.map((row) => ({
            ...row,
            boosted_tdh_rate: Number(
              Number(row.boosted_tdh_rate).toPrecision(12)
            )
          }))
        : rows;
  }
  const checksums = await sqlExecutor.execute(
    `checksum table ${Object.keys(TABLES)
      .filter((table) => table !== CONSOLIDATED_WALLETS_TDH_TABLE)
      .join(', ')}`
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
