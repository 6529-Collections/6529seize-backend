import 'reflect-metadata';
import path from 'node:path';
import {
  E2EE_BLOB_CHUNKS_TABLE,
  E2EE_BLOBS_TABLE,
  E2EE_DEVICES_TABLE,
  E2EE_GROUP_EPOCHS_TABLE,
  E2EE_GROUP_ROSTER_TABLE,
  E2EE_GROUPS_TABLE,
  E2EE_KEY_PACKAGES_TABLE,
  E2EE_LOG_TABLE,
  E2EE_REPORTS_TABLE,
  E2EE_WELCOME_DELIVERIES_TABLE,
  E2EE_WELCOMES_TABLE
} from '@/constants/db-tables';
import { E2EE_CIPHERSUITE } from '@/e2ee/e2ee.constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

type ResetMigration = {
  STORAGE_COLUMN_QUERY: string;
  statements: (hasStorageColumn: boolean) => string[];
  up: (db: { runSql: (sql: string) => Promise<unknown> }) => Promise<unknown>;
  down: () => Promise<unknown>;
};

function loadMigration(): ResetMigration {
  return require(
    path.resolve(
      process.cwd(),
      'migrations/20261031120000-reset-e2ee-classical-ciphersuite-state.js'
    )
  ) as ResetMigration;
}

const hex = (fill: string) => `0x${fill.repeat(64)}`;
const OLD_DEVICE = hex('a');
const NEW_DEVICE = hex('b');
const OLD_GROUP = hex('c');
const NEW_GROUP = hex('d');
const OLD_BLOB = 'old-blob-0000000000000000000000';
const NEW_BLOB = 'new-blob-0000000000000000000000';
const OLD_WELCOME = 'old-welcome';
const NEW_WELCOME = 'new-welcome';
const NOW = 1_760_000_000_000;

const device = (deviceKey: string, ciphersuite: number, profileId: string) => ({
  device_key: deviceKey,
  profile_id: profileId,
  wallet: `0x${'1'.repeat(40)}`,
  ciphersuite,
  issued_at_seconds: 1,
  expires_at_seconds: 2,
  origin: '6529.io',
  grant_id: hex('e'),
  wallet_signature: '0x',
  verified_via: 'eoa',
  label: 'Device',
  platform: 'web',
  created_at: NOW,
  updated_at: NOW
});

const keyPackage = (deviceKey: string) => ({
  device_key: deviceKey,
  data: Buffer.from('kp'),
  last_resort: false,
  expires_at_seconds: 2,
  created_at: NOW
});

const group = (handle: string) => ({
  group_handle: handle,
  epoch: 1,
  commit_key: hex('f'),
  last_seq: 1,
  created_by_profile_id: 'p',
  created_at: NOW,
  updated_at: NOW
});

const roster = (handle: string, deviceKey: string) => ({
  group_handle: handle,
  device_key: deviceKey,
  profile_id: 'p',
  joined_epoch: 0,
  added_at: NOW
});

const logItem = (handle: string, deviceKey: string) => ({
  group_handle: handle,
  seq: 1,
  item_type: 'message',
  epoch: 1,
  data: Buffer.from('ciphertext'),
  padded_len: 512,
  sender_device_key: deviceKey,
  sender_profile_id: 'p',
  created_at: NOW
});

const welcome = (id: string, handle: string, deviceKey: string) => ({
  id,
  group_handle: handle,
  epoch: 1,
  data: Buffer.from('welcome'),
  added_by_profile_id: 'p',
  added_by_device_key: deviceKey,
  created_at: NOW
});

const blob = (blobId: string, handle: string, deviceKey: string) => ({
  blob_id: blobId,
  group_handle: handle,
  uploader_device_key: deviceKey,
  uploader_profile_id: 'p',
  size: 4,
  chunk_count: 1,
  complete: true,
  created_at: NOW
});

const report = (id: string, handle: string, deviceKey: string) => ({
  id,
  group_handle: handle,
  epoch: 1,
  body: Buffer.from('reported'),
  signature: '0x',
  sender_device_key: deviceKey,
  sender_profile_id: 'p',
  reporter_device_key: deviceKey,
  reporter_profile_id: 'q',
  reason: 'CREDIBLE_THREAT_OF_VIOLENCE',
  verified: false,
  created_at: NOW
});

