import { randomBytes } from 'node:crypto';
import { E2eeServiceDeps } from '@/api/e2ee/e2ee-context';
import { E2eeBackupsService } from '@/api/e2ee/e2ee-backups.service';
import {
  E2eeBackupChunkRow,
  E2eeBackupRepository,
  E2eeBackupRow
} from '@/e2ee/e2ee-backup.db';
import { E2eeCiphertextStore } from '@/e2ee/e2ee-ciphertext-store';
import { E2eeDeviceRow } from '@/e2ee/e2ee.db';
import { E2EE_BACKUP_PENDING_TTL_MS } from '@/e2ee/e2ee.constants';
import { E2eeApiException } from '@/e2ee/e2ee-errors';

const KIB = 1024;
const START = Date.UTC(2026, 9, 31, 12, 0, 0);

const hex = (bytes: number) => `0x${randomBytes(bytes).toString('hex')}`;

/** In-memory stand-in for the MySQL repository (single-threaded tests). */
class MemoryBackupRepository implements E2eeBackupRepository {
  readonly backups = new Map<string, E2eeBackupRow>();
  readonly chunks: E2eeBackupChunkRow[] = [];

  executeNativeQueriesInTransaction<T>(
    executable: (connection: never) => Promise<T>
  ): Promise<T> {
    // Copy-on-failure keeps the "transaction" atomic for the tests.
    const backups = new Map(this.backups);
    const chunks = [...this.chunks];
    return executable(undefined as never).catch((error) => {
      this.backups.clear();
      backups.forEach((value, key) => this.backups.set(key, value));
      this.chunks.splice(0, this.chunks.length, ...chunks);
      throw error;
    });
  }

  async lockProfile(): Promise<void> {}

  async getBackup(backupId: string) {
    return this.backups.get(backupId) ?? null;
  }

  async getActiveBackup(profileId: string) {
    return (
      Array.from(this.backups.values()).find(
        (row) => row.profile_id === profileId && row.active
      ) ?? null
    );
  }

  async listProfileBackups(profileId: string) {
    return Array.from(this.backups.values()).filter(
      (row) => row.profile_id === profileId
    );
  }

  async getUsageBytes(profileId: string) {
    return (await this.listProfileBackups(profileId)).reduce(
      (sum, row) => sum + Number(row.size),
      0
    );
  }

  async insertBackup(row: E2eeBackupRow) {
    this.backups.set(row.backup_id, { ...row });
  }

  async activateBackup(backupId: string, activatedAt: number) {
    const row = this.backups.get(backupId)!;
    this.backups.set(backupId, {
      ...row,
      active: true,
      activated_at: activatedAt,
      updated_at: activatedAt
    });
  }

  async insertChunk(row: E2eeBackupChunkRow) {
    this.chunks.push({ ...row });
  }

  async recordChunk(input: {
    backupId: string;
    seq: number;
    size: number;
    updatedAt: number;
  }) {
    const row = this.backups.get(input.backupId)!;
    this.backups.set(input.backupId, {
      ...row,
      next_seq: input.seq + 1,
      chunk_count: row.chunk_count + 1,
      size: row.size + input.size,
      updated_at: input.updatedAt
    });
  }

