import { DataSource, InsertQueryBuilder, ObjectLiteral } from 'typeorm';
import {
  ConsolidatedTDH,
  ConsolidatedTDHEditions,
  HistoricConsolidatedTDH,
  NftTDH
} from '@/entities/ITDH';
import { aTdhConsolidation } from '@/tests/fixtures/tdh_consolidation.fixture';
import {
  upsertTdhInBatches,
  TDH_SAVE_BATCH_SIZE
} from './tdh-persistence-batches';

const dataSource = new DataSource({
  type: 'mysql',
  database: 'offline_tdh_sql_test',
  entities: [
    ConsolidatedTDH,
    HistoricConsolidatedTDH,
    ConsolidatedTDHEditions,
    NftTDH
  ]
});
const insertResult = { identifiers: [], generatedMaps: [], raw: [] };

beforeAll(async () => {
  // Real metadata and query builders, without opening a database connection.
  await dataSource['buildMetadatas']();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('bounded TDH persistence', () => {
  const rows = Array.from({ length: TDH_SAVE_BATCH_SIZE * 2 + 1 }, (_, i) =>
    aTdhConsolidation([`wallet-${i}`], {
      tdh_rank: i + 1,
      memes_ranks: [{ id: 1, rank: i + 1 }]
    })
  );
  const repository = dataSource.getRepository(ConsolidatedTDH);

  it('persists the entire ranking universe without overlapping writes', async () => {
    const persisted: typeof rows = [];
    const sizes: number[] = [];
    let active = 0;
    let maxActive = 0;
    jest
      .spyOn(InsertQueryBuilder.prototype, 'execute')
      .mockImplementation(async function (
        this: InsertQueryBuilder<ObjectLiteral>
      ) {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        const batch = this.expressionMap.valuesSet as typeof rows;
        sizes.push(batch.length);
        persisted.push(...batch);
        active--;
        return insertResult;
      });

    await upsertTdhInBatches(repository, rows);

    expect(maxActive).toBe(1);
    expect(sizes).toEqual([500, 500, 1]);
    expect(persisted).toEqual(rows);
    expect(persisted[persisted.length - 1]?.memes_ranks).toEqual([
      { id: 1, rank: rows.length }
    ]);
  });

  it('waits for a pending write before starting the next batch', async () => {
    let finishFirst!: () => void;
    const first = new Promise<typeof insertResult>((resolve) => {
      finishFirst = () => resolve(insertResult);
    });
    const execute = jest
      .spyOn(InsertQueryBuilder.prototype, 'execute')
      .mockResolvedValue(insertResult)
      .mockImplementationOnce(() => first);

    const persistence = upsertTdhInBatches(repository, rows);
    await Promise.resolve();
    expect(execute).toHaveBeenCalledTimes(1);

    finishFirst();
    await persistence;
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('propagates a later failure and never starts remaining batches', async () => {
    const failure = new Error('second batch failed');
    const execute = jest
      .spyOn(InsertQueryBuilder.prototype, 'execute')
      .mockResolvedValueOnce(insertResult)
      .mockRejectedValueOnce(failure);

    await expect(upsertTdhInBatches(repository, rows)).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('does not issue a write for an empty dataset', async () => {
    const execute = jest.spyOn(InsertQueryBuilder.prototype, 'execute');

    await upsertTdhInBatches(repository, []);

    expect(execute).not.toHaveBeenCalled();
  });
});

describe('TDH composite-key upsert SQL', () => {
  it.each([ConsolidatedTDHEditions, NftTDH])(
    'uses database conflict matching for %p rather than loading bigint keys',
    async (entity) => {
      const queries: string[] = [];
      jest
        .spyOn(InsertQueryBuilder.prototype, 'execute')
        .mockImplementation(async function (
          this: InsertQueryBuilder<ObjectLiteral>
        ) {
          queries.push(this.getQuery());
          return insertResult;
        });
      const repository = dataSource.getRepository(entity);
      const primaryKey = {
        contract: '0x0000000000000000000000000000000000000001',
        id: 1,
        consolidation_key: 'unaffected'
      };
      const row =
        entity === ConsolidatedTDHEditions
          ? {
              ...primaryKey,
              edition_id: 1,
              balance: 1,
              days_held: 7,
              hodl_rate: 1
            }
          : {
              ...primaryKey,
              balance: 1,
              tdh: 1,
              boost: 1,
              boosted_tdh: 1,
              tdh__raw: 1,
              tdh_rank: 503
            };

      await upsertTdhInBatches(repository, [row]);

      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('ON DUPLICATE KEY UPDATE');
      expect(queries[0]).toContain(
        entity === ConsolidatedTDHEditions
          ? '`days_held` = VALUES(`days_held`)'
          : '`tdh_rank` = VALUES(`tdh_rank`)'
      );
      for (const column of repository.metadata.primaryColumns) {
        expect(queries[0]).toContain(
          `\`${column.databaseName}\` = VALUES(\`${column.databaseName}\`)`
        );
      }
    }
  );

  it('keeps keys paired with scores when the same rows are written to current and history', async () => {
    // Rank order differs from MySQL's primary-key order. The default-valued
    // boosted_tdh_rate column would cause TypeORM to reload and hydrate rows.
    const rows = [
      aTdhConsolidation(['z'], { block: 99, boosted_tdh: 123 }),
      aTdhConsolidation(['a'], { block: 99, boosted_tdh: 456 })
    ];
    for (const row of rows) {
      delete (row as Partial<ConsolidatedTDH>).boosted_tdh_rate;
    }
    const before = structuredClone(rows);
    const queryRunner = dataSource.createQueryRunner();
    const query = jest
      .spyOn(queryRunner, 'query')
      .mockImplementation(async (sql: string) => {
        if (sql.startsWith('INSERT')) {
          return { records: [], raw: { affectedRows: 2 }, affected: 2 };
        }
        // If hydration is accidentally re-enabled, exercise the actual ORM
        // returning-results path with a differently ordered default read.
        const alias = sql.includes('HistoricConsolidatedTDH')
          ? 'HistoricConsolidatedTDH'
          : 'ConsolidatedTDH';
        const records = ['a', 'z'].map((key) => ({
          [`${alias}_block`]: 99,
          [`${alias}_consolidation_key`]: key,
          [`${alias}_boosted_tdh_rate`]: 0
        }));
        return { records, raw: records, affected: 2 };
      });
    const manager = dataSource.createEntityManager(queryRunner);

    await upsertTdhInBatches(manager.getRepository(ConsolidatedTDH), rows);
    await upsertTdhInBatches(
      manager.getRepository(HistoricConsolidatedTDH),
      rows
    );

    expect(rows).toEqual(before);
    expect(query).toHaveBeenCalledTimes(2);
    for (const [sql, parameters] of query.mock.calls) {
      expect(sql).toMatch(/^INSERT/);
      expect(parameters).toEqual(expect.arrayContaining(['z', 123, 'a', 456]));
      expect(parameters!.indexOf('z')).toBeLessThan(parameters!.indexOf('a'));
    }
  });
});
