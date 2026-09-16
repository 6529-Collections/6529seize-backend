import 'reflect-metadata';
import { performance } from 'node:perf_hooks';
import * as mysql from 'mysql';
import { DataSource, QueryRunner } from 'typeorm';
import { DbQueryOptions } from '@/db-query.options';
import {
  ConnectionWrapper,
  SqlExecutor,
  SqlTransactionOptions
} from '@/sql-executor';
import {
  CustomTypeCaster,
  execBudgetedNativeTransactionally,
  execNativeTransactionally,
  execSQLWithParams
} from '@/db/my-sql.helpers';
import { MEMBERSHIP_FIXTURE_DATABASE } from './membership-runtime-policy';
import { membershipFixtureEntities } from './membership-runtime-fixture-manifest';
import {
  createMembershipFixtureDatabase,
  prepareMembershipFixtureSchema
} from './membership-runtime-fixture-setup-schema';
import { MembershipFixtureSetupService } from './membership-runtime-fixture-setup';
import {
  withMembershipPrimaryTransaction,
  MembershipPrimaryContext
} from './membership-primary';
export const membershipFixtureTestEnvironment = {
  stage: 'staging',
  region: 'eu-west-1'
};
class FixtureExecutor extends SqlExecutor {
  constructor(private readonly pool: mysql.Pool) {
    super();
  }
  acquire = () =>
    new Promise<mysql.PoolConnection>((resolve, reject) =>
      this.pool.getConnection((error, connection) =>
        error ? reject(error) : resolve(connection)
      )
    );
  async execute<T>(
    sql: string,
    params?: Record<string, unknown>,
    options?: DbQueryOptions
  ): Promise<T[]> {
    const connection = options?.wrappedConnection?.connection as
      | mysql.PoolConnection
      | undefined;
    return execSQLWithParams<T>(
      sql,
      connection ?? (await this.acquire()),
      !connection,
      params,
      options
    );
  }
  async executeNativeQueriesInTransaction<T>(
    callback: (
      connection: ConnectionWrapper<mysql.PoolConnection>
    ) => Promise<T>,
    options?: SqlTransactionOptions
  ): Promise<T> {
    return options?.executionBudget
      ? execBudgetedNativeTransactionally(
          callback,
          this.acquire,
          options.executionBudget
        )
      : execNativeTransactionally(callback, await this.acquire(), options);
  }
}
/** Actual fixed DB name; one server advisory lock serializes these suites across Jest workers. */
export async function createMembershipFixtureTestHarness() {
  // Installed MySqlContainer.start supplies this default, overriding withEnvironment.
  // This is the disposable test container's credential, never deployment configuration.
  const connectionOptions = {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: 'root',
    password: 'test',
    charset: 'utf8mb4',
    timezone: 'Etc/UTC'
  };
  const server = await new DataSource({
    type: 'mysql',
    ...connectionOptions,
    entities: [],
    synchronize: false
  }).initialize();
  let source: DataSource | undefined;
  let pool: mysql.Pool | undefined;
  let guard: QueryRunner | undefined;
  let owned = false;
  const close = async () => {
    if (pool)
      await new Promise<void>((resolve, reject) =>
        pool!.end((error) => (error ? reject(error) : resolve()))
      );
    if (source?.isInitialized) await source.destroy();
    if (owned && server.isInitialized)
      await server.query(
        `DROP DATABASE IF EXISTS \`${MEMBERSHIP_FIXTURE_DATABASE}\``
      );
    if (guard) {
      await guard.query(
        "SELECT RELEASE_LOCK('membership-fixture-test-database-v1')"
      );
      await guard.release();
    }
    if (server.isInitialized) await server.destroy();
  };
  try {
    guard = server.createQueryRunner('master');
    const lock: { acquired: number }[] = await guard.query(
      "SELECT GET_LOCK('membership-fixture-test-database-v1',600) acquired"
    );
    if (lock.length !== 1 || Number(lock[0].acquired) !== 1)
      throw new Error('Fixture test database is busy');
    owned = true;
    await server.query(
      `DROP DATABASE IF EXISTS \`${MEMBERSHIP_FIXTURE_DATABASE}\``
    );
    await createMembershipFixtureDatabase(
      server,
      membershipFixtureTestEnvironment,
      process.env.DB_NAME!
    );
    source = await new DataSource({
      type: 'mysql',
      ...connectionOptions,
      database: MEMBERSHIP_FIXTURE_DATABASE,
      entities: membershipFixtureEntities,
      synchronize: false
    }).initialize();
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT),
      user: 'root',
      password: 'test',
      database: MEMBERSHIP_FIXTURE_DATABASE,
      connectionLimit: 5,
      charset: 'utf8mb4',
      typeCast: CustomTypeCaster
    });
    const db = new FixtureExecutor(pool);
    const service = new MembershipFixtureSetupService(
      db,
      membershipFixtureTestEnvironment
    );
    const tx = <T>(callback: (ctx: MembershipPrimaryContext) => Promise<T>) =>
      withMembershipPrimaryTransaction(
        db,
        callback,
        {},
        {
          deadlineMonotonicMillis: performance.now() + 20000,
          maxStatementMillis: 3000,
          finalizationReserveMillis: 1000,
          lockWaitSeconds: 1
        }
      );
    const schema = async () => {
      for (let n = 0; n < 12; n++)
        if (
          (
            await prepareMembershipFixtureSchema(
              source!,
              membershipFixtureTestEnvironment
            )
          ).ready
        )
          return;
      throw new Error('Fixture schema did not finish bounded setup');
    };
    const prepare = async () => {
      for (let n = 0; n < 12; n++) {
        const result = await tx((ctx) => service.prepare(ctx));
        if (result.state.setup_stage === 'READY') return result;
      }
      throw new Error('Fixture input setup did not finish');
    };
    const setMysqlTime = async (millis: string) => {
      // MySQL's own session clock, on every real pool lease; adapters remain unchanged.
      const connections: mysql.PoolConnection[] = [];
      try {
        for (let n = 0; n < 5; n++) connections.push(await db.acquire());
        for (const connection of connections)
          await new Promise<void>((resolve, reject) =>
            connection.query(
              mysql.format('SET timestamp = ?', [
                Number(BigInt(millis) / BigInt(1000))
              ]),
              (error) => (error ? reject(error) : resolve())
            )
          );
      } finally {
        for (const connection of connections) connection.release();
      }
    };
    return { db, source, service, tx, schema, prepare, close, setMysqlTime };
  } catch (error) {
    await close();
    throw error;
  }
}
export type MembershipFixtureTestHarness = Awaited<
  ReturnType<typeof createMembershipFixtureTestHarness>
>;