async function count(table: string): Promise<number> {
  const row = await sqlExecutor.oneOrNull<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table}`
  );
  return Number(row?.n ?? 0);
}

describe('E2EE classical ciphersuite reset migration', () => {
  it('targets the current ciphersuite and has a no-op down', async () => {
    const migration = loadMigration();
    expect(E2EE_CIPHERSUITE).toBe(79);
    for (const hasStorageColumn of [false, true]) {
      for (const statement of migration.statements(hasStorageColumn)) {
        expect(statement).toMatch(/^DELETE /);
        expect(statement).toContain(`ciphersuite <> ${E2EE_CIPHERSUITE}`);
        expect(statement).not.toMatch(/e2ee_reports|e2ee_report_access_log/);
      }
    }
    await expect(migration.down()).resolves.toBeUndefined();
  });

  it('deletes only MySQL-stored blobs once blobs have a storage column', async () => {
    const migration = loadMigration();
    const blobStatements = (hasStorageColumn: boolean) =>
      migration
        .statements(hasStorageColumn)
        .filter((sql) => sql.includes('e2ee_blobs b'));
    expect(blobStatements(false)).toHaveLength(2);
    for (const sql of blobStatements(false)) {
      expect(sql).not.toContain('storage');
    }
    for (const sql of blobStatements(true)) {
      expect(sql).toContain("b.storage = 'mysql'");
    }

    const executed: string[] = [];
    await migration.up({
      runSql: async (sql: string) => {
        executed.push(sql);
        return sql === migration.STORAGE_COLUMN_QUERY ? [{ n: 1 }] : [];
      }
    });
    expect(executed).toEqual([
      migration.STORAGE_COLUMN_QUERY,
      ...migration.statements(true)
    ]);
  });
});

describeWithSeed(
  'E2EE classical ciphersuite reset migration against MySQL',
  [
    {
      table: E2EE_DEVICES_TABLE,
      rows: [
        device(OLD_DEVICE, 1, 'old-profile'),
        device(NEW_DEVICE, E2EE_CIPHERSUITE, 'new-profile')
      ]
    },
    {
      table: E2EE_KEY_PACKAGES_TABLE,
      rows: [keyPackage(OLD_DEVICE), keyPackage(NEW_DEVICE)]
    },
    { table: E2EE_GROUPS_TABLE, rows: [group(OLD_GROUP), group(NEW_GROUP)] },
    {
      table: E2EE_GROUP_EPOCHS_TABLE,
      rows: [
        {
          group_handle: OLD_GROUP,
          epoch: 1,
          commit_key: hex('f'),
          created_at: NOW
        },
        {
          group_handle: NEW_GROUP,
          epoch: 1,
          commit_key: hex('f'),
          created_at: NOW
        }
      ]
    },
    {
      table: E2EE_GROUP_ROSTER_TABLE,
      rows: [roster(OLD_GROUP, OLD_DEVICE), roster(NEW_GROUP, NEW_DEVICE)]
    },
    {
      table: E2EE_LOG_TABLE,
      rows: [logItem(OLD_GROUP, OLD_DEVICE), logItem(NEW_GROUP, NEW_DEVICE)]
    },
    {
      table: E2EE_WELCOMES_TABLE,
      rows: [
        welcome(OLD_WELCOME, OLD_GROUP, OLD_DEVICE),
        welcome(NEW_WELCOME, NEW_GROUP, NEW_DEVICE)
      ]
    },
    {
      table: E2EE_WELCOME_DELIVERIES_TABLE,
      rows: [
        {
          welcome_id: OLD_WELCOME,
          device_key: OLD_DEVICE,
          profile_id: 'p',
          created_at: NOW
        },
        {
          welcome_id: NEW_WELCOME,
          device_key: NEW_DEVICE,
          profile_id: 'p',
          created_at: NOW
        }
      ]
    },
    {
      table: E2EE_BLOBS_TABLE,
      rows: [
        blob(OLD_BLOB, OLD_GROUP, OLD_DEVICE),
        blob(NEW_BLOB, NEW_GROUP, NEW_DEVICE)
      ]
    },
    {
      table: E2EE_BLOB_CHUNKS_TABLE,
      rows: [OLD_BLOB, NEW_BLOB].map((blobId) => ({
        blob_id: blobId,
        chunk_index: 0,
        data: Buffer.from('data'),
        size: 4,
        created_at: NOW
      }))
    },
    {
      table: E2EE_REPORTS_TABLE,
      rows: [report('old-report', OLD_GROUP, OLD_DEVICE)]
    }
  ],
  () => {
    it('removes classical-suite state, keeps new-suite state and reports', async () => {
      const migration = loadMigration();
      await migration.up({
        runSql: (sql: string) => sqlExecutor.execute(sql)
      });

      const remaining = async (sql: string) =>
        (await sqlExecutor.execute<Record<string, string>>(sql)).map(
          (row) => Object.values(row)[0]
        );
      await expect(
        remaining(`SELECT device_key FROM ${E2EE_DEVICES_TABLE}`)
      ).resolves.toEqual([NEW_DEVICE]);
      await expect(
        remaining(`SELECT device_key FROM ${E2EE_KEY_PACKAGES_TABLE}`)
      ).resolves.toEqual([NEW_DEVICE]);
      for (const table of [
        E2EE_GROUPS_TABLE,
        E2EE_GROUP_EPOCHS_TABLE,
        E2EE_GROUP_ROSTER_TABLE,
        E2EE_LOG_TABLE,
        E2EE_WELCOMES_TABLE,
        E2EE_BLOBS_TABLE
      ]) {
        await expect(
          remaining(`SELECT group_handle FROM ${table}`)
        ).resolves.toEqual([NEW_GROUP]);
      }
      await expect(
        remaining(`SELECT welcome_id FROM ${E2EE_WELCOME_DELIVERIES_TABLE}`)
      ).resolves.toEqual([NEW_WELCOME]);
      await expect(
        remaining(`SELECT blob_id FROM ${E2EE_BLOB_CHUNKS_TABLE}`)
      ).resolves.toEqual([NEW_BLOB]);
      await expect(count(E2EE_REPORTS_TABLE)).resolves.toBe(1);

      // A second run (for example a retried loop) changes nothing.
      await migration.up({
        runSql: (sql: string) => sqlExecutor.execute(sql)
      });
      await expect(count(E2EE_DEVICES_TABLE)).resolves.toBe(1);
      await expect(count(E2EE_GROUPS_TABLE)).resolves.toBe(1);
    });

    it('keeps classical blobs stored in S3 for retention to delete with their objects', async () => {
      // The S3 storage column, as the blob storage change adds it (added
      // here only when the schema does not have it yet).
      const [{ n }] = await sqlExecutor.execute<{ n: number }>(
        loadMigration().STORAGE_COLUMN_QUERY
      );
      const addedColumn = Number(n) === 0;
      if (addedColumn) {
        await sqlExecutor.execute(
          `ALTER TABLE ${E2EE_BLOBS_TABLE} ADD COLUMN storage varchar(16) NOT NULL DEFAULT 'mysql'`
        );
      }
      try {
        await sqlExecutor.execute(
          `UPDATE ${E2EE_BLOBS_TABLE} SET storage = 's3' WHERE blob_id = :id`,
          { id: OLD_BLOB }
        );
        await loadMigration().up({
          runSql: (sql: string) => sqlExecutor.execute(sql)
        });
        const blobIds = await sqlExecutor.execute<{ blob_id: string }>(
          `SELECT blob_id FROM ${E2EE_BLOBS_TABLE} ORDER BY blob_id`
        );
        expect(blobIds.map((row) => row.blob_id)).toEqual([NEW_BLOB, OLD_BLOB]);
        await expect(count(E2EE_BLOB_CHUNKS_TABLE)).resolves.toBe(2);
        await expect(count(E2EE_DEVICES_TABLE)).resolves.toBe(1);
        await expect(count(E2EE_GROUPS_TABLE)).resolves.toBe(1);
      } finally {
        if (addedColumn) {
          await sqlExecutor.execute(
            `ALTER TABLE ${E2EE_BLOBS_TABLE} DROP COLUMN storage`
          );
        }
      }
    });
  }
);
