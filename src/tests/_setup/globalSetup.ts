import { MySqlContainer } from '@testcontainers/mysql';
import 'tsconfig-paths/register';
import * as dbMigrationsLoop from '../../dbMigrationsLoop';
import {
  getTestDatabaseNamePrefix,
  getTestWorkerCount,
  provisionWorkerDatabases,
  TEST_DB_NAME_PREFIX_ENV
} from '@/tests/_setup/testDatabase';

module.exports = async (globalConfig?: unknown) => {
  // 1️⃣  Start MySQL ⤵
  const container = await new MySqlContainer('mysql:8.3')
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

  for (let workerId = 1; workerId <= workerCount; workerId++) {
    process.env.DB_NAME = `${databasePrefix}_${workerId}`;
    await dbMigrationsLoop.handler(
      undefined as any,
      undefined as any,
      undefined as any
    );
  }

  // 4️⃣  Make container handle available in global scope
  (global as any).__MYSQL__ = container;
};
