import {
  DataSource,
  InsertQueryBuilder,
  EntityManager,
  ObjectLiteral
} from 'typeorm';
import { PoolConnection } from 'mysql';
import { execSQLWithParams as executeNativeSql } from '@/db/my-sql.helpers';
import { execSQLWithParams as executeAppSql } from '@/db';
import { enqueueTransfersWithManager } from './transfer-reconciliation.db';
import { Transaction } from '@/entities/ITransaction';
import { TransferReconciliationDb } from './transfer-reconciliation.db';
import { SqlExecutor } from '@/sql-executor';
import { DbPoolName } from '@/db-query.options';

const execute = jest.fn().mockResolvedValue([]);
const db = new TransferReconciliationDb(
  () => ({ execute }) as unknown as SqlExecutor
);
const rows = ['0xalice', '0xbob'].map((wallet) => ({
  consumer: 'owners' as const,
  wallet,
  revision: 'consumed-revision',
  requested_at: 1
}));
beforeEach(() => execute.mockClear());
it('acknowledges a batch in one guarded primary delete', async () => {
  await db.acknowledge(rows);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledWith(
    expect.stringContaining(
      '(consumer, wallet, revision) IN ((:consumer0, :wallet0, :revision0), (:consumer1, :wallet1, :revision1))'
    ),
    {
      consumer0: 'owners',
      wallet0: '0xalice',
      revision0: 'consumed-revision',
      consumer1: 'owners',
      wallet1: '0xbob',
      revision1: 'consumed-revision'
    },
    { forcePool: DbPoolName.WRITE, wrappedConnection: undefined }
  );
});
it('does nothing for an empty acknowledgement batch', async () => {
  await db.acknowledge([]);
  expect(execute).not.toHaveBeenCalled();
});
it('uses database insertion order when selecting a bounded pending batch', async () => {
  await db.pending('owners');
  expect(execute).toHaveBeenCalledWith(
    expect.stringContaining('ORDER BY enqueue_order LIMIT :limit'),
    { consumer: 'owners', limit: 250 },
    expect.objectContaining({ forcePool: DbPoolName.WRITE })
  );
});

it.each(['native', 'app'] as const)(
  'renders complete row-value tuples through the actual SQL binder',
  async (mode) => {
    await db.acknowledge(rows);
    const [sql, params] = execute.mock.calls[0];
    let rendered = '';
    const config: {
      queryFormat?: (sql: string, values: Record<string, unknown>) => string;
    } = {};
    const connection = {
      config,
      query: (
        input: string | { sql: string; values: Record<string, unknown> },
        callback?: (error: null, rows: unknown[]) => void
      ) => {
        rendered =
          typeof input === 'string'
            ? input
            : config.queryFormat!(input.sql, input.values);
        if (callback) callback(null, []);
        else return Promise.resolve([]);
      }
    } as unknown as PoolConnection;
    if (mode === 'native')
      await executeNativeSql(sql, connection, false, params);
    else
      await executeAppSql(sql, params, { wrappedConnection: { connection } });
    expect(rendered).toContain(
      "IN (('owners', '0xalice', 'consumed-revision'), ('owners', '0xbob', 'consumed-revision'))"
    );
    expect(rendered).not.toMatch(/:[a-z]+[0-9]/);
  }
);

it('specifies the four insert columns when queue metadata is absent from a TypeORM producer', async () => {
  const source = new DataSource({ type: 'mysql', database: 'isolated-test' });
  let sql = '';
  const insert = jest
    .spyOn(InsertQueryBuilder.prototype, 'execute')
    .mockImplementationOnce(async function (
      this: InsertQueryBuilder<ObjectLiteral>
    ) {
      sql = this.getQuery();
      return { identifiers: [], generatedMaps: [], raw: [] };
    });
  try {
    await enqueueTransfersWithManager(source.manager as EntityManager, [
      { from_address: '0xalice', to_address: '0xbob' } as Transaction
    ]);
    expect(sql).toContain('(`consumer`, `wallet`, `revision`, `requested_at`)');
    expect(sql).not.toContain('`enqueue_order`');
  } finally {
    insert.mockRestore();
  }
});
