import 'reflect-metadata';
import { MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import {
  MEDIA_UPLOAD_BUDGET_WINDOW_MS,
  MediaUploadBudgetService
} from '@/api/media/media-upload-budget.service';
import { MediaUploadBudgetSource } from '@/entities/IMediaUploadBudget';
import { Time } from '@/time';
import { MediaUploadBudgetDb } from './media-upload-budget.db';

const NOW = 100 * MEDIA_UPLOAD_BUDGET_WINDOW_MS;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function row(
  id: string,
  createdAt: number,
  size: number | null,
  {
    pendingKey = null,
    profileId = 'uploader',
    reserved = 0,
    checkedAt = null
  }: {
    pendingKey?: string | null;
    profileId?: string;
    reserved?: number;
    checkedAt?: number | null;
  } = {}
) {
  return {
    id,
    profile_id: profileId,
    source: 'drop',
    created_at: createdAt,
    size_bytes: size,
    reserved_bytes: reserved,
    pending_object_key: pendingKey,
    size_checked_at: checkedAt
  };
}

describeWithSeed(
  'MediaUploadBudgetDb',
  [
    withProfiles([
      aProfile({
        external_id: 'uploader',
        handle: 'uploader',
        primary_wallet: '0x0000000000000000000000000000000000000001'
      })
    ]),
    {
      table: MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE,
      rows: [
        row('expired', NOW - MEDIA_UPLOAD_BUDGET_WINDOW_MS, 1000),
        row('old', NOW - 3 * MEDIA_UPLOAD_BUDGET_WINDOW_MS, 1000),
        row('sized', NOW - 2 * HOUR, 300, { reserved: 9999 }),
        row('pending', NOW - HOUR, null, {
          pendingKey: 'drops/p/p.mp4',
          reserved: 500
        }),
        row('checked-pending', NOW - 2 * HOUR, null, {
          pendingKey: 'drops/c/c.mp4',
          reserved: 40,
          checkedAt: NOW - 5 * MINUTE
        }),
        row('recent-pending', NOW - MINUTE, null, {
          pendingKey: 'drops/r/r.mp4',
          reserved: 7
        }),
        row('other-profile', NOW - HOUR, 5000, { profileId: 'someone-else' })
      ]
    }
  ],
  () => {
    const db = new MediaUploadBudgetDb(() => sqlExecutor);
    const since = NOW - MEDIA_UPLOAD_BUDGET_WINDOW_MS;

    it('sums recorded sizes and the reserved bytes of pending uploads in the window', async () => {
      const usage = await sqlExecutor.executeNativeQueriesInTransaction(
        (connection) => db.usageSince('uploader', since, connection)
      );

      expect(usage).toEqual({
        uploads: 4,
        bytes: 300 + 500 + 40 + 7,
        oldestAt: NOW - 2 * HOUR
      });
    });

    it('locks only an existing profile', async () => {
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          expect(await db.lockProfile('uploader', connection)).toBe(true);
          expect(await db.lockProfile('not-a-profile', connection)).toBe(false);
        }
      );
    });

    it('lists pending entries old enough and not recently checked, least recently checked first', async () => {
      const find = (checkedBefore: number, limit = 5) =>
        db.findPendingSizes({
          profileId: 'uploader',
          sinceMs: since,
          createdBefore: NOW - 30 * MINUTE,
          checkedBefore,
          limit
        });

      expect(await find(NOW - 10 * MINUTE)).toEqual([
        {
          id: 'pending',
          source: 'drop',
          pending_object_key: 'drops/p/p.mp4',
          created_at: NOW - HOUR
        }
      ]);
      expect((await find(NOW)).map((it) => it.id)).toEqual([
        'pending',
        'checked-pending'
      ]);
      expect((await find(NOW, 1)).map((it) => it.id)).toEqual(['pending']);
    });

    it('records a size once and keeps an unsettled entry pending with its check time', async () => {
      await db.recordSize('pending', 'uploader', 700);
      await db.recordSize('pending', 'someone-else', 1);
      await db.markSizeChecked('recent-pending', 'uploader', NOW);
      await db.markSizeChecked('pending', 'uploader', NOW);

      expect(
        await sqlExecutor.execute(
          `select id, size_bytes, pending_object_key, size_checked_at
           from ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE}
           where id in ('pending', 'recent-pending') order by id`
        )
      ).toEqual([
        {
          id: 'pending',
          size_bytes: 700,
          pending_object_key: null,
          size_checked_at: null
        },
        {
          id: 'recent-pending',
          size_bytes: null,
          pending_object_key: 'drops/r/r.mp4',
          size_checked_at: NOW
        }
      ]);
    });

    it('prunes only entries older than the cutoff', async () => {
      expect(
        await db.deleteOlderThan(NOW - 2 * MEDIA_UPLOAD_BUDGET_WINDOW_MS, 1000)
      ).toBe(1);
      const ids = (
        await sqlExecutor.execute<{ id: string }>(
          `select id from ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE} order by id`
        )
      ).map((it) => it.id);
      expect(ids).not.toContain('old');
      expect(ids).toContain('expired');
    });

    it('admits concurrent preparations only up to the daily count', async () => {
      jest.spyOn(Time, 'currentMillis').mockReturnValue(NOW);
      const unreadable = jest.fn(async (): Promise<never> => {
        throw new Error('not read in this test');
      });
      try {
        // Four uploads already count; one more fits.
        const budget = new MediaUploadBudgetService(
          db,
          () => ({ uploadsPerDay: 5, bytesPerDay: 1024 ** 4 }),
          () => 0.5,
          {
            [MediaUploadBudgetSource.DROP]: unreadable,
            [MediaUploadBudgetSource.WAVE]: unreadable,
            [MediaUploadBudgetSource.ATTACHMENT]: unreadable
          }
        );
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, (_, index) =>
            budget.reserve({
              id: `concurrent-${index}`,
              profileId: 'uploader',
              source: MediaUploadBudgetSource.DROP,
              objectKey: `drops/concurrent-${index}/c.mp4`,
              contentType: 'video/mp4'
            })
          )
        );

        expect(
          results.filter((result) => result.status === 'fulfilled')
        ).toHaveLength(1);
        const refused = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected'
        );
        expect(refused).toHaveLength(5);
        for (const { reason } of refused)
          expect(reason.getStatusCode()).toBe(429);
      } finally {
        jest.restoreAllMocks();
      }
    });

    it('refuses a reservation for an id without a profiles row', async () => {
      jest.spyOn(Time, 'currentMillis').mockReturnValue(NOW);
      try {
        const budget = new MediaUploadBudgetService(db, undefined, () => 0.5);

        const error = await budget
          .reserve({
            id: 'orphan',
            profileId: 'not-a-profile',
            source: MediaUploadBudgetSource.WAVE,
            objectKey: 'waves/author_x/orphan.png',
            contentType: 'image/png'
          })
          .catch((e) => e);

        expect(error.getStatusCode()).toBe(403);
        expect(
          await sqlExecutor.execute(
            `select id from ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE} where id = 'orphan'`
          )
        ).toEqual([]);
      } finally {
        jest.restoreAllMocks();
      }
    });
  }
);
