import 'reflect-metadata';
import { DataSource, Entity, PrimaryColumn } from 'typeorm';
import { USER_GROUPS_TABLE } from '@/constants';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { describeWithSeed } from '@/tests/_setup/seed';
import { membershipSchemaEntities } from './membership-schema';
import {
  applyMembershipEvaluatorSchema,
  MEMBERSHIP_EVALUATOR_INDEX,
  MEMBERSHIP_EVALUATOR_INDEX_PLAN
} from './membership-evaluator-schema';
import { applyFullSchemaWithMembershipGuard } from './membership-controlled-schema';

// Exists only inside this test's disposable database; no application entity.
const UNRELATED_FIXTURE = 'membership_schema_guard_fixture';
@Entity(UNRELATED_FIXTURE)
class UnrelatedSchemaFixture {
  @PrimaryColumn({ type: 'int' }) id!: number;
}

function source(full = false) {
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
    entities: full
      ? [...membershipSchemaEntities, UserGroupEntity, UnrelatedSchemaFixture]
      : [UserGroupEntity]
  });
}
const dropIndex = (db: DataSource) =>
  db.query(
    `ALTER TABLE \`${USER_GROUPS_TABLE}\` DROP INDEX \`${MEMBERSHIP_EVALUATOR_INDEX.name}\``
  );

