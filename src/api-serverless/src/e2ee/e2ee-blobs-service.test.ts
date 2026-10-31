import { randomBytes } from 'node:crypto';
import { E2eeBlobsService } from '@/api/e2ee/e2ee-blobs.service';
import { E2eeServiceDeps } from '@/api/e2ee/e2ee-context';
import { E2EE_BLOB_QUOTA } from '@/e2ee/e2ee.constants';
import { E2eeBlobRow } from '@/e2ee/e2ee.db';
import { S3E2eeBlobStore } from '@/e2ee/e2ee-blob-store.s3';
import { createE2eeBlobStores } from '@/e2ee/e2ee-blob-stores';
import { E2eeApiException } from '@/e2ee/e2ee-errors';
import { InMemoryE2eeBlobS3 } from '@/tests/fixtures/e2ee-blob-s3.fixture';

const BUCKET = 'private-bucket';
const PREFIX = 'test/e2ee-blobs';
const S3_ENV = {
  E2EE_BLOB_STORE: 's3',
  E2EE_BLOB_S3_BUCKET: BUCKET,
  E2EE_BLOB_S3_PREFIX: PREFIX
};
const PROFILE = 'profile-1';
const DEVICE = `0x${'d'.repeat(64)}`;
const GROUP = `0x${'9'.repeat(64)}`;
const NOW = 1_800_000_000_000;

async function expectCode(promise: Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(E2eeApiException);
  expect((caught as E2eeApiException).e2eeCode).toBe(code);
}

function setup(env: Record<string, string> = S3_ENV) {
  const blobs = new Map<string, E2eeBlobRow>();
  const chunks = new Map<string, { size: number; data: Buffer }>();
  let usage = { liveBytes: 0, recentBytes: 0 };
  let blobCounter = 0;
  const s3 = new InMemoryE2eeBlobS3(BUCKET);
  const db = {
    getDevice: jest.fn(async () => ({
      device_key: DEVICE,
      profile_id: PROFILE,
      revoked_at: null,
      expires_at_seconds: NOW / 1000 + 86400
    })),
    touchDevice: jest.fn(async () => undefined),
    getCurrentRoster: jest.fn(async () => [{ device_key: DEVICE }]),
    hasRosterHistory: jest.fn(async () => true),
    hitRateCounters: jest.fn(
      async (keys: { key: string }[]) => new Map(keys.map((k) => [k.key, 1]))
    ),
    pruneExpiredBlobs: jest.fn(async () => 0),
    executeNativeQueriesInTransaction: jest.fn(
      async (fn: (connection: unknown) => Promise<unknown>) => fn({})
    ),
    lockProfile: jest.fn(async () => undefined),
    getBlobUsage: jest.fn(async () => usage),
    insertBlob: jest.fn(async (row: E2eeBlobRow) => {
      blobs.set(row.blob_id, row);
    }),
    lockBlob: jest.fn(async (id: string) => blobs.get(id) ?? null),
    getBlob: jest.fn(async (id: string) => blobs.get(id) ?? null),
    getBlobChunkSizes: jest.fn(async (id: string) =>
      Array.from(chunks.entries())
        .filter(([key]) => key.startsWith(`${id}/`))
        .map(([key, chunk]) => ({
          chunk_index: Number(key.split('/')[1]),
          size: chunk.size
        }))
    ),
    markBlobComplete: jest.fn(async (id: string) => {
      blobs.set(id, { ...blobs.get(id)!, complete: true });
    }),
    upsertBlobChunk: jest.fn(
      async (input: {
        blobId: string;
        index: number;
        data: Buffer;
        size?: number;
      }) => {
        chunks.set(`${input.blobId}/${input.index}`, {
          size: input.size ?? input.data.length,
          data: input.data
        });
      }
    ),
    getBlobChunkData: jest.fn(async (id: string, index: number) => {
      const chunk = chunks.get(`${id}/${index}`);
      return chunk ? chunk.data.toString('base64') : null;
    })
  };
  let currentEnv: Record<string, string> = env;
  const deps = {
    db,
    now: () => NOW,
    random: () => 1,
    randomHex: () => `0x${(++blobCounter).toString(16).padStart(32, '0')}`,
    attachmentsEnabled: () => true,
    blobStores: createE2eeBlobStores({
      rows: db,
      env: () => currentEnv,
      s3Client: () => s3
    })
  } as unknown as E2eeServiceDeps;
  const service = new E2eeBlobsService(deps);
  return {
    service,
    db,
    s3,
    blobs,
    chunks,
    setUsage: (next: typeof usage) => {
      usage = next;
    },
    setEnv: (next: Record<string, string>) => {
      currentEnv = next;
    }
  };
}

async function uploadComplete(
  service: E2eeBlobsService,
  parts: readonly Buffer[]
) {
  const blob = await service.createBlob(PROFILE, {
    group: GROUP,
    uploader_device_key: DEVICE,
    size: parts.reduce((sum, part) => sum + part.length, 0),
    chunk_count: parts.length
  });
  for (let index = 0; index < parts.length; index++) {
    await service.putChunk(PROFILE, blob.blob_id, index, {
      data: parts[index].toString('base64')
    });
  }
  return service.completeBlob(PROFILE, blob.blob_id);
}

