import 'reflect-metadata';
import { performance } from 'node:perf_hooks';
import { DataSource } from 'typeorm';
import {
  MEMBERSHIP_REFRESH_TARGETS_TABLE,
  MEMBERSHIP_SOURCE_STATES_TABLE
} from '@/constants';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  applyMembershipBackfillIndexSchema,
  MEMBERSHIP_BACKFILL_INDEXES,
  membershipBackfillIndexEntities,
  membershipBackfillIndexPlan
} from './membership-backfill-index-schema';

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
    synchronize: false,
    entities: membershipBackfillIndexEntities
  });
}

async function dropIndexes(db: DataSource): Promise<void> {
  for (const index of MEMBERSHIP_BACKFILL_INDEXES)
    await db.query(
      `ALTER TABLE \`${index.table}\` DROP INDEX \`${index.name}\``
    );
}

describeWithSeed('Membership backfill online probe indexes', [], () => {
  it('adds only three exact indexes online and verifies idempotent rerun', async () => {
    const db = await source().initialize();
    try {
      const sourceColumns = await db.query(
        `SHOW COLUMNS FROM \`${MEMBERSHIP_SOURCE_STATES_TABLE}\``
      );
      const targetColumns = await db.query(
        `SHOW COLUMNS FROM \`${MEMBERSHIP_REFRESH_TARGETS_TABLE}\``
      );
      await dropIndexes(db);
      const plan = (await db.driver.createSchemaBuilder().log()).upQueries.map(
        (query) => query.query
      );
      expect(plan.sort((a, b) => a.localeCompare(b))).toEqual(
        MEMBERSHIP_BACKFILL_INDEXES.map(membershipBackfillIndexPlan).sort(
          (a, b) => a.localeCompare(b)
        )
      );
      await expect(applyMembershipBackfillIndexSchema(db)).resolves.toEqual({
        added_indexes: 3,
        verified_indexes: 3
      });
      await expect(applyMembershipBackfillIndexSchema(db)).resolves.toEqual({
        added_indexes: 0,
        verified_indexes: 3
      });
      expect(
        await db.query(
          `SHOW COLUMNS FROM \`${MEMBERSHIP_SOURCE_STATES_TABLE}\``
        )
      ).toEqual(sourceColumns);
      expect(
        await db.query(
          `SHOW COLUMNS FROM \`${MEMBERSHIP_REFRESH_TARGETS_TABLE}\``
        )
      ).toEqual(targetColumns);
      expect((await db.driver.createSchemaBuilder().log()).upQueries).toEqual(
        []
      );
    } finally {
      await db.synchronize();
      await db.destroy();
    }
  });

  it('rejects an incompatible index before adding any missing one', async () => {
    const db = await source().initialize();
    const first = MEMBERSHIP_BACKFILL_INDEXES[0];
    const last = MEMBERSHIP_BACKFILL_INDEXES[2];
    try {
      await db.query(
        `ALTER TABLE \`${first.table}\` ALTER INDEX \`${first.name}\` INVISIBLE`
      );
      await db.query(
        `ALTER TABLE \`${last.table}\` DROP INDEX \`${last.name}\``
      );
      await expect(applyMembershipBackfillIndexSchema(db)).rejects.toThrow(
        'incompatible'
      );
      const rows: { Key_name: string }[] = await db.query(
        `SHOW INDEX FROM \`${last.table}\``
      );
      expect(rows.some((row) => row.Key_name === last.name)).toBe(false);
    } finally {
      await db.query(
        `ALTER TABLE \`${first.table}\` ALTER INDEX \`${first.name}\` VISIBLE`
      );
      await db.synchronize();
      await db.destroy();
    }
  });

  it('bounds metadata lock wait and reconciles the partial index set', async () => {
    const db = await source().initialize();
    const blocker = db.createQueryRunner('master');
    try {
      await dropIndexes(db);
      await blocker.startTransaction();
      await blocker.query(
        `SELECT scope FROM \`${MEMBERSHIP_SOURCE_STATES_TABLE}\` LIMIT 1`
      );
      const began = performance.now();
      await expect(
        applyMembershipBackfillIndexSchema(db)
      ).rejects.toMatchObject({ code: 'ER_LOCK_WAIT_TIMEOUT' });
      expect(performance.now() - began).toBeLessThan(8000);
      await blocker.rollbackTransaction();
      await expect(applyMembershipBackfillIndexSchema(db)).resolves.toEqual({
        added_indexes: 3,
        verified_indexes: 3
      });
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
      await db.synchronize();
      await db.destroy();
    }
  });
});
