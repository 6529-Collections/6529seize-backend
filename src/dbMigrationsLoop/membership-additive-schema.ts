import type { DataSource, QueryRunner } from 'typeorm';
import type { SqlInMemory } from 'typeorm/driver/SqlInMemory';
import { performance } from 'node:perf_hooks';

interface PhysicalSchemaConnection {
  destroy(): void;
}

/** Own absolute settlement even when the event loop services a callback before its overdue timer. */
function schemaDeadline<T>(
  send: () => Promise<T>,
  durationMillis: number,
  message: string,
  onTimeout: () => void,
  onLate?: (value: T) => void
): Promise<T> {
  const until = performance.now() + durationMillis;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: { value: unknown } | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error.value);
      else resolve(value as T);
    };
    const expire = () => {
      if (settled) return;
      finish({ value: new Error(message) });
      try {
        onTimeout();
      } catch {
        /* Disposal cannot leave the owner pending. */
      }
    };
    const timer = setTimeout(expire, Math.max(0, until - performance.now()));
    Promise.resolve()
      .then(async () => {
        if (settled || performance.now() >= until) {
          expire();
          return;
        }
        const value = await send();
        if (settled || performance.now() >= until) {
          expire();
          try {
            onLate?.(value);
          } catch {
            /* A late acquisition is never usable. */
          }
          return;
        }
        finish(null, value);
      })
      .catch((error: unknown) => {
        if (performance.now() >= until) expire();
        else finish({ value: error });
      });
  });
}

function schemaStatement<T>(
  runner: QueryRunner,
  statement: string,
  parameters: unknown[],
  deadlineMillis: number,
  dispose: () => void
): Promise<T> {
  return schemaDeadline(
    () => runner.query(statement, parameters) as Promise<T>,
    deadlineMillis,
    'Membership schema statement outcome is unknown after deadline',
    dispose
  );
}

function schemaConnection(
  runner: QueryRunner
): Promise<PhysicalSchemaConnection> {
  return schemaDeadline(
    () => runner.connect(),
    3000,
    'Membership schema connection deadline exceeded before DDL',
    () => undefined,
    (physical: PhysicalSchemaConnection) => physical.destroy()
  );
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
  const physical = await schemaConnection(runner);
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
      (typeof original !== 'string' || !/^\d+$/.test(original))) ||
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

export interface MembershipSchemaInspectionOptions {
  readonly deadlineMillis?: number;
  readonly statementMillis?: number;
}
export interface MembershipSchemaReader {
  readonly runner: QueryRunner;
  log(): Promise<SqlInMemory>;
}

/** Confines TypeORM's internally created inspection runners to one owned lease. */
class MembershipSchemaInspection {
  private readonly owned: QueryRunner;
  private readonly until: number;
  private readonly workUntil: number;
  private readonly statementMillis: number;
  private physical?: PhysicalSchemaConnection;
  private revoked = false;
  private failure?: { error: unknown };
  private previous?: number;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly waiters = new Set<(error: unknown) => void>();
  private readonly originalQuery: QueryRunner['query'];