describe('E2eeBlobsService with S3 storage', () => {
  it('stores chunk bytes in S3, sizes in MySQL, and serves them back', async () => {
    const { service, s3, blobs, chunks } = setup();
    const parts = [randomBytes(32), randomBytes(7)];

    const blob = await uploadComplete(service, parts);

    expect(blobs.get(blob.blob_id)?.storage).toBe('s3');
    expect(chunks.get(`${blob.blob_id}/0`)).toEqual({
      size: 32,
      data: Buffer.alloc(0)
    });
    expect(s3.objects.get(`${PREFIX}/${blob.blob_id}/1`)?.body).toEqual(
      parts[1]
    );
    const chunk = await service.getChunk(PROFILE, blob.blob_id, 1, DEVICE);
    expect(Buffer.from(chunk.data, 'base64')).toEqual(parts[1]);
  });

  it('still enforces the live storage quota', async () => {
    const { service, db, setUsage } = setup();
    setUsage({ liveBytes: E2EE_BLOB_QUOTA.liveBytes - 5, recentBytes: 0 });

    await expectCode(
      service.createBlob(PROFILE, {
        group: GROUP,
        uploader_device_key: DEVICE,
        size: 10,
        chunk_count: 1
      }),
      'E2EE_TOO_LARGE'
    );
    expect(db.insertBlob).not.toHaveBeenCalled();
  });

  it('still enforces the rolling daily quota', async () => {
    const { service, setUsage } = setup();
    setUsage({ liveBytes: 0, recentBytes: E2EE_BLOB_QUOTA.rollingBytes });

    await expectCode(
      service.createBlob(PROFILE, {
        group: GROUP,
        uploader_device_key: DEVICE,
        size: 1,
        chunk_count: 1
      }),
      'E2EE_RATE_LIMITED'
    );
  });

  it('refuses uploads with 503 before counting them when S3 is misconfigured', async () => {
    const { service, db } = setup({ E2EE_BLOB_STORE: 's3' });

    await expectCode(
      service.createBlob(PROFILE, {
        group: GROUP,
        uploader_device_key: DEVICE,
        size: 10,
        chunk_count: 1
      }),
      'E2EE_STORAGE_UNAVAILABLE'
    );
    expect(db.hitRateCounters).not.toHaveBeenCalled();
    expect(db.insertBlob).not.toHaveBeenCalled();
  });

  it('answers 404 for a missing object and for an index beyond the blob', async () => {
    const { service, s3 } = setup();
    const blob = await uploadComplete(service, [randomBytes(4)]);
    s3.objects.clear();
    const reads = s3.commands.length;

    await expectCode(
      service.getChunk(PROFILE, blob.blob_id, 0, DEVICE),
      'E2EE_NOT_FOUND'
    );
    await expectCode(
      service.getChunk(PROFILE, blob.blob_id, 1, DEVICE),
      'E2EE_NOT_FOUND'
    );
    // The out-of-range index never reaches S3.
    expect(s3.commands.length).toBe(reads + 1);
  });

  it('turns S3 failures into 503 and records no chunk', async () => {
    const { service, s3, chunks } = setup();
    const blob = await service.createBlob(PROFILE, {
      group: GROUP,
      uploader_device_key: DEVICE,
      size: 4,
      chunk_count: 1
    });
    s3.failNext = { command: 'PutObject', error: new Error('SlowDown') };

    await expectCode(
      service.putChunk(PROFILE, blob.blob_id, 0, {
        data: randomBytes(4).toString('base64')
      }),
      'E2EE_STORAGE_UNAVAILABLE'
    );
    expect(chunks.size).toBe(0);
  });

  it('keeps existing MySQL blobs on MySQL after the switch', async () => {
    const { service, s3, setEnv } = setup({});
    const part = randomBytes(12);
    const blob = await uploadComplete(service, [part]);
    setEnv(S3_ENV);

    const chunk = await service.getChunk(PROFILE, blob.blob_id, 0, DEVICE);

    expect(Buffer.from(chunk.data, 'base64')).toEqual(part);
    expect(s3.commands).toHaveLength(0);
  });

  it('follows a blob the migration moved between reads', async () => {
    const { service, s3, blobs, chunks, db, setEnv } = setup({});
    const part = randomBytes(12);
    const blob = await uploadComplete(service, [part]);
    const stale = blobs.get(blob.blob_id)!;
    // The migration copies the chunk, switches the row and empties MySQL.
    await new S3E2eeBlobStore(
      { bucket: BUCKET, prefix: PREFIX, region: 'eu-west-1' },
      s3,
      db
    ).putObject(blob.blob_id, 0, part);
    blobs.set(blob.blob_id, { ...stale, storage: 's3' });
    chunks.set(`${blob.blob_id}/0`, { size: 12, data: Buffer.alloc(0) });
    db.getBlob.mockResolvedValueOnce(stale);
    setEnv(S3_ENV);

    const chunk = await service.getChunk(PROFILE, blob.blob_id, 0, DEVICE);

    expect(Buffer.from(chunk.data, 'base64')).toEqual(part);
  });
});
