import { DataSource, InsertQueryBuilder, ObjectLiteral } from 'typeorm';
import { ConsolidatedTDHEditions, NftTDH } from '@/entities/ITDH';
import {
  upsertTdhInBatches,
  TDH_SAVE_BATCH_SIZE
} from './tdh-persistence-batches';

describe('bounded TDH persistence', () => {
  const metadata = {
    primaryColumns: [{ propertyPath: 'wallet' }]
  };
  const rows = Array.from({ length: TDH_SAVE_BATCH_SIZE * 2 + 1 }, (_, i) => ({
    wallet: `wallet-${i}`,
    tdh_rank: i + 1,
    memes_ranks: [{ id: 1, rank: i + 1 }]
  }));

  it('persists the entire ranking universe without overlapping upserts', async () => {
    const persisted: typeof rows = [];
    let active = 0;
    let maxActive = 0;
    const upsert = jest.fn(async (batch: typeof rows) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      persisted.push(...batch);
      active--;
    });

    await upsertTdhInBatches({ upsert, metadata }, rows);

    expect(maxActive).toBe(1);
    expect(upsert.mock.calls.map(([batch]) => batch.length)).toEqual([
      500, 500, 1
    ]);
    expect(persisted).toEqual(rows);
    expect(persisted[persisted.length - 1]?.memes_ranks).toEqual([
      { id: 1, rank: rows.length }
    ]);
  });

  it('waits for a pending upsert before starting the next batch', async () => {
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const upsert = jest.fn().mockResolvedValue(undefined);
    upsert.mockImplementationOnce(() => first);

    const persistence = upsertTdhInBatches({ upsert, metadata }, rows);
    await Promise.resolve();
    expect(upsert).toHaveBeenCalledTimes(1);

    finishFirst();
    await persistence;
    expect(upsert).toHaveBeenCalledTimes(3);
  });

  it('propagates a later failure and never starts remaining batches', async () => {
    const failure = new Error('second batch failed');
    const upsert = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);

    await expect(upsertTdhInBatches({ upsert, metadata }, rows)).rejects.toBe(
      failure
    );

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1][0]).toEqual(rows.slice(500, 1000));
  });

  it('does not issue an upsert for an empty dataset', async () => {
    const upsert = jest.fn();

    await upsertTdhInBatches({ upsert, metadata }, []);

    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('TDH composite-key upsert SQL', () => {
  const dataSource = new DataSource({
    type: 'mysql',
    database: 'offline_tdh_sql_test',
    entities: [ConsolidatedTDHEditions, NftTDH]
  });

  beforeAll(async () => {
    // Exercise real MySQL metadata/SQL without opening a DB connection.
    await dataSource['buildMetadatas']();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

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
          return { identifiers: [], generatedMaps: [], raw: [] };
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
      const upsert = jest.spyOn(repository, 'upsert');

      await upsertTdhInBatches(repository, [row]);

      expect(upsert).toHaveBeenCalledWith(
        [row],
        entity === ConsolidatedTDHEditions
          ? ['contract', 'id', 'edition_id', 'consolidation_key']
          : ['id', 'contract', 'consolidation_key']
      );
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain('ON DUPLICATE KEY UPDATE');
      expect(queries[0]).toContain(
        entity === ConsolidatedTDHEditions
          ? '`days_held` = VALUES(`days_held`)'
          : '`tdh_rank` = VALUES(`tdh_rank`)'
      );
    }
  );
});
