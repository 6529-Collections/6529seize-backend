import 'reflect-metadata';
import { DROP_MEDIA_UPLOADS_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { DropMediaUploadsDb } from './drop-media-uploads.db';

function upload(id: string, status: string) {
  return {
    id,
    profile_id: 'author',
    source: 'drop',
    public_key: `drops/${id}/${id}.jpg`,
    public_url: `https://cdn.example/drops/${id}/${id}.jpg`,
    ingest_bucket: 'ingest',
    ingest_key: `staging/drop-media-ingest/drops/${id}.jpg`,
    s3_upload_id: `session-${id}`,
    declared_mime_type: 'image/jpeg',
    status,
    error_reason: null,
    drop_id: null,
    wave_id: null,
    created_at: 1,
    updated_at: 1,
    completed_at: null
  };
}

describeWithSeed(
  'DropMediaUploadsDb sanitizer enqueue claim',
  {
    table: DROP_MEDIA_UPLOADS_TABLE,
    rows: [upload('processing', 'processing'), upload('ready', 'ready')]
  },
  () => {
    const db = new DropMediaUploadsDb(() => sqlExecutor);

    it('lets exactly one completion claim the message of a processing upload', async () => {
      const claims = await Promise.all(
        [10, 11, 12].map((claimedAt) =>
          db.claimSanitizerEnqueue({ id: 'processing', claimedAt })
        )
      );

      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(
        await db.claimSanitizerEnqueue({ id: 'processing', claimedAt: 13 })
      ).toBe(false);
      expect(
        await db.claimSanitizerEnqueue({ id: 'ready', claimedAt: 13 })
      ).toBe(false);
    });

    it('gives a claim back only to its own claimant', async () => {
      await db.claimSanitizerEnqueue({ id: 'processing', claimedAt: 10 });

      await db.releaseSanitizerEnqueue({ id: 'processing', claimedAt: 99 });
      expect(
        await db.claimSanitizerEnqueue({ id: 'processing', claimedAt: 11 })
      ).toBe(false);

      await db.releaseSanitizerEnqueue({ id: 'processing', claimedAt: 10 });
      expect(
        await db.claimSanitizerEnqueue({ id: 'processing', claimedAt: 12 })
      ).toBe(true);
      expect((await db.findById('processing'))?.sanitizer_enqueued_at).toBe(12);
    });
  }
);
