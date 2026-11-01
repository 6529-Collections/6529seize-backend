import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { E2eeServiceDeps } from '@/api/e2ee/e2ee-context';
import { E2eeBackupsService } from '@/api/e2ee/e2ee-backups.service';
import {
  E2EE_BACKUP_CHUNKS_TABLE,
  E2EE_BACKUPS_TABLE,
  E2EE_CIPHERTEXT_OBJECTS_TABLE
} from '@/constants/db-tables';
import { E2eeBackupDb } from '@/e2ee/e2ee-backup.db';
import { MysqlE2eeCiphertextStore } from '@/e2ee/e2ee-ciphertext-store';
import { E2eeDb, E2eeDeviceRow } from '@/e2ee/e2ee.db';
import { E2eeApiException } from '@/e2ee/e2ee-errors';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';

const START = Date.UTC(2026, 9, 31, 12, 0, 0);
const KIB = 1024;
const hex = (bytes: number) => `0x${randomBytes(bytes).toString('hex')}`;
const chunkOf = (bytes = 4 * KIB) => randomBytes(bytes).toString('base64');

async function count(table: string): Promise<number> {
  const rows = await sqlExecutor.execute<{ n: number }>(
    `select count(*) as n from ${table}`
  );
  return Number(rows[0]?.n ?? 0);
}

describeWithSeed('E2EE encrypted backups (MySQL)', [], () => {
  let now: number;
  let service: E2eeBackupsService;
  const profileId = `profile-${randomBytes(6).toString('hex')}`;
  const deviceKey = hex(32);

  beforeEach(() => {
    now = START;
    const e2eeDb = new E2eeDb(() => sqlExecutor);
    const device = {
      device_key: deviceKey,
      profile_id: profileId,
      revoked_at: null,
      expires_at_seconds: Math.floor(START / 1000) + 86400 * 100
    } as unknown as E2eeDeviceRow;
    const e2ee = {
      db: {
        getDevice: async (key: string) => (key === deviceKey ? device : null),
        touchDevice: async () => undefined,
        hitRateCounters: e2eeDb.hitRateCounters.bind(e2eeDb)
      },
      now: () => now,
      random: () => 0.5,
      randomHex: hex
    } as unknown as E2eeServiceDeps;
    service = new E2eeBackupsService({
      e2ee,
      backups: new E2eeBackupDb(() => sqlExecutor),
      store: new MysqlE2eeCiphertextStore(() => sqlExecutor),
      backupsEnabled: () => true,
      quotaBytes: 64 * KIB
    });
  });

  it('stores, lists, serves, rotates, compacts and deletes ciphertext', async () => {
    const first = hex(16);
    const envelope = randomBytes(120).toString('base64');
    await service.createBackup(profileId, {
      backup_id: first,
      envelope,
      device_key: deviceKey
    });
    await service.activate(profileId, first, deviceKey);
    const bodies = [chunkOf(), chunkOf(16 * KIB), chunkOf()];
    for (const data of bodies) {
      now += 1000;
      await service.appendChunk(profileId, first, {
        device_key: deviceKey,
        data
      });
    }
    const status = await service.getStatus(profileId);
    expect(status.backup).toMatchObject({
      backup_id: first,
      envelope,
      active: true,
      chunk_count: 3,
      size: 24 * KIB,
      next_seq: 4
    });
    expect(status.used_bytes).toBe(24 * KIB);
    const page = await service.listChunks(profileId, first, { limit: 2 });
    expect(page.items.map((item) => item.seq)).toEqual([1, 2]);
    expect(page.next_after_seq).toBe(2);
    expect((await service.getChunk(profileId, first, 2)).data).toBe(bodies[1]);

    await expectQuota(
      service.appendChunk(profileId, first, {
        device_key: deviceKey,
        data: chunkOf(64 * KIB)
      })
    );
    expect(await count(E2EE_CIPHERTEXT_OBJECTS_TABLE)).toBe(3);

    const compacted = await service.compact(profileId, first, {
      device_key: deviceKey,
      through_seq: 2
    });
    expect(compacted).toMatchObject({ chunk_count: 1, size: 4 * KIB });
    expect(await count(E2EE_CIPHERTEXT_OBJECTS_TABLE)).toBe(1);

    const second = hex(16);
    await service.createBackup(profileId, {
      backup_id: second,
      envelope,
      device_key: deviceKey
    });
    await service.appendChunk(profileId, second, {
      device_key: deviceKey,
      data: chunkOf()
    });
    await service.activate(profileId, second, deviceKey);
    expect((await service.getStatus(profileId)).backup?.backup_id).toBe(second);
    expect(await count(E2EE_BACKUPS_TABLE)).toBe(1);
    expect(await count(E2EE_BACKUP_CHUNKS_TABLE)).toBe(1);
    expect(await count(E2EE_CIPHERTEXT_OBJECTS_TABLE)).toBe(1);

    await service.deleteAll(profileId);
    expect(await count(E2EE_BACKUPS_TABLE)).toBe(0);
    expect(await count(E2EE_BACKUP_CHUNKS_TABLE)).toBe(0);
    expect(await count(E2EE_CIPHERTEXT_OBJECTS_TABLE)).toBe(0);
    expect((await service.getStatus(profileId)).backup).toBeNull();
  });
});

async function expectQuota(promise: Promise<unknown>) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(E2eeApiException);
  expect((caught as E2eeApiException).code).toBe('E2EE_BACKUP_QUOTA');
}
