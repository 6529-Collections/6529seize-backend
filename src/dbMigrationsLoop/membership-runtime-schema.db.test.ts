import 'reflect-metadata';
import { DataSource } from 'typeorm';
import {
  MEMBERSHIP_REFRESH_RUNS_TABLE,
  MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE
} from '@/constants';
import { describeWithSeed } from '@/tests/_setup/seed';
import { membershipSchemaEntities } from './membership-schema';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { MembershipRuntimeCheckpointEntity } from '@/entities/IMembershipRuntimeCheckpoint';
import { applyFullSchemaWithMembershipGuard } from './membership-controlled-schema';
import {
  applyMembershipRuntimeSchema,
  MEMBERSHIP_RUNTIME_INDEX,
  membershipRuntimeSchemaEntities
} from './membership-runtime-schema';

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
      ? [
          ...membershipSchemaEntities,
          UserGroupEntity,
          MembershipRuntimeCheckpointEntity
        ]
      : membershipRuntimeSchemaEntities
  });
}
const dropIndex = (db: DataSource) =>
  db.query(
    `ALTER TABLE \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\` DROP INDEX \`${MEMBERSHIP_RUNTIME_INDEX.name}\``
  );
const dropTable = (db: DataSource) =>
  db.query(`DROP TABLE \`${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE}\``);

describeWithSeed('Membership runtime explicit additive schema', [], () => {
  it('adds only the missing control table and run index and verifies an idempotent second invocation', async () => {
    const db = await source().initialize();
    try {
      const columns = await db.query(
        `SHOW COLUMNS FROM \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\``
      );
      await dropIndex(db);
      await dropTable(db);
      await expect(applyMembershipRuntimeSchema(db)).resolves.toEqual({
        created_tables: 1,
        added_indexes: 1,
        verified_tables: 2,
        verified_indexes: 1
      });
      await expect(applyMembershipRuntimeSchema(db)).resolves.toEqual({
        created_tables: 0,
        added_indexes: 0,
        verified_tables: 2,
        verified_indexes: 1
      });
      expect(
        await db.query(`SHOW COLUMNS FROM \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\``)
      ).toEqual(columns);
      expect(
        await db.query(
          `SELECT COUNT(*) AS count FROM \`${MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE}\``
        )
      ).toEqual([{ count: '0' }]);
    } finally {
      await db.synchronize();
      await db.destroy();
    }
  });

  it('rejects mixed existing-table drift before creating the allowed table', async () => {
    const db = await source().initialize();
    try {
      await dropTable(db);
      await db.query(
        `ALTER TABLE \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\` ADD COLUMN unapproved_fixture int NULL`
      );
      await expect(applyMembershipRuntimeSchema(db)).rejects.toThrow(
        'unapproved'
      );
      const runner = db.createQueryRunner('master');
      try {
        expect(
          await runner.hasTable(MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE)
        ).toBe(false);
      } finally {
        await runner.release();
      }
    } finally {
      await db.synchronize();
      await db.destroy();
    }
  });

  it('bounds metadata lock wait, preserves a retryable partial addition, and succeeds after release', async () => {
    const db = await source().initialize();
    const blocker = db.createQueryRunner('master');
    try {
      await dropIndex(db);
      await dropTable(db);
      await blocker.startTransaction();
      await blocker.query(
        `SELECT id FROM \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\` LIMIT 1`
      );
      const began = performance.now();
      await expect(applyMembershipRuntimeSchema(db)).rejects.toMatchObject({
        code: 'ER_LOCK_WAIT_TIMEOUT'
      });
      expect(performance.now() - began).toBeLessThan(8000);
      await blocker.rollbackTransaction();
      await expect(applyMembershipRuntimeSchema(db)).resolves.toEqual({
        created_tables: 0,
        added_indexes: 1,
        verified_tables: 2,
        verified_indexes: 1
      });
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      await blocker.release();
      await db.synchronize();
      await db.destroy();
    }
  });

  it('bounds preflight behind a queued exclusive metadata lock before either runtime addition', async () => {
    const db = await source().initialize();
    const blocker = db.createQueryRunner('master');
    const writer = db.createQueryRunner('master');
    let pending: Promise<unknown> | undefined;
    try {
      await dropIndex(db);
      await dropTable(db);
      await blocker.startTransaction();
      await blocker.query(
        `SELECT id FROM \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\` LIMIT 1`
      );
      await writer.query('SET SESSION lock_wait_timeout=10');
      pending = writer
        .query(
          `ALTER TABLE \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\` COMMENT='queued-runtime-schema-fixture'`
        )
        .catch((error: unknown) => error);
      let queued = false;
      for (let attempt = 0; attempt < 100 && !queued; attempt++) {
        const processes: { State: string | null; Info: string | null }[] =
          await db.query('SHOW PROCESSLIST');
        queued = processes.some(
          (row) =>
            row.State?.includes('metadata lock') &&
            row.Info?.includes('queued-runtime-schema-fixture')
        );
        if (!queued) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(queued).toBe(true);
      const began = performance.now();
      await expect(
        applyMembershipRuntimeSchema(db, {
          deadlineMillis: 2500,
          statementMillis: 1500
        })
      ).rejects.toThrow();
      expect(performance.now() - began).toBeLessThan(5000);
      await blocker.rollbackTransaction();
      await pending;
      pending = undefined;
      const indexes: { Key_name: string }[] = await db.query(
        `SHOW INDEX FROM \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\``
      );
      expect(
        indexes.some(
          (index) => index.Key_name === MEMBERSHIP_RUNTIME_INDEX.name
        )
      ).toBe(false);
      const inspector = db.createQueryRunner('master');
      try {
        expect(
          await inspector.hasTable(MEMBERSHIP_RUNTIME_CHECKPOINTS_TABLE)
        ).toBe(false);
      } finally {
        await inspector.release();
      }
      await writer.query(
        `ALTER TABLE \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\` COMMENT=''`
      );
      await expect(applyMembershipRuntimeSchema(db)).resolves.toMatchObject({
        added_indexes: 1
      });
    } finally {
      if (blocker.isTransactionActive) await blocker.rollbackTransaction();
      if (pending) await pending;
      await writer.query(
        `ALTER TABLE \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\` COMMENT=''`
      );
      await writer.release();
      await blocker.release();
      await db.synchronize();
      await db.destroy();
    }
  });

  it('requires both exact runtime additions before manual full synchronization', async () => {
    const db = await source().initialize();
    const full = await source(true).initialize();
    try {
      await dropTable(db);
      await expect(applyFullSchemaWithMembershipGuard(full)).rejects.toThrow(
        'explicit membership schema scopes'
      );
      await applyMembershipRuntimeSchema(db);
      await dropIndex(db);
      await expect(applyFullSchemaWithMembershipGuard(full)).rejects.toThrow(
        'explicit membership schema scopes'
      );
      await applyMembershipRuntimeSchema(db);
      await expect(
        applyFullSchemaWithMembershipGuard(full)
      ).resolves.toBeUndefined();
      await db.query(
        `ALTER TABLE \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\` ALTER INDEX \`${MEMBERSHIP_RUNTIME_INDEX.name}\` INVISIBLE`
      );
      await expect(applyFullSchemaWithMembershipGuard(full)).rejects.toThrow(
        'incompatible'
      );
    } finally {
      await db.query(
        `ALTER TABLE \`${MEMBERSHIP_REFRESH_RUNS_TABLE}\` ALTER INDEX \`${MEMBERSHIP_RUNTIME_INDEX.name}\` VISIBLE`
      );
      await db.synchronize();
      await full.destroy();
      await db.destroy();
    }
  });
});