  constructor(
    private readonly source: DataSource,
    options: MembershipSchemaInspectionOptions
  ) {
    const duration = options.deadlineMillis ?? 15000;
    this.statementMillis = options.statementMillis ?? 3000;
    for (const value of [duration, this.statementMillis])
      if (!Number.isSafeInteger(value) || value < 1 || value > 120000)
        throw new Error('Invalid membership schema inspection budget');
    this.until = performance.now() + duration;
    this.workUntil = this.until - Math.min(3000, duration / 4);
    this.owned = source.createQueryRunner('master');
    this.originalQuery = this.owned.query.bind(this.owned);
  }
  private abort(error: unknown): void {
    this.failure ??= { error };
    if (!this.revoked) {
      this.revoked = true;
      try {
        this.physical?.destroy();
      } catch {
        /* Revoke even when disposal throws. */
      }
    }
    for (const reject of Array.from(this.waiters)) reject(this.failure.error);
  }
  private assertLive(): void {
    if (this.revoked)
      throw (
        this.failure?.error ??
        new Error('Membership schema inspection is closed')
      );
  }
  private bounded<T>(
    send: () => Promise<T>,
    until: number,
    late?: (value: T) => void
  ): Promise<T> {
    this.assertLive();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (error: { value: unknown } | null, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(onAbort);
        if (error) reject(error.value);
        else resolve(value as T);
      };
      const onAbort = (error: unknown) => finish({ value: error });
      const expire = () =>
        this.abort(new Error('Membership schema inspection deadline exceeded'));
      const timer = setTimeout(expire, Math.max(0, until - performance.now()));
      this.waiters.add(onAbort);
      Promise.resolve()
        .then(() => {
          this.assertLive();
          if (performance.now() >= until) {
            expire();
            this.assertLive();
          }
          return send();
        })
        .then(
          (value) => {
            if (settled) {
              late?.(value);
              return;
            }
            if (performance.now() >= until) {
              expire();
              late?.(value);
              return;
            }
            finish(null, value);
          },
          (error: unknown) => finish({ value: error })
        )
        .catch((error: unknown) => this.abort(error));
    });
  }
  private statement(
    sql: string,
    parameters: unknown[] = [],
    until = this.workUntil,
    structured = false
  ) {
    return this.bounded(
      () =>
        structured
          ? this.originalQuery(sql, parameters, true)
          : this.originalQuery(sql, parameters),
      Math.min(until, performance.now() + this.statementMillis)
    );
  }
  private query(
    sql: string,
    parameters?: unknown[],
    structured?: boolean
  ): Promise<unknown> {
    // Inspection must not execute DDL even if a future TypeORM log implementation changes.
    if (!/^\s*(SELECT|SHOW)\b/i.test(sql)) {
      const error = new Error('Membership schema inspection attempted a write');
      this.abort(error);
      return Promise.reject(error);
    }
    const operation = this.queue.then(() => {
      this.assertLive();
      return this.statement(sql, parameters, this.workUntil, structured);
    });
    this.queue = operation.catch((error: unknown) => {
      this.abort(error);
      throw error;
    });
    // Observe the queue tail even when a caller abandons a failed metadata operation.
    void this.queue.catch(() => undefined);
    return operation;
  }
  private borrowed(): QueryRunner {
    const runner = Object.create(this.owned) as QueryRunner;
    runner.query = ((
      sql: string,
      parameters?: unknown[],
      structured?: boolean
    ) => this.query(sql, parameters, structured)) as QueryRunner['query'];
    runner.connect = async () => {
      this.assertLive();
      return this.physical;
    };
    runner.release = async () => undefined;
    return runner;
  }
  private reader(): MembershipSchemaReader {
    const facade = Object.create(this.source) as DataSource;
    facade.createQueryRunner = () => this.borrowed();
    return {
      runner: this.borrowed(),
      log: async () => {
        this.assertLive();
        // RdbmsSchemaBuilder.log reads connection.createQueryRunner. Clone only
        // this builder instance so neither the shared source nor its driver changes.
        const builder = Object.create(this.source.driver.createSchemaBuilder());
        Object.defineProperty(builder, 'connection', { value: facade });
        return builder.log();
      }
    };
  }
  private async initialize(): Promise<void> {
    this.physical = await this.bounded(
      () => this.owned.connect(),
      this.workUntil,
      (connection) => {
        try {
          connection.destroy();
        } catch {
          /* Late acquisition is never used. */
        }
      }
    );
    const rows = await this.statement(
      'SELECT @@SESSION.lock_wait_timeout AS value'
    );
    const value = rows[0]?.value;
    const previous = Number(value);
    if (
      (typeof value !== 'number' &&
        (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value))) ||
      !Number.isSafeInteger(previous) ||
      previous < 1 ||
      previous > 31536000
    ) {
      const error = new Error('Invalid schema metadata lock timeout');
      this.abort(error);
      throw error;
    }
    this.previous = previous;
    await this.statement('SET SESSION lock_wait_timeout = ?', [1]);
  }
  private async close(): Promise<void> {
    if (!this.revoked && this.previous !== undefined) {
      try {
        await this.statement(
          'SET SESSION lock_wait_timeout = ?',
          [this.previous],
          this.until
        );
      } catch (error) {
        this.abort(error);
      }
    }
    // Restore before release; abandoned borrowed runners are permanently revoked.
    this.revoked = true;
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            this.failure ??= {
              error: new Error(
                'Membership schema inspection release deadline exceeded'
              )
            };
            try {
              this.physical?.destroy();
            } catch {
              /* Cleanup remains bounded. */
            }
            resolve();
          },
          Math.max(0, this.until - performance.now())
        );
        Promise.resolve()
          .then(() => this.owned.release())
          .then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (error: unknown) => {
              clearTimeout(timer);
              this.failure ??= { error };
              try {
                this.physical?.destroy();
              } catch {
                /* Discard failed lease. */
              }
              resolve();
            }
          );
      });
    } catch {
      /* Cleanup cannot mask the first inspection error. */
    }
  }
  async run<T>(
    read: (reader: MembershipSchemaReader) => Promise<T>
  ): Promise<T> {
    let result: T;
    try {
      await this.initialize();
      result = await this.bounded(() => read(this.reader()), this.workUntil);
    } finally {
      await this.close();
    }
    if (this.failure) throw this.failure.error;
    return result;
  }
}

/** Bound the entire preflight or verification, including TypeORM metadata reads. */
export function withMembershipSchemaInspection<T>(
  source: DataSource,
  read: (reader: MembershipSchemaReader) => Promise<T>,
  options: MembershipSchemaInspectionOptions = {}
): Promise<T> {
  return new MembershipSchemaInspection(source, options).run(read);
}
