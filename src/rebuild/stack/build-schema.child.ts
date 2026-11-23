// A child of the rebuild run: builds the schema of an empty database from
// code, as the test setup does: entity sync, then the migrations loop's full
// scope (bounded sync, the wave score index, the competition facade views).
// The old db-migrate scripts don't run (FEATURE_DB_MIGRATE_DISABLED), as in
// the tests.
import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as Entities from '@/entities/entities';
import * as dbMigrationsLoop from '@/dbMigrationsLoop';
import { env } from '@/env';
import { exitWithError } from '@/rebuild/stack/child-exit';

async function main(): Promise<void> {
  const fixture = new DataSource({
    type: 'mysql',
    host: env.getStringOrThrow('DB_HOST'),
    port: env.getIntOrThrow('DB_PORT'),
    username: env.getStringOrThrow('DB_USER'),
    password: env.getStringOrThrow('DB_PASS'),
    database: env.getStringOrThrow('DB_NAME'),
    charset: 'utf8mb4',
    timezone: 'Etc/UTC',
    entities: Object.values(Entities).filter(
      (entity) => typeof entity === 'function'
    ),
    synchronize: true
  });
  await fixture.initialize();
  await fixture.destroy();
  await dbMigrationsLoop.handler(
    undefined as any,
    undefined as any,
    undefined as any
  );
}

main().then(
  () => process.exit(0),
  (error) => {
    exitWithError('[BUILD SCHEMA FAILED]', error);
  }
);
