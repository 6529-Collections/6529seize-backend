import {
  CONSOLIDATED_TDH_EDITIONS_TABLE,
  CONSOLIDATED_WALLETS_TDH_MEMES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE,
  TDH_NFT_TABLE
} from '@/constants';
import { persistConsolidatedTDH } from '@/db';
import {
  ConsolidatedTDH,
  ConsolidatedTDHEditions,
  ConsolidatedTDHMemes,
  HistoricConsolidatedTDH,
  NftTDH,
  TDHBlock
} from '@/entities/ITDH';
import { computeMerkleRoot } from './tdh_merkle';
import { identityConsolidationEffects } from '@/identity';
import {
  ConnectionWrapper,
  setSqlExecutor,
  SqlExecutor,
  sqlExecutor
} from '@/sql-executor';
import { describeWithSeed, Seed } from '@/tests/_setup/seed';
import { aTdhConsolidation } from '@/tests/fixtures/tdh_consolidation.fixture';
import { DbQueryOptions } from '@/db-query.options';
import { insertWithoutUpdate } from '@/orm_helpers';
import { TDH_SAVE_BATCH_SIZE } from './tdh-persistence-batches';
import { identityTdhSyncStateDb } from '@/identity-tdh-sync-state.db';
import * as mysql from 'mysql';
import { DataSource, QueryRunner } from 'typeorm';

const BLOCK = 99;
const BLOCK_TIMESTAMP = new Date('2026-11-09T00:00:00Z');
const A_C = 'a-c';
const B = 'b';
const A_B = 'a-b';
const C = 'c';
const CONTRACT = '0x0000000000000000000000000000000000000001';

function prepareStatement(
  sql: string,
  params?: Record<string, unknown>
): string {
  return sql.replace(/:(\w+)/g, (placeholder, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      return placeholder;
    }
    const value = params![key];
    return Array.isArray(value)
      ? value.map((item) => mysql.escape(item)).join(', ')
      : mysql.escape(value);
  });
}

class TypeOrmTestSqlExecutor extends SqlExecutor {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async execute<T>(
    sql: string,
    params?: Record<string, unknown>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    const statement = prepareStatement(sql, params);
    const queryRunner = options?.wrappedConnection?.connection as
      | QueryRunner
      | undefined;
    const result = queryRunner
      ? await queryRunner.query(statement)
      : await this.dataSource.query(statement);
    return Object.values(JSON.parse(JSON.stringify(result))) as T[];
  }

  async executeNativeQueriesInTransaction<T>(
    executable: (connectionHolder: ConnectionWrapper<QueryRunner>) => Promise<T>
  ): Promise<T> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const result = await executable({ connection: queryRunner });
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}

function consolidatedRow(
  wallets: string[],
  boostedTdh: number
): ConsolidatedTDH {
  return aTdhConsolidation(wallets, {
    block: BLOCK,
    tdh: boostedTdh,
    tdh__raw: boostedTdh,
    boosted_tdh: boostedTdh,
    boost: 1
  });
}

function memesRow(
  consolidationKey: string,
  boostedTdh: number
): ConsolidatedTDHMemes {
  return {
    consolidation_key: consolidationKey,
    season: 1,
    balance: 1,
    unique_memes: 1,
    memes_cards_sets: 0,
    tdh: boostedTdh,
    boost: 1,
    boosted_tdh: boostedTdh,
    tdh__raw: boostedTdh,
    tdh_rank: 1
  };
}

function editionRow(consolidationKey: string): ConsolidatedTDHEditions {
  return {
    consolidation_key: consolidationKey,
    contract: CONTRACT,
    id: 1,
    edition_id: 1,
    balance: 1,
    days_held: 1,
    hodl_rate: 1
  };
}

function nftRow(consolidationKey: string, boostedTdh: number): NftTDH {
  return {
    consolidation_key: consolidationKey,
    contract: CONTRACT,
    id: 1,
    balance: 1,
    tdh: boostedTdh,
    boost: 1,
    boosted_tdh: boostedTdh,
    tdh__raw: boostedTdh,
    tdh_rank: 1
  };
}

