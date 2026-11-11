import {
  DEFAULT_MEDIA_UPLOAD_BUDGET,
  MEDIA_UPLOAD_BUDGET_EXCEEDED,
  MEDIA_UPLOAD_BUDGET_WINDOW_MS,
  mediaUploadBudgetLimitsFrom,
  MediaUploadBudgetService
} from './media-upload-budget.service';
import {
  MediaUploadBudgetEntryEntity,
  MediaUploadBudgetSource
} from '@/entities/IMediaUploadBudget';
import { MediaUploadBudgetDb } from '@/media/media-upload-budget.db';
import { Time } from '@/time';

const NOW = 10 * MEDIA_UPLOAD_BUDGET_WINDOW_MS;
const MIB = 1024 * 1024;

/** The budget table in memory, with the same window semantics. */
function fakeDb(entries: MediaUploadBudgetEntryEntity[] = []) {
  const calls: string[] = [];
  const db = {
    executeNativeQueriesInTransaction: jest.fn(async (fn) => fn('tx')),
    lockProfile: jest.fn(async (profileId: string, connection: unknown) => {
      calls.push(`lock ${profileId} ${String(connection)}`);
    }),
    usageSince: jest.fn(async (profileId: string, since: number) => {
      calls.push('usage');
      const counted = entries.filter(
        (it) => it.profile_id === profileId && it.created_at > since
      );
      return {
        uploads: counted.length,
        bytes: counted.reduce((sum, it) => sum + (it.size_bytes ?? 0), 0),
        oldestAt: counted.length
          ? Math.min(...counted.map((it) => it.created_at))
          : null
      };
    }),
    insert: jest.fn(async (entry: MediaUploadBudgetEntryEntity) => {
      calls.push('insert');
      entries.push(entry);
    }),
    delete: jest.fn(async (id: string) => {
      entries.splice(
        entries.findIndex((it) => it.id === id),
        1
      );
    }),
    recordSize: jest.fn(async (id: string, _profile: string, size: number) => {
      const entry = entries.find((it) => it.id === id);
      if (entry)
        Object.assign(entry, { size_bytes: size, pending_object_key: null });
    }),
    findPendingSizes: jest.fn(
      async (profileId: string, since: number, before: number) =>
        entries
          .filter(
            (it) =>
              it.profile_id === profileId &&
              it.created_at > since &&
              it.created_at < before &&
              it.pending_object_key !== null
          )
          .map((it) => ({
            id: it.id,
            pending_object_key: it.pending_object_key!
          }))
    ),
    deleteOlderThan: jest.fn(async () => 0)
  };
  return { db, entries, calls };
}

function entry(
  id: string,
  createdAt: number,
  size: number | null,
  pendingObjectKey: string | null = null
): MediaUploadBudgetEntryEntity {
  return {
    id,
    profile_id: 'profile',
    source: MediaUploadBudgetSource.DROP,
    created_at: createdAt,
    size_bytes: size,
    pending_object_key: pendingObjectKey
  };
}

function service(
  db: ReturnType<typeof fakeDb>['db'],
  limits = { uploadsPerDay: 3, bytesPerDay: 100 * MIB },
  random = () => 0.5
) {
  return new MediaUploadBudgetService(
    db as unknown as MediaUploadBudgetDb,
    () => limits,
    random
  );
}

