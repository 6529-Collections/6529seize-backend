import { DataSource } from 'typeorm';
import * as Entities from '@/entities/entities';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  dropRetiredSchema,
  inspectRetiredSchema,
  RETIRED_MEMBERSHIP_TABLES
} from './retired-schema-cleanup';

function source() {
  return new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    charset: 'utf8mb4',
    timezone: 'Etc/UTC',
    entities: Object.values(Entities).filter(
      (entity) => typeof entity === 'function'
    ),
    synchronize: false
  });
}

describeWithSeed('Retired schema explicit cleanup boundary', [], () => {
  let db: DataSource;
  beforeAll(async () => {
    db = await source().initialize();
  });
  afterAll(async () => {
    await db.destroy();
  });
  afterEach(async () => {
    await db.query(
      `DROP TABLE IF EXISTS ${[...RETIRED_MEMBERSHIP_TABLES, 'membership_unknown'].map((name) => `\`${name}\``).join(', ')}`
    );
  });

  async function withRunner(
    fn: (runner: ReturnType<DataSource['createQueryRunner']>) => Promise<void>
  ) {
    const runner = db.createQueryRunner('master');
    try {
      await fn(runner);
    } finally {
      await runner.release();
    }
  }

  it('bootstraps without retired entities, preserves retained tables during full sync, and removes only the explicit set', async () => {
    await withRunner(async (runner) => {
      expect((await inspectRetiredSchema(runner)).tables).toEqual([]);
      for (const name of RETIRED_MEMBERSHIP_TABLES) {
        await runner.query(
          `CREATE TABLE \`${name}\` (id int PRIMARY KEY, frozen_value int NOT NULL)`
        );
        await runner.query(`INSERT INTO \`${name}\` VALUES (1, 51)`);
      }
      const before = await inspectRetiredSchema(runner);
      await db.synchronize();
      expect(await inspectRetiredSchema(runner)).toEqual(before);
      await dropRetiredSchema(runner, before);
      const removed = await inspectRetiredSchema(runner);
      expect(removed.tables).toEqual([]);
      await dropRetiredSchema(runner, removed);
      await db.synchronize();
      expect((await inspectRetiredSchema(runner)).tables).toEqual([]);
      expect(await runner.hasTable('community_groups')).toBe(true);
      const indexes: { Key_name: string }[] = await runner.query(
        'SHOW INDEX FROM community_groups'
      );
      expect(
        indexes.some(
          (index) => index.Key_name === 'idx_user_groups_pure_visible_id'
        )
      ).toBe(true);
    });
  });

  it('rejects data changed since the backup inventory without deleting any table', async () => {
    await withRunner(async (runner) => {
      await runner.query(
        'CREATE TABLE membership_refresh_targets (id int PRIMARY KEY, value int)'
      );
      await runner.query(
        'INSERT INTO membership_refresh_targets VALUES (1, 51)'
      );
      const approved = await inspectRetiredSchema(runner);
      await runner.query('UPDATE membership_refresh_targets SET value = 52');
      await expect(dropRetiredSchema(runner, approved)).rejects.toThrow(
        'changed after approved inventory'
      );
      expect(
        await runner.query('SELECT value FROM membership_refresh_targets')
      ).toEqual([{ value: 52 }]);
    });
  });

  it('rejects extra materialisation objects instead of broadening the deletion scope', async () => {
    await withRunner(async (runner) => {
      await runner.query('CREATE TABLE membership_unknown (id int)');
      await expect(inspectRetiredSchema(runner)).rejects.toThrow(
        'Unexpected membership schema objects'
      );
      expect(await runner.hasTable('membership_unknown')).toBe(true);
    });
  });

  it('rejects a dependent view before any deletion', async () => {
    await withRunner(async (runner) => {
      await runner.query('CREATE TABLE membership_refresh_targets (id int)');
      await runner.query(
        'CREATE VIEW retirement_dependency_test AS SELECT id FROM membership_refresh_targets'
      );
      try {
        await expect(inspectRetiredSchema(runner)).rejects.toThrow(
          'dependencies'
        );
        expect(await runner.hasTable('membership_refresh_targets')).toBe(true);
      } finally {
        await runner.query('DROP VIEW retirement_dependency_test');
      }
    });
  });

  it('bounds metadata-lock waiting and leaves the table intact for reconciliation', async () => {
    await withRunner(async (runner) => {
      await runner.query(
        'CREATE TABLE membership_refresh_targets (id int PRIMARY KEY)'
      );
      const approved = await inspectRetiredSchema(runner);
      const blocker = db.createQueryRunner('master');
      try {
        await blocker.startTransaction();
        await blocker.query('SELECT * FROM membership_refresh_targets');
        await expect(dropRetiredSchema(runner, approved)).rejects.toMatchObject(
          { code: 'ER_LOCK_WAIT_TIMEOUT' }
        );
        expect(await runner.hasTable('membership_refresh_targets')).toBe(true);
      } finally {
        await blocker.rollbackTransaction();
        await blocker.release();
      }
      // The failed attempt releases its operator lock and does not pretend DDL succeeded.
      await dropRetiredSchema(runner, approved);
      expect(await runner.hasTable('membership_refresh_targets')).toBe(false);
    });
  });

  it('refuses an inventory for a different database server', async () => {
    await withRunner(async (runner) => {
      const approved = await inspectRetiredSchema(runner);
      await expect(
        dropRetiredSchema(runner, {
          ...approved,
          serverUuid: 'different-server'
        })
      ).rejects.toThrow('Database identity');
    });
  });
});
