import { MySqlContainer } from '@testcontainers/mysql';
import 'tsconfig-paths/register';
import * as dbMigrationsLoop from '../../dbMigrationsLoop';
import { DataSource } from 'typeorm';
import * as Entities from '@/entities/entities';
import {
  getTestDatabaseNamePrefix,
  getTestWorkerCount,
  provisionWorkerDatabases,
  TEST_DB_NAME_PREFIX_ENV
} from '@/tests/_setup/testDatabase';

/** Starts an isolated MySQL container and initializes one database per Jest worker. */
module.exports = async (globalConfig?: unknown) => {
  // 1️⃣  Start MySQL ⤵
  const container = await new MySqlContainer(
    process.env.TEST_MYSQL_IMAGE ?? 'mysql:8.3'
  )
    .withEnvironment({ MYSQL_ROOT_PASSWORD: 'root' })
    .withTmpFs({ '/var/lib/mysql': 'rw' })
    .withCommand(['--default-authentication-plugin=mysql_native_password'])
    .start();

  // 2️⃣  Expose credentials via env so the app picks them up
  process.env.DB_HOST = container.getHost();
  process.env.DB_PORT = container.getMappedPort(3306).toString();
  process.env.DB_USER = container.getUsername(); // 'test'
  process.env.DB_PASS = container.getUserPassword(); // 'test'
  process.env.DB_NAME = container.getDatabase(); // 'test'
  process.env.DB_HOST_READ = container.getHost();
  process.env.DB_USER_READ = container.getUsername();
  process.env.DB_PASS_READ = container.getUserPassword();
  process.env.NODE_ENV = 'local';
  process.env.FEATURE_DB_MIGRATE_DISABLED = 'true';
  process.env.FORCE_AVOID_REDIS = 'true';

  const workerCount = getTestWorkerCount(globalConfig);
  const databasePrefix = getTestDatabaseNamePrefix(container.getDatabase());
  process.env[TEST_DB_NAME_PREFIX_ENV] = databasePrefix;

  await provisionWorkerDatabases({
    executeRootQuery: (query) => container.executeQuery(query, [], true),
    appUser: container.getUsername(),
    databasePrefix,
    workerCount
  });

  try {
    for (let workerId = 1; workerId <= workerCount; workerId++) {
      process.env.DB_NAME = `${databasePrefix}_${workerId}`;
      // The application's full-sync guard must reject missing controlled schema.
      // Only this newly created disposable container gets unrestricted creation.
      const fixture = new DataSource({
        type: 'mysql',
        host: container.getHost(),
        port: container.getMappedPort(3306),
        username: container.getUsername(),
        password: container.getUserPassword(),
        database: `${databasePrefix}_${workerId}`,
        charset: 'utf8mb4',
        timezone: 'Etc/UTC',
        entities: Object.values(Entities).filter(
          (entity) => typeof entity === 'function'
        ),
        synchronize: true
      });
      try {
        await fixture.initialize();
      } catch (error) {
        // The driver can own a pool before initialize marks the source ready.
        // Preserve its startup error even when partial cleanup has nothing to close.
        try {
          if (fixture.isInitialized) await fixture.destroy();
          else await fixture.driver.disconnect();
        } catch {
          // initialize may already have cleaned up the failed driver.
        }
        throw error;
      }
      await fixture.destroy();
      await dbMigrationsLoop.handler(
        undefined as any,
        undefined as any,
        undefined as any
      );
    }
  } catch (error) {
    await container.stop();
    throw error;
  }

  // 4️⃣  Make container handle available in global scope
  (global as any).__MYSQL__ = container;
};