describe('MediaUploadBudgetService', () => {
  beforeEach(() => {
    jest.spyOn(Time, 'currentMillis').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  const reserve = (
    budget: MediaUploadBudgetService,
    id = 'new',
    extra: Partial<Parameters<MediaUploadBudgetService['reserve']>[0]> = {}
  ) =>
    budget.reserve({
      id,
      profileId: 'profile',
      source: MediaUploadBudgetSource.DROP,
      ...extra
    });

  it('counts a prepared upload under the profile lock', async () => {
    const { db, entries, calls } = fakeDb();

    await reserve(service(db), 'upload-1', {
      source: MediaUploadBudgetSource.ATTACHMENT
    });

    expect(calls).toEqual(['lock profile tx', 'usage', 'insert']);
    expect(db.insert).toHaveBeenCalledWith(expect.anything(), 'tx');
    expect(entries).toEqual([
      {
        id: 'upload-1',
        profile_id: 'profile',
        source: 'attachment',
        created_at: NOW,
        size_bytes: null,
        pending_object_key: null
      }
    ]);
  });

  it('refuses the upload past the daily count with 429 and when it frees up', async () => {
    const { db, entries } = fakeDb([
      entry('expired', NOW - MEDIA_UPLOAD_BUDGET_WINDOW_MS, 1),
      entry('a', NOW - 3 * 60 * 60 * 1000, 1),
      entry('b', NOW - 60 * 60 * 1000, 1),
      entry('c', NOW - 1000, 1)
    ]);

    const error = await reserve(service(db)).catch((e) => e);

    expect(error.getStatusCode()).toBe(429);
    expect(error.code).toBe(MEDIA_UPLOAD_BUDGET_EXCEEDED);
    expect(error.message).toBe(
      'Upload limit reached: at most 3 uploads per 24 hours'
    );
    expect(error.details).toEqual({
      limit: 'uploads',
      max_uploads: 3,
      window_hours: 24,
      retry_after_seconds: 21 * 60 * 60
    });
    expect(entries.map((it) => it.id)).not.toContain('new');
  });

  it('refuses new uploads once the stored bytes reach the daily budget', async () => {
    const { db } = fakeDb([entry('a', NOW - 1000, 100 * MIB)]);

    const error = await reserve(service(db)).catch((e) => e);

    expect(error.getStatusCode()).toBe(429);
    expect(error.message).toBe(
      'Upload limit reached: at most 100 MiB per 24 hours'
    );
    expect(error.details).toMatchObject({
      limit: 'bytes',
      max_bytes: 100 * MIB
    });
  });

  it('reads settled single-PUT sizes before checking the bytes', async () => {
    const settled = NOW - 60 * 60 * 1000;
    const { db, entries } = fakeDb([
      entry('settled', settled, null, 'drops/settled/settled.mp4'),
      entry('missing', settled, null, 'drops/missing/missing.mp4'),
      entry('fresh', NOW - 60 * 1000, null, 'drops/fresh/fresh.mp4')
    ]);
    const readObjectSize = jest.fn(async (key: string) =>
      key.includes('settled') ? 100 * MIB : null
    );

    const error = await reserve(
      service(db, { uploadsPerDay: 10, bytesPerDay: 100 * MIB }),
      'new',
      { readObjectSize }
    ).catch((e) => e);

    // A URL still in use is not read yet; a never-used one counts nothing.
    expect(readObjectSize.mock.calls.map(([key]) => key)).toEqual([
      'drops/settled/settled.mp4',
      'drops/missing/missing.mp4'
    ]);
    expect(entries.map((it) => [it.id, it.size_bytes])).toEqual([
      ['settled', 100 * MIB],
      ['missing', 0],
      ['fresh', null]
    ]);
    expect(error.details).toMatchObject({ limit: 'bytes' });
  });

  it('still reserves when settling sizes fails', async () => {
    const { db, entries } = fakeDb([
      entry('settled', NOW - 60 * 60 * 1000, null, 'drops/a/a.mp4')
    ]);

    await reserve(service(db), 'new', {
      readObjectSize: jest.fn().mockRejectedValue(new Error('S3 down'))
    });

    expect(entries.map((it) => it.id)).toEqual(['settled', 'new']);
  });

  it('records sizes and releases reservations without failing the caller', async () => {
    const { db, entries } = fakeDb([entry('a', NOW, null)]);
    const budget = service(db);

    await budget.recordSize('a', 'profile', 42);
    expect(entries[0].size_bytes).toBe(42);
    await budget.release('a', 'profile');
    expect(entries).toEqual([]);

    db.recordSize.mockRejectedValue(new Error('db down'));
    db.delete.mockRejectedValue(new Error('db down'));
    await expect(budget.recordSize('a', 'profile', 1)).resolves.toBe(undefined);
    await expect(budget.release('a', 'profile')).resolves.toBe(undefined);
  });

  it('occasionally prunes entries older than two windows', async () => {
    const { db } = fakeDb();

    await reserve(
      service(db, undefined, () => 0.5),
      'kept'
    );
    expect(db.deleteOlderThan).not.toHaveBeenCalled();
    await reserve(
      service(db, undefined, () => 0),
      'pruning'
    );
    expect(db.deleteOlderThan).toHaveBeenCalledWith(
      NOW - 2 * MEDIA_UPLOAD_BUDGET_WINDOW_MS,
      1000
    );
  });
});

describe('mediaUploadBudgetLimitsFrom', () => {
  it('uses generous defaults and ignores invalid settings', () => {
    expect(DEFAULT_MEDIA_UPLOAD_BUDGET).toEqual({
      uploadsPerDay: 500,
      bytesPerDay: 20 * 1024 * MIB
    });
    expect(mediaUploadBudgetLimitsFrom({})).toEqual(
      DEFAULT_MEDIA_UPLOAD_BUDGET
    );
    expect(
      mediaUploadBudgetLimitsFrom({
        MEDIA_UPLOAD_BUDGET_UPLOADS_PER_DAY: '0',
        MEDIA_UPLOAD_BUDGET_BYTES_PER_DAY: 'lots'
      })
    ).toEqual(DEFAULT_MEDIA_UPLOAD_BUDGET);
  });

  it('reads configured limits', () => {
    expect(
      mediaUploadBudgetLimitsFrom({
        MEDIA_UPLOAD_BUDGET_UPLOADS_PER_DAY: '50',
        MEDIA_UPLOAD_BUDGET_BYTES_PER_DAY: String(5 * 1024 * MIB)
      })
    ).toEqual({ uploadsPerDay: 50, bytesPerDay: 5 * 1024 * MIB });
  });
});
