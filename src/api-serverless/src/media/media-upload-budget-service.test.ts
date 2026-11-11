import {
  DEFAULT_MEDIA_UPLOAD_BUDGET,
  MEDIA_UPLOAD_BUDGET_EXCEEDED,
  MEDIA_UPLOAD_BUDGET_WINDOW_MS,
  maxUploadBytes,
  mediaUploadBudgetLimitsFrom,
  MediaUploadBudgetService,
  ObjectSizeReader
} from './media-upload-budget.service';
import {
  MediaUploadBudgetEntryEntity,
  MediaUploadBudgetSource
} from '@/entities/IMediaUploadBudget';
import { MediaUploadBudgetDb } from '@/media/media-upload-budget.db';
import { Time } from '@/time';

const NOW = 10 * MEDIA_UPLOAD_BUDGET_WINDOW_MS;
const MIB = 1024 * 1024;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** The budget table in memory, with the same window and pending semantics. */
function fakeDb(entries: MediaUploadBudgetEntryEntity[] = []) {
  const calls: string[] = [];
  const counted = (profileId: string, since: number) =>
    entries.filter(
      (it) => it.profile_id === profileId && it.created_at > since
    );
  const db = {
    executeNativeQueriesInTransaction: jest.fn(async (fn) => fn('tx')),
    lockProfile: jest.fn(async (profileId: string, connection: unknown) => {
      calls.push(`lock ${profileId} ${String(connection)}`);
      return profileId !== 'no-profile-row';
    }),
    usageSince: jest.fn(async (profileId: string, since: number) => {
      calls.push('usage');
      const inWindow = counted(profileId, since);
      return {
        uploads: inWindow.length,
        bytes: inWindow.reduce(
          (sum, it) => sum + (it.size_bytes ?? it.reserved_bytes),
          0
        ),
        oldestAt: inWindow.length
          ? Math.min(...inWindow.map((it) => it.created_at))
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
    markSizeChecked: jest.fn(
      async (id: string, _profile: string, checkedAt: number) => {
        const entry = entries.find((it) => it.id === id);
        if (entry) Object.assign(entry, { size_checked_at: checkedAt });
      }
    ),
    findPendingSizes: jest.fn(
      async ({
        profileId,
        sinceMs,
        createdBefore,
        checkedBefore,
        limit
      }: {
        profileId: string;
        sinceMs: number;
        createdBefore: number;
        checkedBefore: number;
        limit: number;
      }) =>
        counted(profileId, sinceMs)
          .filter(
            (it) =>
              it.created_at < createdBefore &&
              it.pending_object_key !== null &&
              (it.size_checked_at === null ||
                it.size_checked_at < checkedBefore)
          )
          .slice(0, limit)
          .map((it) => ({
            id: it.id,
            source: it.source,
            pending_object_key: it.pending_object_key!,
            created_at: it.created_at
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
  {
    pendingObjectKey = size === null ? `drops/${id}/${id}.mp4` : null,
    reserved = 500 * MIB,
    source = MediaUploadBudgetSource.DROP
  }: {
    pendingObjectKey?: string | null;
    reserved?: number;
    source?: MediaUploadBudgetSource;
  } = {}
): MediaUploadBudgetEntryEntity {
  return {
    id,
    profile_id: 'profile',
    source,
    created_at: createdAt,
    size_bytes: size,
    reserved_bytes: reserved,
    pending_object_key: pendingObjectKey,
    size_checked_at: null
  };
}

function readers(read: ObjectSizeReader) {
  return {
    [MediaUploadBudgetSource.DROP]: read,
    [MediaUploadBudgetSource.WAVE]: read,
    [MediaUploadBudgetSource.ATTACHMENT]: read
  };
}

function service(
  db: ReturnType<typeof fakeDb>['db'],
  {
    limits = { uploadsPerDay: 3, bytesPerDay: 2048 * MIB },
    random = () => 0.5,
    read = jest.fn(async (): Promise<never> => {
      throw new Error('no reads expected');
    }) as ObjectSizeReader
  }: {
    limits?: { uploadsPerDay: number; bytesPerDay: number };
    random?: () => number;
    read?: ObjectSizeReader;
  } = {}
) {
  return new MediaUploadBudgetService(
    db as unknown as MediaUploadBudgetDb,
    () => limits,
    random,
    readers(read)
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
      objectKey: `drops/${id}/${id}.mp4`,
      contentType: 'video/mp4',
      ...extra
    });

  it('counts a prepared upload at the largest size of its kind, pending at its key', async () => {
    const { db, entries, calls } = fakeDb();

    await reserve(service(db), 'upload-1', {
      source: MediaUploadBudgetSource.ATTACHMENT,
      objectKey: 'test/attachments/incoming/a/original.pdf',
      contentType: 'application/pdf'
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
        reserved_bytes: 25 * MIB,
        pending_object_key: 'test/attachments/incoming/a/original.pdf',
        size_checked_at: null
      }
    ]);
  });

  it('refuses a profile id without a profiles row before counting anything', async () => {
    const { db, entries } = fakeDb();

    const error = await reserve(service(db), 'new', {
      profileId: 'no-profile-row'
    }).catch((e) => e);

    expect(error.getStatusCode()).toBe(403);
    expect(db.usageSince).not.toHaveBeenCalled();
    expect(entries).toEqual([]);
  });

  it('refuses the upload past the daily count with 429 and when it frees up', async () => {
    const { db, entries } = fakeDb([
      entry('expired', NOW - MEDIA_UPLOAD_BUDGET_WINDOW_MS, 1),
      entry('a', NOW - 3 * HOUR, 1),
      entry('b', NOW - HOUR, 1),
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

  it('refuses an upload whose largest size would exceed the bytes left', async () => {
    // 1600 MiB recorded + 500 MiB reserved for a new video > 2048 MiB.
    const { db } = fakeDb([entry('a', NOW - 1000, 1600 * MIB)]);

    const video = await reserve(service(db)).catch((e) => e);
    expect(video.getStatusCode()).toBe(429);
    expect(video.message).toBe(
      'Upload limit reached: at most 2 GiB per 24 hours'
    );
    expect(video.details).toMatchObject({
      limit: 'bytes',
      max_bytes: 2048 * MIB
    });

    // A 256 MiB image still fits.
    await expect(
      reserve(service(db), 'image', { contentType: 'image/png' })
    ).resolves.toBeUndefined();
  });

  it('counts uploads whose size is unknown at their reserved bytes', async () => {
    const { db } = fakeDb([
      entry('in-progress', NOW - MINUTE, null, { reserved: 1600 * MIB })
    ]);

    const error = await reserve(service(db)).catch((e) => e);

    expect(error.details).toMatchObject({ limit: 'bytes' });
  });

  describe('settling pending sizes', () => {
    it('records a size read from the stored object', async () => {
      const { db, entries } = fakeDb([entry('stored', NOW - HOUR, null)]);
      const read = jest.fn(async () => ({
        exists: true as const,
        bytes: 42 * MIB
      }));

      await reserve(service(db, { read }));

      expect(read).toHaveBeenCalledWith('drops/stored/stored.mp4');
      expect(entries[0]).toMatchObject({
        size_bytes: 42 * MIB,
        pending_object_key: null
      });
    });

    it('settles a missing object at 0 only once its upload can no longer be in progress', async () => {
      const { db, entries } = fakeDb([
        entry('recent-missing', NOW - HOUR, null),
        entry('old-missing', NOW - 3 * HOUR, null)
      ]);
      const read = jest.fn(async () => ({ exists: false as const }));

      await reserve(service(db, { read }));

      expect(entries.find((it) => it.id === 'old-missing')).toMatchObject({
        size_bytes: 0,
        pending_object_key: null
      });
      expect(entries.find((it) => it.id === 'recent-missing')).toMatchObject({
        size_bytes: null,
        pending_object_key: 'drops/recent-missing/recent-missing.mp4',
        size_checked_at: NOW
      });
    });

    it.each([
      [
        'forbidden',
        Object.assign(new Error('Forbidden'), {
          $metadata: { httpStatusCode: 403 }
        })
      ],
      [
        'throttled',
        Object.assign(new Error('SlowDown'), {
          $metadata: { httpStatusCode: 503 }
        })
      ],
      ['unreachable', new Error('socket hang up')]
    ])(
      'leaves an entry pending and counted at its reserved bytes when the read is %s',
      async (_, failure) => {
        const { db, entries } = fakeDb([
          entry('unreadable', NOW - 3 * HOUR, null, { reserved: 1600 * MIB })
        ]);
        const read = jest.fn(async (): Promise<never> => {
          throw failure;
        });

        const error = await reserve(service(db, { read })).catch((e) => e);

        expect(entries[0]).toMatchObject({
          size_bytes: null,
          pending_object_key: 'drops/unreadable/unreadable.mp4',
          size_checked_at: NOW
        });
        // 1600 MiB still counted: a new 500 MiB video does not fit.
        expect(error.details).toMatchObject({ limit: 'bytes' });
      }
    );

    it('reads an unsettled entry again only after the recheck interval', async () => {
      const { db } = fakeDb([entry('unreadable', NOW - 3 * HOUR, null)]);
      const read = jest.fn(async (): Promise<never> => {
        throw new Error('socket hang up');
      });
      const budget = service(db, {
        read,
        limits: { uploadsPerDay: 10, bytesPerDay: 100 * 1024 * MIB }
      });

      await reserve(budget, 'first');
      jest.mocked(Time.currentMillis).mockReturnValue(NOW + 5 * MINUTE);
      await reserve(budget, 'second');
      expect(read).toHaveBeenCalledTimes(1);

      jest.mocked(Time.currentMillis).mockReturnValue(NOW + 11 * MINUTE);
      await reserve(budget, 'third');
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('does not read uploads that may still be in progress', async () => {
      const { db } = fakeDb([entry('fresh', NOW - 10 * MINUTE, null)]);
      const read = jest.fn();

      await reserve(service(db, { read }));

      expect(read).not.toHaveBeenCalled();
    });

    it('uses the reader of the entry source', async () => {
      const { db } = fakeDb([
        entry('attachment', NOW - HOUR, null, {
          source: MediaUploadBudgetSource.ATTACHMENT,
          pendingObjectKey: 'test/attachments/incoming/x/original.csv'
        })
      ]);
      const drop = jest.fn();
      const attachment = jest.fn(async () => ({
        exists: true as const,
        bytes: 7
      }));
      const budget = new MediaUploadBudgetService(
        db as unknown as MediaUploadBudgetDb,
        () => ({ uploadsPerDay: 10, bytesPerDay: 10 * 1024 * MIB }),
        () => 0.5,
        {
          [MediaUploadBudgetSource.DROP]: drop,
          [MediaUploadBudgetSource.WAVE]: drop,
          [MediaUploadBudgetSource.ATTACHMENT]: attachment
        }
      );

      await reserve(budget);

      expect(attachment).toHaveBeenCalledWith(
        'test/attachments/incoming/x/original.csv'
      );
      expect(drop).not.toHaveBeenCalled();
    });

    it('still reserves when listing pending entries fails', async () => {
      const { db, entries } = fakeDb();
      db.findPendingSizes.mockRejectedValue(new Error('db down'));

      await reserve(service(db));

      expect(entries.map((it) => it.id)).toEqual(['new']);
    });
  });

  it('records sizes and releases reservations without failing the caller', async () => {
    const { db, entries } = fakeDb([entry('a', NOW, null)]);
    const budget = service(db);

    await budget.recordSize('a', 'profile', 42);
    expect(entries[0]).toMatchObject({
      size_bytes: 42,
      pending_object_key: null
    });
    await budget.release('a', 'profile');
    expect(entries).toEqual([]);

    db.recordSize.mockRejectedValue(new Error('db down'));
    db.delete.mockRejectedValue(new Error('db down'));
    await expect(budget.recordSize('a', 'profile', 1)).resolves.toBe(undefined);
    await expect(budget.release('a', 'profile')).resolves.toBe(undefined);
  });

  it('occasionally prunes entries older than two windows', async () => {
    const { db } = fakeDb();

    await reserve(service(db, { random: () => 0.5 }), 'kept');
    expect(db.deleteOlderThan).not.toHaveBeenCalled();
    await reserve(service(db, { random: () => 0 }), 'pruning');
    expect(db.deleteOlderThan).toHaveBeenCalledWith(
      NOW - 2 * MEDIA_UPLOAD_BUDGET_WINDOW_MS,
      1000
    );
  });
});

describe('maxUploadBytes', () => {
  it('is the largest upload allowed for each kind', () => {
    expect(maxUploadBytes(MediaUploadBudgetSource.DROP, 'video/mp4')).toBe(
      500 * MIB
    );
    expect(maxUploadBytes(MediaUploadBudgetSource.WAVE, 'image/png')).toBe(
      256 * MIB
    );
    expect(
      maxUploadBytes(MediaUploadBudgetSource.ATTACHMENT, 'application/pdf')
    ).toBe(25 * MIB);
    expect(maxUploadBytes(MediaUploadBudgetSource.ATTACHMENT, 'text/csv')).toBe(
      50 * MIB
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
