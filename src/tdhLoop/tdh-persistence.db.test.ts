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
  NftTDH
} from '@/entities/ITDH';
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
import * as waveUnreadCache from '@/api/waves/wave-unread-cache';
import * as mysql from 'mysql';
import { DataSource, QueryRunner } from 'typeorm';

const BLOCK = 99;
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
    }
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
      NftTDH
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
    jest
      .spyOn(
        identityConsolidationEffects,
        'syncIdentitiesWithTdhConsolidations'
      )
      .mockResolvedValue({ waveIds: [], readerWaves: [] });
    jest
      .spyOn(identityConsolidationEffects, 'syncIdentitiesMetrics')
      .mockResolvedValue();
    jest
      .spyOn(waveUnreadCache, 'invalidateWaveUnreadCache')
      .mockResolvedValue();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('rolls back every TDH store when the unified transaction fails', async () => {
    jest
      .mocked(identityConsolidationEffects.syncIdentitiesMetrics)
      .mockRejectedValueOnce(new Error('injected transaction failure'));

    await expect(persistReplacement([A_C, B])).rejects.toThrow(
      'injected transaction failure'
    );

    await expectPersistedKeys([A_C, B]);
    const [{ total }] = await sqlExecutor.execute<{ total: string | number }>(
      `SELECT SUM(boosted_tdh) AS total FROM ${TDH_NFT_TABLE}`
    );
    expect(Number(total)).toBe(50);
  });

  it('is idempotent when retrying after commit but before checkpoint completion', async () => {
    jest
      .mocked(waveUnreadCache.invalidateWaveUnreadCache)
      .mockRejectedValueOnce(new Error('injected post-commit failure'))
      .mockResolvedValueOnce();

    await expect(persistReplacement([A_C, B])).rejects.toThrow(
      'injected post-commit failure'
    );
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
  });

  it('preserves key-score associations in history when input rank order differs from primary-key order', async () => {
    const rows = [consolidatedRow(['z'], 123), consolidatedRow(['a'], 456)];
    for (const row of rows) {
      delete (row as Partial<ConsolidatedTDH>).boosted_tdh_rate;
    }
    const before = structuredClone(rows);

    await persistConsolidatedTDH(BLOCK, rows, [], [], [], {
      mode: 'PARTIAL',
      wallets: ['a', 'b', 'c', 'z'],
      consolidationKeysToReplace: [A_C, B]
    });

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
      }
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
        }
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