const oldConsolidated = [
  consolidatedRow(['a', 'c'], 30),
  consolidatedRow(['b'], 20)
];
const oldMemes = [memesRow(A_C, 30), memesRow(B, 20)];
const oldEditions = [editionRow(A_C), editionRow(B)];
const oldNft = [nftRow(A_C, 30), nftRow(B, 20)];

const newConsolidated = [
  consolidatedRow(['a', 'b'], 50),
  consolidatedRow(['c'], 10)
];
const newMemes = [memesRow(A_B, 50), memesRow(C, 10)];
const newEditions = [editionRow(A_B), editionRow(C)];
const newNft = [nftRow(A_B, 50), nftRow(C, 10)];

const seeds: Seed[] = [
  { table: CONSOLIDATED_WALLETS_TDH_TABLE, rows: oldConsolidated },
  {
    table: HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE,
    rows: oldConsolidated
  },
  { table: CONSOLIDATED_WALLETS_TDH_MEMES_TABLE, rows: oldMemes },
  { table: CONSOLIDATED_TDH_EDITIONS_TABLE, rows: oldEditions },
  { table: TDH_NFT_TABLE, rows: oldNft }
];

async function fetchKeys(table: string): Promise<string[]> {
  const rows = await sqlExecutor.execute<{ consolidation_key: string }>(
    `SELECT DISTINCT consolidation_key FROM ${table} ORDER BY consolidation_key`
  );
  return rows.map((row) => row.consolidation_key);
}

async function expectPersistedKeys(expectedKeys: string[]) {
  await expect(fetchKeys(CONSOLIDATED_WALLETS_TDH_TABLE)).resolves.toEqual(
    expectedKeys
  );
  await expect(
    fetchKeys(HISTORIC_CONSOLIDATED_WALLETS_TDH_TABLE)
  ).resolves.toEqual(expectedKeys);
  await expect(
    fetchKeys(CONSOLIDATED_WALLETS_TDH_MEMES_TABLE)
  ).resolves.toEqual(expectedKeys);
  await expect(fetchKeys(CONSOLIDATED_TDH_EDITIONS_TABLE)).resolves.toEqual(
    expectedKeys
  );
  await expect(fetchKeys(TDH_NFT_TABLE)).resolves.toEqual(expectedKeys);
}

async function persistReplacement(replacementKeys: string[]) {
  return persistConsolidatedTDH(
    BLOCK,
    newConsolidated,
    newMemes,
    newEditions,
    newNft,
    {
      mode: 'PARTIAL',
      wallets: ['a', 'b', 'c'],
      consolidationKeysToReplace: replacementKeys
    },
    BLOCK_TIMESTAMP
  );
}

