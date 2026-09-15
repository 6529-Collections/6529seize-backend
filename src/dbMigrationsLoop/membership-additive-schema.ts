import type { QueryRunner } from 'typeorm';

interface PhysicalSchemaConnection {
  destroy(): void;
}

function schemaStatement<T>(
  runner: QueryRunner,
  statement: string,
  parameters: unknown[],
  deadlineMillis: number,
  dispose: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        dispose();
      } finally {
        reject(
          new Error(
            'Membership schema statement outcome is unknown after deadline'
          )
        );
      }
    }, deadlineMillis);
    // Consume late callbacks and synchronous throws, including after disposal.
    Promise.resolve()
      .then(() => runner.query(statement, parameters))
      .then(
        (value: T) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        }
      );
  });
}

/** DDL is not transactional: a lost acknowledgement must be reconciled later. */
export async function executeMembershipOnlineIndex(
  runner: QueryRunner,
  statement: string,
  deadlineMillis = 120_000
): Promise<void> {
  if (
    !Number.isSafeInteger(deadlineMillis) ||
    deadlineMillis < 1 ||
    deadlineMillis > 120_000
  ) {
    throw new Error('Invalid membership index DDL deadline');
  }
  const physical: PhysicalSchemaConnection = await runner.connect();
  let disposed = false;
  let failure: unknown;
  let failed = false;
  const dispose = () => {
    if (!disposed) {
      disposed = true;
      physical.destroy();
    }
  };
  const rows = await schemaStatement<{ value: number | string }[]>(
    runner,
    'SELECT @@SESSION.lock_wait_timeout AS value',
    [],
    3_000,
    dispose
  );
  const original = rows[0]?.value;
  const previous = Number(original);
  if (
    (typeof original !== 'number' &&
      (typeof original !== 'string' || !/^[0-9]+$/.test(original))) ||
    !Number.isSafeInteger(previous) ||
    previous < 1 ||
    previous > 31536000
  ) {
    dispose();
    throw new Error('Invalid schema metadata lock timeout');
  }
  try {
    await schemaStatement(
      runner,
      'SET SESSION lock_wait_timeout = ?',
      [1],
      3_000,
      dispose
    );
    await schemaStatement(runner, statement, [], deadlineMillis, dispose);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (!disposed) {
      try {
        await schemaStatement(
          runner,
          'SET SESSION lock_wait_timeout = ?',
          [previous],
          3_000,
          dispose
        );
      } catch (error) {
        dispose();
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    }
  }
  if (failed) throw failure;
}

export interface MembershipIndexDefinition {
  readonly name: string;
  readonly columns: readonly string[];
}

interface MysqlIndexRow {
  Key_name: string;
  Non_unique: number | string;
  Seq_in_index: number | string;
  Column_name: string | null;
  Collation: string | null;
  Sub_part: number | null;
  Index_type: string;
  Visible: string;
  Expression?: string | null;
}

/** Table/index identifiers come only from the code-pinned schema definitions. */
export async function membershipIndexExists(
  runner: QueryRunner,
  table: string,
  definition: MembershipIndexDefinition
): Promise<boolean> {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(table)) {
    throw new Error('Invalid membership schema table identifier');
  }
  const rows: MysqlIndexRow[] = await runner.query(
    `SHOW INDEX FROM \`${table}\``
  );
  const index = rows
    .filter((row) => row.Key_name === definition.name)
    .sort((a, b) => Number(a.Seq_in_index) - Number(b.Seq_in_index));
  if (!index.length) return false;
  if (
    index.length !== definition.columns.length ||
    index.some(
      (row, position) =>
        Number(row.Non_unique) !== 1 ||
        Number(row.Seq_in_index) !== position + 1 ||
        row.Column_name !== definition.columns[position] ||
        row.Collation !== 'A' ||
        row.Sub_part !== null ||
        row.Index_type !== 'BTREE' ||
        row.Visible !== 'YES' ||
        row.Expression != null
    )
  )
    throw new Error('Existing membership index is incompatible');
  return true;
}
