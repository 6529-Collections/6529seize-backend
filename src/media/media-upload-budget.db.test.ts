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
const HOUR = 60 * 60 * 1000;

function row(
  id: string,
  createdAt: number,
  size: number | null,
  pendingKey: string | null = null,
  profileId = 'uploader'
) {
  return {
    id,
    profile_id: profileId,
    source: 'drop',
    created_at: createdAt,
    size_bytes: size,
    pending_object_key: pendingKey
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
        row('sized', NOW - 2 * HOUR, 300),
        row('pending', NOW - 1 * HOUR, null, 'drops/p/p.mp4'),
        row('recent-pending', NOW - 60 * 1000, null, 'drops/r/r.mp4'),
        row('other-profile', NOW - HOUR, 5000, null, 'someone-else')
      ]
    }
  ],
  () => {
    const db = new MediaUploadBudgetDb(() => sqlExecutor);
    const since = NOW - MEDIA_UPLOAD_BUDGET_WINDOW_MS;

    it('sums one profile’s uploads inside the window', async () => {
      const usage = await sqlExecutor.executeNativeQueriesInTransaction(
        (connection) => db.usageSince('uploader', since, connection)
      );

      expect(usage).toEqual({
        uploads: 3,
        bytes: 300,
        oldestAt: NOW - 2 * HOUR
      });
    });

    it('finds settled single-PUT uploads and records their size once', async () => {
      expect(
        await db.findPendingSizes('uploader', since, NOW - 30 * 60 * 1000, 5)
      ).toEqual([{ id: 'pending', pending_object_key: 'drops/p/p.mp4' }]);

      await db.recordSize('pending', 'uploader', 700);
      await db.recordSize('pending', 'someone-else', 1);

      expect(
        await sqlExecutor.execute(
          `select size_bytes, pending_object_key from ${MEDIA_UPLOAD_BUDGET_ENTRIES_TABLE} where id = 'pending'`
        )
      ).toEqual([{ size_bytes: 700, pending_object_key: null }]);
      expect(await db.findPendingSizes('uploader', since, NOW, 5)).toEqual([
        { id: 'recent-pending', pending_object_key: 'drops/r/r.mp4' }
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
      try {
        // Three uploads already count; two more fit.
        const budget = new MediaUploadBudgetService(
          db,
          () => ({ uploadsPerDay: 5, bytesPerDay: 1024 ** 3 }),
          () => 0.5
        );
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, (_, index) =>
            budget.reserve({
              id: `concurrent-${index}`,
              profileId: 'uploader',
              source: MediaUploadBudgetSource.DROP
            })
          )
        );

        expect(
          results.filter((result) => result.status === 'fulfilled')
        ).toHaveLength(2);
        const refused = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === 'rejected'
        );
        expect(refused).toHaveLength(4);
        for (const { reason } of refused)
          expect(reason.getStatusCode()).toBe(429);
      } finally {
        jest.restoreAllMocks();
      }
    });
  }
);