describeWithSeed(
  'Membership evaluator online index and full-sync boundary',
  [],
  () => {
    it('adds only the missing index and is idempotent on the actual generated group entity', async () => {
      const db = await source().initialize();
      try {
        const columns = await db.query(
          `SHOW COLUMNS FROM \`${USER_GROUPS_TABLE}\``
        );
        await dropIndex(db);
        expect(
          (await db.driver.createSchemaBuilder().log()).upQueries.map(
            (q) => q.query
          )
        ).toEqual([MEMBERSHIP_EVALUATOR_INDEX_PLAN]);
        await expect(applyMembershipEvaluatorSchema(db)).resolves.toEqual({
          added_indexes: 1,
          verified_indexes: 1
        });
        await expect(applyMembershipEvaluatorSchema(db)).resolves.toEqual({
          added_indexes: 0,
          verified_indexes: 1
        });
        expect(
          await db.query(`SHOW COLUMNS FROM \`${USER_GROUPS_TABLE}\``)
        ).toEqual(columns);
        expect((await db.driver.createSchemaBuilder().log()).upQueries).toEqual(
          []
        );
      } finally {
        await db.synchronize();
        await db.destroy();
      }
    });

    it('bounds metadata-lock waiting, leaves no index after timeout, and succeeds after lock release', async () => {
      const db = await source().initialize();
      const blocker = db.createQueryRunner('master');
      try {
        await dropIndex(db);
        await blocker.startTransaction();
        await blocker.query(`SELECT id FROM \`${USER_GROUPS_TABLE}\` LIMIT 1`);
        const began = performance.now();
        await expect(applyMembershipEvaluatorSchema(db)).rejects.toMatchObject({
          code: 'ER_LOCK_WAIT_TIMEOUT'
        });
        expect(performance.now() - began).toBeLessThan(8_000);
        const indexes: { Key_name: string }[] = await db.query(
          `SHOW INDEX FROM \`${USER_GROUPS_TABLE}\``
        );
        expect(
          indexes.some((i) => i.Key_name === MEMBERSHIP_EVALUATOR_INDEX.name)
        ).toBe(false);
        await blocker.rollbackTransaction();
        await expect(applyMembershipEvaluatorSchema(db)).resolves.toEqual({
          added_indexes: 1,
          verified_indexes: 1
        });
      } finally {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction();
        await blocker.release();
        await db.synchronize();
        await db.destroy();
      }
    });

    it('bounds preflight behind a queued exclusive metadata lock before any index DDL', async () => {
      const db = await source().initialize();
      const blocker = db.createQueryRunner('master');
      const writer = db.createQueryRunner('master');
      let pending: Promise<unknown> | undefined;
      try {
        await dropIndex(db);
        await blocker.startTransaction();
        await blocker.query(`SELECT id FROM \`${USER_GROUPS_TABLE}\` LIMIT 1`);
        await writer.query('SET SESSION lock_wait_timeout=10');
        pending = writer
          .query(
            `ALTER TABLE \`${USER_GROUPS_TABLE}\` COMMENT='queued-schema-fixture'`
          )
          .catch((error: unknown) => error);
        let queued = false;
        for (let attempt = 0; attempt < 100 && !queued; attempt++) {
          const processes: { State: string | null; Info: string | null }[] =
            await db.query('SHOW PROCESSLIST');
          queued = processes.some(
            (row) =>
              row.State?.includes('metadata lock') &&
              row.Info?.includes('queued-schema-fixture')
          );
          if (!queued) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(queued).toBe(true);
        const began = performance.now();
        await expect(
          applyMembershipEvaluatorSchema(db, {
            deadlineMillis: 2500,
            statementMillis: 1500
          })
        ).rejects.toThrow();
        expect(performance.now() - began).toBeLessThan(5000);
        await blocker.rollbackTransaction();
        await pending;
        pending = undefined;
        const indexes: { Key_name: string }[] = await db.query(
          `SHOW INDEX FROM \`${USER_GROUPS_TABLE}\``
        );
        expect(
          indexes.some(
            (index) => index.Key_name === MEMBERSHIP_EVALUATOR_INDEX.name
          )
        ).toBe(false);
        await writer.query(`ALTER TABLE \`${USER_GROUPS_TABLE}\` COMMENT=''`);
        await expect(applyMembershipEvaluatorSchema(db)).resolves.toMatchObject(
          { added_indexes: 1 }
        );
      } finally {
        if (blocker.isTransactionActive) await blocker.rollbackTransaction();
        if (pending) await pending;
        await writer.query(`ALTER TABLE \`${USER_GROUPS_TABLE}\` COMMENT=''`);
        await writer.release();
        await blocker.release();
        await db.synchronize();
        await db.destroy();
      }
    });
    it('rejects invisible or unrelated drift before an allowed addition', async () => {
      const db = await source().initialize();
      try {
        await db.query(
          `ALTER TABLE \`${USER_GROUPS_TABLE}\` ALTER INDEX \`${MEMBERSHIP_EVALUATOR_INDEX.name}\` INVISIBLE`
        );
        await expect(applyMembershipEvaluatorSchema(db)).rejects.toThrow(
          'incompatible'
        );
        await db.query(
          `ALTER TABLE \`${USER_GROUPS_TABLE}\` ALTER INDEX \`${MEMBERSHIP_EVALUATOR_INDEX.name}\` VISIBLE`
        );
        await dropIndex(db);
        await db.query(
          `ALTER TABLE \`${USER_GROUPS_TABLE}\` ADD COLUMN schema_drift_fixture int NULL`
        );
        await expect(applyMembershipEvaluatorSchema(db)).rejects.toThrow(
          'unapproved or missing'
        );
        const indexes: { Key_name: string }[] = await db.query(
          `SHOW INDEX FROM \`${USER_GROUPS_TABLE}\``
        );
        expect(
          indexes.some((i) => i.Key_name === MEMBERSHIP_EVALUATOR_INDEX.name)
        ).toBe(false);
      } finally {
        await db.synchronize();
        await db.destroy();
      }
    });

    it('prevents full synchronization from applying membership DDL but retains unrelated schema work after explicit addition', async () => {
      const db = await source(true).initialize();
      const isolated = await source().initialize();
      try {
        await dropIndex(db);
        await expect(applyFullSchemaWithMembershipGuard(db)).rejects.toThrow(
          'explicit membership schema scopes'
        );
        const runner = db.createQueryRunner('master');
        try {
          expect(await runner.hasTable(UNRELATED_FIXTURE)).toBe(false);
        } finally {
          await runner.release();
        }
        await applyMembershipEvaluatorSchema(isolated);
        await applyFullSchemaWithMembershipGuard(db);
        const created = db.createQueryRunner('master');
        try {
          expect(await created.hasTable(UNRELATED_FIXTURE)).toBe(true);
        } finally {
          await created.release();
        }
      } finally {
        await isolated.synchronize();
        await db.query(`DROP TABLE IF EXISTS \`${UNRELATED_FIXTURE}\``);
        await isolated.destroy();
        await db.destroy();
      }
    });
  }
);