  async listChunks(backupId: string, afterSeq: number, limit: number) {
    return this.chunks
      .filter((chunk) => chunk.backup_id === backupId && chunk.seq > afterSeq)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  async getChunk(backupId: string, seq: number) {
    return (
      this.chunks.find(
        (chunk) => chunk.backup_id === backupId && chunk.seq === seq
      ) ?? null
    );
  }

  async listObjectKeys(
    backupIds: readonly string[],
    _connection: unknown,
    throughSeq?: number
  ) {
    return this.chunks
      .filter(
        (chunk) =>
          backupIds.includes(chunk.backup_id) &&
          (throughSeq === undefined || chunk.seq <= throughSeq)
      )
      .map((chunk) => chunk.object_key);
  }

  async deleteChunksThrough(
    backupId: string,
    throughSeq: number,
    updatedAt: number
  ) {
    const kept = this.chunks.filter(
      (chunk) => !(chunk.backup_id === backupId && chunk.seq <= throughSeq)
    );
    this.chunks.splice(0, this.chunks.length, ...kept);
    const mine = kept.filter((chunk) => chunk.backup_id === backupId);
    const row = this.backups.get(backupId)!;
    this.backups.set(backupId, {
      ...row,
      chunk_count: mine.length,
      size: mine.reduce((sum, chunk) => sum + chunk.size, 0),
      updated_at: updatedAt
    });
  }

  async deleteBackups(backupIds: readonly string[]) {
    const kept = this.chunks.filter(
      (chunk) => !backupIds.includes(chunk.backup_id)
    );
    this.chunks.splice(0, this.chunks.length, ...kept);
    backupIds.forEach((id) => this.backups.delete(id));
  }

  async listStalePending(cutoff: number, limit: number) {
    return Array.from(this.backups.values())
      .filter((row) => !row.active && row.created_at < cutoff)
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, limit);
  }
}

class MemoryStore implements E2eeCiphertextStore {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, data: Buffer) {
    this.objects.set(key, Buffer.from(data));
  }

  async get(key: string) {
    return this.objects.get(key) ?? null;
  }

  async deleteMany(keys: readonly string[]) {
    keys.forEach((key) => this.objects.delete(key));
  }
}

function device(profileId: string, revoked = false): E2eeDeviceRow {
  return {
    device_key: hex(32),
    profile_id: profileId,
    revoked_at: revoked ? START : null,
    expires_at_seconds: Math.floor(START / 1000) + 86400 * 100
  } as unknown as E2eeDeviceRow;
}

async function expectCode(promise: Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(E2eeApiException);
  expect((caught as E2eeApiException).code).toBe(code);
  return caught as E2eeApiException;
}

/** A chunk ciphertext of a bucket length, as base64. */
const chunkOf = (bytes = 4 * KIB) => randomBytes(bytes).toString('base64');
const envelope = () => randomBytes(200).toString('base64');