describeWithSeed('atomic TDH consolidation persistence', seeds, () => {
  const dataSource = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    entities: [
      ConsolidatedTDH,
      HistoricConsolidatedTDH,
      ConsolidatedTDHMemes,
      ConsolidatedTDHEditions,
      NftTDH,
      TDHBlock
    ],
    synchronize: false,
    logging: false,
    charset: 'utf8mb4',
    timezone: 'Etc/UTC'
  });

  beforeAll(async () => {
    await dataSource.initialize();
  });

  beforeEach(() => {
    setSqlExecutor(new TypeOrmTestSqlExecutor(dataSource));
    jest.spyOn(
      identityConsolidationEffects,
      'syncIdentitiesWithTdhConsolidations'
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('rolls back every TDH store and the marker when the TDH transaction fails', async () => {
    jest
      .spyOn(identityTdhSyncStateDb, 'markPending')
      .mockRejectedValueOnce(new Error('injected transaction failure'));

    await expect(persistReplacement([A_C, B])).rejects.toThrow(
      'injected transaction failure'
    );

    await expectPersistedKeys([A_C, B]);
    const [{ total }] = await sqlExecutor.execute<{ total: string | number }>(
      `SELECT SUM(boosted_tdh) AS total FROM ${TDH_NFT_TABLE}`
    );
    expect(Number(total)).toBe(50);
    expect(await identityTdhSyncStateDb.readProgress()).toEqual({
      pendingGeneration: 0,
      pendingBlock: 0,
      syncedGeneration: 0
    });
    // The block row rolls back with the TDH rows.
    await expect(
      dataSource.getRepository(TDHBlock).findOneBy({ block_number: BLOCK })
    ).resolves.toBeNull();
  });

  it('leaves tdh_blocks matching the TDH rows when the run is killed right after the TDH commit', async () => {
    // A run killed after step A, mid identities sync: nothing after A ran.
    await persistReplacement([A_C, B]);

    await expectPersistedKeys([A_B, C]);
    const [latest] = await sqlExecutor.execute<{ block_number: number }>(
      `SELECT MAX(block_number) AS block_number FROM tdh_blocks`
    );
    expect(Number(latest.block_number)).toBe(BLOCK);
    const blockRow = await dataSource
      .getRepository(TDHBlock)
      .findOneByOrFail({ block_number: BLOCK });
    // The merkle root is the committed rows' root, not an earlier state's.
    expect(blockRow.merkle_root).toBe(
      await computeMerkleRoot(BLOCK, dataSource.manager)
    );
    expect(new Date(blockRow.timestamp).toISOString()).toBe(
      BLOCK_TIMESTAMP.toISOString()
    );
    // The identities sync is left pending for the next loop start.
    const progress = await identityTdhSyncStateDb.readProgress();
    expect(progress.pendingGeneration).toBeGreaterThan(
      progress.syncedGeneration
    );
  });

  it('commits the TDH tables with a pending identities sync marker, without syncing identities', async () => {
    await persistReplacement([A_C, B]);

    // Visible from another connection: the transaction has committed.
    await expectPersistedKeys([A_B, C]);
    expect(await identityTdhSyncStateDb.readProgress()).toEqual({
      pendingGeneration: 1,
      pendingBlock: BLOCK,
      syncedGeneration: 0
    });
    expect(
      identityConsolidationEffects.syncIdentitiesWithTdhConsolidations
    ).not.toHaveBeenCalled();
  });

  it('is idempotent when retried after the TDH commit', async () => {
    await persistReplacement([A_C, B]);
    await expectPersistedKeys([A_B, C]);

    await persistReplacement([A_B, C]);

    await expectPersistedKeys([A_B, C]);
    const [{ total, row_count }] = await sqlExecutor.execute<{
      total: string | number;
      row_count: string | number;
    }>(
      `SELECT SUM(boosted_tdh) AS total, COUNT(*) AS row_count FROM ${TDH_NFT_TABLE}`
    );
    expect(Number(total)).toBe(60);
    expect(Number(row_count)).toBe(2);
    // Each committed write leaves its own pending generation.
    expect(
      (await identityTdhSyncStateDb.readProgress()).pendingGeneration
    ).toBe(2);
  });

  it('preserves key-score associations in history when input rank order differs from primary-key order', async () => {
    const rows = [consolidatedRow(['z'], 123), consolidatedRow(['a'], 456)];
    for (const row of rows) {
      delete (row as Partial<ConsolidatedTDH>).boosted_tdh_rate;
    }
    const before = structuredClone(rows);

    await persistConsolidatedTDH(
      BLOCK,
      rows,
      [],
      [],
      [],
      {
        mode: 'PARTIAL',
        wallets: ['a', 'b', 'c', 'z'],
        consolidationKeysToReplace: [A_C, B]
      },
      BLOCK_TIMESTAMP
    );

    expect(rows).toEqual(before);
    for (const entity of [ConsolidatedTDH, HistoricConsolidatedTDH]) {
      for (const expected of before) {
        const stored = await dataSource.getRepository(entity).findOneByOrFail({
          block: BLOCK,
          consolidation_key: expected.consolidation_key
        });
        expect(stored).toEqual(
          expect.objectContaining({
            block: BLOCK,
            consolidation_key: expected.consolidation_key,
            tdh: expected.tdh,
            tdh__raw: expected.tdh__raw,
            boosted_tdh: expected.boosted_tdh,
            tdh_rank: expected.tdh_rank
          })
        );
      }
    }
  });

  async function seedUnaffectedGroups() {
    const rows = Array.from({ length: TDH_SAVE_BATCH_SIZE + 1 }, (_, i) =>
      consolidatedRow([`unaffected${i}`], 1)
    );
    await insertWithoutUpdate(dataSource.getRepository(ConsolidatedTDH), rows);
    await insertWithoutUpdate(
      dataSource.getRepository(HistoricConsolidatedTDH),
      rows
    );
    await insertWithoutUpdate(
      dataSource.getRepository(ConsolidatedTDHMemes),
      rows.map((row) => memesRow(row.consolidation_key, 1))
    );
    await insertWithoutUpdate(
      dataSource.getRepository(ConsolidatedTDHEditions),
      rows.map((row) => editionRow(row.consolidation_key))
    );
    await insertWithoutUpdate(
      dataSource.getRepository(NftTDH),
      rows.map((row) => nftRow(row.consolidation_key, 1))
    );
    return rows;
  }

  it('preserves unaffected scores and persists global ranks beyond an upsert batch', async () => {
    const unaffected = await seedUnaffectedGroups();
    const ranked = unaffected.map((row, i) => ({ ...row, tdh_rank: i + 3 }));
    await persistConsolidatedTDH(
      BLOCK,
      [...newConsolidated, ...ranked],
      [
        ...newMemes,
        ...ranked.map((row) => ({
          ...memesRow(row.consolidation_key, 1),
          tdh_rank: row.tdh_rank
        }))
      ],
      [
        ...newEditions,
        ...ranked.map((row) => ({
          ...editionRow(row.consolidation_key),
          days_held: 7
        }))
      ],
      [
        ...newNft,
        ...ranked.map((row) => ({
          ...nftRow(row.consolidation_key, 1),
          tdh_rank: row.tdh_rank
        }))
      ],
      {
        mode: 'PARTIAL',
        wallets: ['a', 'b', 'c'],
        consolidationKeysToReplace: [A_C, B]
      },
      BLOCK_TIMESTAMP
    );

    await expectPersistedKeys(
      [A_B, C, ...ranked.map((row) => row.consolidation_key)].sort((a, b) =>
        a.localeCompare(b)
      )
    );
    const last = ranked[ranked.length - 1];
    for (const entity of [
      ConsolidatedTDH,
      HistoricConsolidatedTDH,
      ConsolidatedTDHMemes,
      NftTDH
    ]) {
      const row = await dataSource.getRepository(entity).findOneByOrFail({
        consolidation_key: last.consolidation_key
      });
      expect(row.boosted_tdh).toBe(1);
      expect(row.tdh_rank).toBe(last.tdh_rank);
    }
    const edition = await dataSource
      .getRepository(ConsolidatedTDHEditions)
      .findOneByOrFail({ consolidation_key: last.consolidation_key });
    expect(edition.days_held).toBe(7);
  });

  it('rolls back earlier batches and scoped deletes when a later batch fails', async () => {
    const unaffected = await seedUnaffectedGroups();
    const ranked = unaffected.map((row, i) => ({ ...row, tdh_rank: i + 3 }));
    // A non-nullable field fails in the second upsert call, after the first
    // batch has inserted replacements and updated unaffected rank rows.
    ranked[ranked.length - 1].block = null as unknown as number;

    await expect(
      persistConsolidatedTDH(
        BLOCK,
        [...newConsolidated, ...ranked],
        newMemes,
        newEditions,
        newNft,
        {
          mode: 'PARTIAL',
          wallets: ['a', 'b', 'c'],
          consolidationKeysToReplace: [A_C, B]
        },
        BLOCK_TIMESTAMP
      )
    ).rejects.toThrow();

    await expectPersistedKeys(
      [A_C, B, ...unaffected.map((row) => row.consolidation_key)].sort((a, b) =>
        a.localeCompare(b)
      )
    );
    const first = await dataSource
      .getRepository(ConsolidatedTDH)
      .findOneByOrFail({
        consolidation_key: unaffected[0].consolidation_key
      });
    expect(first.tdh_rank).toBe(unaffected[0].tdh_rank);
    expect(first.boosted_tdh).toBe(1);
  });
});
