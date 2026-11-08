import * as mysql from 'mysql';
import { randomUUID } from 'node:crypto';
import { IdentityMetricsSync } from '@/identity-metrics-sync';
import { ConnectionWrapper, SqlExecutor } from '@/sql-executor';

/** How the driver inlines named parameters (see my-sql.helpers). */
function inline(sql: string, params: Record<string, unknown> = {}): string {
  return sql.replace(/:(\w+)/g, (placeholder, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return placeholder;
    const value = params[key];
    return Array.isArray(value)
      ? value.map((item) => mysql.escape(item)).join(', ')
      : mysql.escape(value);
  });
}

type Row = { consolidation_key: string; profile_id: string | null };

const isUpdate = (statement: string) =>
  /^\s*update identities/i.test(statement);
const isVerify = (statement: string) =>
  /select consolidation_key, profile_id[\s\S]*for share/i.test(statement);

const lockError = (code: string) => Object.assign(new Error(code), { code });

/** Answers the chunk statements from an in-memory identities list. */
class FakeExecutor extends SqlExecutor {
  public readonly statements: string[] = [];
  /** Thrown, in order, by the next UPDATE statements. */
  public readonly updateFailures: Error[] = [];
  /** Extra rows the next verification reads return, once each. */
  public readonly verifyExtras: Row[] = [];

  constructor(private readonly identities: Row[]) {
    super();
  }

  async execute<T>(sql: string, params?: Record<string, any>): Promise<T[]> {
    const statement = inline(sql, params);
    this.statements.push(statement);
    if (isUpdate(statement) && this.updateFailures.length) {
      throw this.updateFailures.shift();
    }
    const after = String(params?.after ?? '');
    if (/\blimit\b/i.test(statement)) {
      return this.identities
        .filter((row) => row.consolidation_key > after)
        .slice(0, Number(params?.limit)) as T[];
    }
    if (isVerify(statement)) {
      const last = String(params?.last);
      const rows = this.identities.filter(
        (row) => row.consolidation_key > after && row.consolidation_key <= last
      );
      const extra = this.verifyExtras.shift();
      return (extra ? [...rows, extra] : rows) as T[];
    }
    return [] as T[];
  }

  async executeNativeQueriesInTransaction<T>(
    executable: (connectionHolder: ConnectionWrapper<any>) => Promise<T>
  ): Promise<T> {
    return executable({ connection: {} });
  }
}

const identities = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    consolidation_key: `0x${String(i).padStart(40, '0')}`,
    profile_id: i % 50 === 7 ? null : randomUUID()
  }));

describe('IdentityMetricsSync chunks', () => {
  it('keeps every statement under the 16 KB RDS Proxy pin threshold and covers every row once', async () => {
    const rows = identities(2_500);
    const db = new FakeExecutor(rows);

    const result = await new IdentityMetricsSync(() => db).syncAll();

    expect(result.rows).toBe(rows.length);
    expect(result.retries).toBe(0);
    for (const statement of db.statements) {
      expect(Buffer.byteLength(statement, 'utf8')).toBeLessThan(16_000);
    }
    // About 300 UUIDs fit the inlined list budget.
    expect(result.chunks).toBeGreaterThanOrEqual(8);
    expect(result.chunks).toBeLessThanOrEqual(10);
  });

  it('locks the TDH rows, then the ratings, then updates identities, then re-reads them', async () => {
    const db = new FakeExecutor(identities(5));

    await new IdentityMetricsSync(() => db).syncAll({ chunkRows: 10 });

    const kinds = db.statements.slice(0, 5).map((statement) => {
      if (/\blimit\b/i.test(statement)) return 'read';
      if (isUpdate(statement)) return 'update';
      if (isVerify(statement)) return 'verify';
      if (/from tdh_consolidation[\s\S]*for share/i.test(statement))
        return 'lock tdh';
      if (/from ratings[\s\S]*for share/i.test(statement))
        return 'lock ratings';
      return statement;
    });
    expect(kinds).toEqual([
      'read',
      'lock tdh',
      'lock ratings',
      'update',
      'verify'
    ]);
  });

  it('redoes a chunk after a deadlock, a lock wait timeout or a changed row set', async () => {
    const rows = identities(4);
    const db = new FakeExecutor(rows);
    db.updateFailures.push(
      lockError('ER_LOCK_DEADLOCK'),
      lockError('ER_LOCK_WAIT_TIMEOUT')
    );
    db.verifyExtras.push({ consolidation_key: '0xnew', profile_id: 'p' });

    const result = await new IdentityMetricsSync(() => db).syncAll({
      chunkRows: 10
    });

    expect(result.retries).toBe(3);
    expect(result.rows).toBe(rows.length);
    expect(db.statements.filter(isUpdate)).toHaveLength(4);
  });

  it('gives up on a chunk after five attempts', async () => {
    const db = new FakeExecutor(identities(2));
    db.updateFailures.push(
      ...Array.from({ length: 5 }, () => lockError('ER_LOCK_DEADLOCK'))
    );

    await expect(
      new IdentityMetricsSync(() => db).syncAll({ chunkRows: 10 })
    ).rejects.toMatchObject({ code: 'ER_LOCK_DEADLOCK' });
    expect(db.statements.filter(isUpdate)).toHaveLength(5);
  });

  it('does not retry other errors', async () => {
    const db = new FakeExecutor(identities(2));
    db.updateFailures.push(lockError('ER_BAD_FIELD_ERROR'));

    await expect(
      new IdentityMetricsSync(() => db).syncAll({ chunkRows: 10 })
    ).rejects.toMatchObject({ code: 'ER_BAD_FIELD_ERROR' });
    expect(db.statements.filter(isUpdate)).toHaveLength(1);
  });
});