describe('E2eeBackupsService', () => {
  let now: number;
  let repo: MemoryBackupRepository;
  let store: MemoryStore;
  let devices: Map<string, E2eeDeviceRow>;
  let counters: Map<string, number>;
  let enabled: boolean;
  let service: E2eeBackupsService;
  const alice = 'profile-alice';
  const bob = 'profile-bob';
  let aliceDevice: E2eeDeviceRow;
  let aliceOther: E2eeDeviceRow;
  let bobDevice: E2eeDeviceRow;

  function build(options: { quotaBytes?: number; maxChunks?: number } = {}) {
    const e2ee = {
      db: {
        getDevice: async (key: string) => devices.get(key) ?? null,
        touchDevice: async () => undefined,
        hitRateCounters: async (
          keys: readonly { key: string; amount?: number }[]
        ) => {
          const out = new Map<string, number>();
          for (const entry of keys) {
            const next = (counters.get(entry.key) ?? 0) + (entry.amount ?? 1);
            counters.set(entry.key, next);
            out.set(entry.key, next);
          }
          return out;
        }
      },
      now: () => now,
      random: () => 0.5,
      randomHex: hex
    } as unknown as E2eeServiceDeps;
    service = new E2eeBackupsService({
      e2ee,
      backups: repo,
      store,
      backupsEnabled: () => enabled,
      ...options
    });
  }

  beforeEach(() => {
    now = START;
    repo = new MemoryBackupRepository();
    store = new MemoryStore();
    counters = new Map();
    enabled = true;
    aliceDevice = device(alice);
    aliceOther = device(alice);
    bobDevice = device(bob);
    devices = new Map(
      [aliceDevice, aliceOther, bobDevice].map((row) => [row.device_key, row])
    );
    build();
  });

  async function activeBackup(profileId = alice, row = aliceDevice) {
    const backupId = hex(16);
    await service.createBackup(profileId, {
      backup_id: backupId,
      envelope: envelope(),
      device_key: row.device_key
    });
    await service.activate(profileId, backupId, row.device_key);
    return backupId;
  }

  it('creates a pending generation that becomes active on activate', async () => {
    const backupId = hex(16);
    const env = envelope();
    const created = await service.createBackup(alice, {
      backup_id: backupId,
      envelope: env,
      device_key: aliceDevice.device_key
    });
    expect(created).toMatchObject({
      backup_id: backupId,
      envelope: env,
      active: false,
      chunk_count: 0,
      next_seq: 1,
      activated_at: null
    });
    expect((await service.getStatus(alice)).backup).toBeNull();
    now += 1000;
    const activated = await service.activate(
      alice,
      backupId,
      aliceDevice.device_key
    );
    expect(activated).toMatchObject({ active: true, activated_at: now });
    const status = await service.getStatus(alice);
    expect(status.backup).toMatchObject({ backup_id: backupId, envelope: env });
    expect(status.chunk_buckets).toEqual([4096, 16384, 65536, 262144, 1048576]);
  });

  it('appends chunks with server-assigned sequence numbers and serves them back unchanged', async () => {
    const backupId = await activeBackup();
    const bodies = [chunkOf(), chunkOf(16 * KIB), chunkOf()];
    const seqs: number[] = [];
    for (const data of bodies) {
      const chunk = await service.appendChunk(alice, backupId, {
        device_key: aliceDevice.device_key,
        data
      });
      seqs.push(chunk.seq);
    }
    expect(seqs).toEqual([1, 2, 3]);
    // Another device of the same profile appends to the same generation.
    const fourth = await service.appendChunk(alice, backupId, {
      device_key: aliceOther.device_key,
      data: chunkOf()
    });
    expect(fourth.seq).toBe(4);
    const firstPage = await service.listChunks(alice, backupId, { limit: 2 });
    expect(firstPage.items.map((item) => item.seq)).toEqual([1, 2]);
    expect(firstPage.next_after_seq).toBe(2);
    const secondPage = await service.listChunks(alice, backupId, {
      after_seq: 2,
      limit: 2
    });
    expect(secondPage.items.map((item) => item.seq)).toEqual([3, 4]);
    expect(secondPage.next_after_seq).toBeNull();
    for (let index = 0; index < bodies.length; index++) {
      const data = bodies[index];
      const chunk = await service.getChunk(alice, backupId, index + 1);
      expect(chunk.data).toBe(data);
    }
    const status = await service.getStatus(alice);
    expect(status.backup?.chunk_count).toBe(4);
    expect(status.used_bytes).toBe(4 * KIB * 3 + 16 * KIB);
  });

  it('accepts only bucket-length ciphertext', async () => {
    const backupId = await activeBackup();
    await expectCode(
      service.appendChunk(alice, backupId, {
        device_key: aliceDevice.device_key,
        data: chunkOf(4 * KIB + 1)
      }),
      'E2EE_BAD_REQUEST'
    );
    await expectCode(
      service.appendChunk(alice, backupId, {
        device_key: aliceDevice.device_key,
        data: chunkOf(2 * 1024 * KIB)
      }),
      'E2EE_TOO_LARGE'
    );
    expect(store.objects.size).toBe(0);
  });

  it('enforces the per-profile quota across generations and drops the rejected object', async () => {
    build({ quotaBytes: 40 * KIB });
    const backupId = await activeBackup();
    await service.appendChunk(alice, backupId, {
      device_key: aliceDevice.device_key,
      data: chunkOf(16 * KIB)
    });
    // A pending rotation counts against the same quota.
    const pendingId = hex(16);
    await service.createBackup(alice, {
      backup_id: pendingId,
      envelope: envelope(),
      device_key: aliceDevice.device_key
    });
    await service.appendChunk(alice, pendingId, {
      device_key: aliceDevice.device_key,
      data: chunkOf(16 * KIB)
    });
    const error = await expectCode(
      service.appendChunk(alice, pendingId, {
        device_key: aliceDevice.device_key,
        data: chunkOf(16 * KIB)
      }),
      'E2EE_BACKUP_QUOTA'
    );
    expect(error.details).toEqual({ quota_bytes: 40 * KIB });
    expect(store.objects.size).toBe(2);
    expect(repo.chunks).toHaveLength(2);
    // Bob's quota is separate.
    const bobBackup = await activeBackup(bob, bobDevice);
    await service.appendChunk(bob, bobBackup, {
      device_key: bobDevice.device_key,
      data: chunkOf(16 * KIB)
    });
  });

  it('caps the number of chunks per generation', async () => {
    build({ maxChunks: 2 });
    const backupId = await activeBackup();
    for (let i = 0; i < 2; i++) {
      await service.appendChunk(alice, backupId, {
        device_key: aliceDevice.device_key,
        data: chunkOf()
      });
    }
    await expectCode(
      service.appendChunk(alice, backupId, {
        device_key: aliceDevice.device_key,
        data: chunkOf()
      }),
      'E2EE_TOO_LARGE'
    );
  });

  it('hides another profile’s backups and requires an own active device for writes', async () => {
    const backupId = await activeBackup();
    await service.appendChunk(alice, backupId, {
      device_key: aliceDevice.device_key,
      data: chunkOf()
    });
    await expectCode(service.getBackup(bob, backupId), 'E2EE_NOT_FOUND');
    await expectCode(service.listChunks(bob, backupId, {}), 'E2EE_NOT_FOUND');
    await expectCode(service.getChunk(bob, backupId, 1), 'E2EE_NOT_FOUND');
    await expectCode(
      service.appendChunk(bob, backupId, {
        device_key: bobDevice.device_key,
        data: chunkOf()
      }),
      'E2EE_NOT_FOUND'
    );
    await expectCode(
      service.appendChunk(alice, backupId, {
        device_key: bobDevice.device_key,
        data: chunkOf()
      }),
      'E2EE_NOT_YOUR_DEVICE'
    );
    const revoked = device(alice, true);
    devices.set(revoked.device_key, revoked);
    await expectCode(
      service.appendChunk(alice, backupId, {
        device_key: revoked.device_key,
        data: chunkOf()
      }),
      'E2EE_NOT_YOUR_DEVICE'
    );
    await expectCode(
      service.activate(bob, backupId, bobDevice.device_key),
      'E2EE_NOT_FOUND'
    );
    expect((await service.getStatus(bob)).backup).toBeNull();
  });

  it('rotates: activating a new generation deletes the old one and its objects', async () => {
    const oldId = await activeBackup();
    for (let i = 0; i < 3; i++) {
      await service.appendChunk(alice, oldId, {
        device_key: aliceDevice.device_key,
        data: chunkOf()
      });
    }
    const newId = hex(16);
    await service.createBackup(alice, {
      backup_id: newId,
      envelope: envelope(),
      device_key: aliceDevice.device_key
    });
    await service.appendChunk(alice, newId, {
      device_key: aliceDevice.device_key,
      data: chunkOf()
    });
    // Until activation the old generation stays the one restores use.
    expect((await service.getStatus(alice)).backup?.backup_id).toBe(oldId);
    await service.activate(alice, newId, aliceDevice.device_key);
    expect((await service.getStatus(alice)).backup?.backup_id).toBe(newId);
    await expectCode(service.getBackup(alice, oldId), 'E2EE_NOT_FOUND');
    expect(store.objects.size).toBe(1);
    expect(repo.chunks.map((chunk) => chunk.backup_id)).toEqual([newId]);
  });

  it('keeps at most one pending generation per profile', async () => {
    const first = hex(16);
    await service.createBackup(alice, {
      backup_id: first,
      envelope: envelope(),
      device_key: aliceDevice.device_key
    });
    await service.appendChunk(alice, first, {
      device_key: aliceDevice.device_key,
      data: chunkOf()
    });
    const second = hex(16);
    await service.createBackup(alice, {
      backup_id: second,
      envelope: envelope(),
      device_key: aliceDevice.device_key
    });
    await expectCode(service.getBackup(alice, first), 'E2EE_NOT_FOUND');
    expect(store.objects.size).toBe(0);
    await expectCode(
      service.createBackup(alice, {
        backup_id: second,
        envelope: envelope(),
        device_key: aliceDevice.device_key
      }),
      'E2EE_BAD_REQUEST'
    );
  });

  it('compacts: deletes chunks up to through_seq and their objects', async () => {
    const backupId = await activeBackup();
    for (let i = 0; i < 5; i++) {
      await service.appendChunk(alice, backupId, {
        device_key: aliceDevice.device_key,
        data: chunkOf()
      });
    }
    const compacted = await service.compact(alice, backupId, {
      device_key: aliceDevice.device_key,
      through_seq: 3
    });
    expect(compacted).toMatchObject({
      chunk_count: 2,
      size: 8 * KIB,
      next_seq: 6
    });
    const page = await service.listChunks(alice, backupId, {});
    expect(page.items.map((item) => item.seq)).toEqual([4, 5]);
    expect(store.objects.size).toBe(2);
    await expectCode(
      service.compact(alice, backupId, {
        device_key: aliceDevice.device_key,
        through_seq: 6
      }),
      'E2EE_BAD_REQUEST'
    );
  });

  it('deletes everything (idempotently) so no recovery code opens anything', async () => {
    const backupId = await activeBackup();
    await service.appendChunk(alice, backupId, {
      device_key: aliceDevice.device_key,
      data: chunkOf()
    });
    const pendingId = hex(16);
    await service.createBackup(alice, {
      backup_id: pendingId,
      envelope: envelope(),
      device_key: aliceDevice.device_key
    });
    const bobBackup = await activeBackup(bob, bobDevice);
    await service.appendChunk(bob, bobBackup, {
      device_key: bobDevice.device_key,
      data: chunkOf()
    });
    await service.deleteAll(alice);
    expect(await service.getStatus(alice)).toMatchObject({
      backup: null,
      used_bytes: 0
    });
    await expectCode(service.getBackup(alice, backupId), 'E2EE_NOT_FOUND');
    await expectCode(service.getBackup(alice, pendingId), 'E2EE_NOT_FOUND');
    expect(await service.deleteAll(alice)).toEqual({});
    // Bob is untouched.
    expect(store.objects.size).toBe(1);
    expect((await service.getStatus(bob)).backup?.chunk_count).toBe(1);
  });

  it('prunes abandoned pending generations on the next create', async () => {
    const stale = hex(16);
    await service.createBackup(bob, {
      backup_id: stale,
      envelope: envelope(),
      device_key: bobDevice.device_key
    });
    await service.appendChunk(bob, stale, {
      device_key: bobDevice.device_key,
      data: chunkOf()
    });
    now += E2EE_BACKUP_PENDING_TTL_MS + 1;
    await activeBackup();
    await expectCode(service.getBackup(bob, stale), 'E2EE_NOT_FOUND');
    expect(store.objects.size).toBe(0);
  });

  it('rate limits chunk uploads per profile', async () => {
    const backupId = await activeBackup();
    counters.set(`bkchunk:${alice}`, 3000);
    await expectCode(
      service.appendChunk(alice, backupId, {
        device_key: aliceDevice.device_key,
        data: chunkOf()
      }),
      'E2EE_RATE_LIMITED'
    );
  });

  it('refuses every route while the kill switch is off', async () => {
    const backupId = await activeBackup();
    enabled = false;
    await expectCode(service.getStatus(alice), 'E2EE_BACKUPS_DISABLED');
    await expectCode(
      service.appendChunk(alice, backupId, {
        device_key: aliceDevice.device_key,
        data: chunkOf()
      }),
      'E2EE_BACKUPS_DISABLED'
    );
    await expectCode(service.deleteAll(alice), 'E2EE_BACKUPS_DISABLED');
  });

  it('stores only the opaque bytes it was given', async () => {
    const backupId = await activeBackup();
    const data = chunkOf();
    await service.appendChunk(alice, backupId, {
      device_key: aliceDevice.device_key,
      data
    });
    expect(
      Array.from(store.objects.values()).map((v) => v.toString('base64'))
    ).toEqual([data]);
    const row = repo.chunks[0];
    expect(Object.keys(row).sort((a, b) => a.localeCompare(b))).toEqual([
      'backup_id',
      'created_at',
      'object_key',
      'profile_id',
      'seq',
      'size',
      'uploader_device_key'
    ]);
  });
});
