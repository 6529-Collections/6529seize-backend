import { MySqlContainer } from '@testcontainers/mysql';
import 'tsconfig-paths/register';
import { connect } from '../../db-api';
import * as dbMigrationsLoop from '../../dbMigrationsLoop';

module.exports = async () => {
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
  process.env.NODE_ENV = 'local';
  process.env.FEATURE_DB_MIGRATE_DISABLED = 'true';
  process.env.FORCE_AVOID_REDIS = 'true';

  await dbMigrationsLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );

  // 4️⃣  Make container handle available in global scope
  (global as any).__MYSQL__ = container;
  await connect();
};
