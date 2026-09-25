import { NFT_LINKS_TABLE } from '@/constants/db-tables';
import { describeWithSeed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import { NftLinksDb } from '@/nft-links/nft-links.db';
import { Time } from '@/time';

const db = new NftLinksDb(() => sqlExecutor);
const options = {
  canonicalId: 'stalled-preview',
  sourceHash: 'source',
  kind: 'image' as const,
  maxBytes: 200
};
const now = 'unix_timestamp(current_timestamp(3))*1000';
const enqueue = () => db.markMediaPreviewPendingIfNeeded(options, {});
const read = () => db.findByCanonicalId(options.canonicalId, {});
const acquire = () =>
  db.lockMediaPreviewForProcessing(
    {
      canonicalId: options.canonicalId,
      expectedSourceHash: options.sourceHash,
      lockTTL: Time.minutes(2)
    },
    {}
  );

describeWithSeed(
  'Stalled NFT preview recovery',
  {
    table: NFT_LINKS_TABLE,
    rows: [
      {
        canonical_id: options.canonicalId,
        platform: 'OPENSEA',
        last_tried_to_update: 1,
        media_preview_status: 'PENDING',
        media_preview_source_hash: options.sourceHash,
        media_preview_card_url: 'https://example.com/cached.webp',
        media_preview_last_success_at: 1
      }
    ]
  },
  () => {
    it.each(['PENDING', 'PROCESSING'])(
      'recovers abandoned %s once under concurrent metadata refreshes',
      async (status) => {
        const oldWorker = (await acquire())!;
        await sqlExecutor.execute(
          `update ${NFT_LINKS_TABLE} set media_preview_status = :status,
           media_preview_queued_at = ${now} - 660000,
           media_preview_locked_since = ${now} - 660000`,
          { status }
        );
        const results = await Promise.all([enqueue(), enqueue(), enqueue()]);
        expect(results.filter(Boolean)).toHaveLength(1);
        const recovered = (await read())!;
        expect(recovered.media_preview_status).toBe('PENDING');
        expect(Number(recovered.media_preview_queued_at)).toBeGreaterThan(
          Date.now() - 60_000
        );
        expect(recovered.media_preview_locked_since).toBeNull();
        expect(recovered.media_preview_card_url).toBe(
          'https://example.com/cached.webp'
        );
        expect(Number(recovered.media_preview_last_success_at)).toBe(1);
        expect(await enqueue()).toBe(false);
        expect(
          await db.updateMediaPreviewWithFailure(
            {
              canonicalId: options.canonicalId,
              fence: {
                sourceHash: oldWorker.media_preview_source_hash,
                lease: oldWorker.media_preview_error_message
              },
              message: 'Late completion from abandoned worker'
            },
            {}
          )
        ).toBe(false);
        expect(await acquire()).not.toBeNull();
      }
    );

    it.each(['PENDING', 'PROCESSING'])(
      'preserves an active %s lease even when enqueue time is absent',
      async (status) => {
        await acquire();
        await sqlExecutor.execute(
          `update ${NFT_LINKS_TABLE} set media_preview_status = :status`,
          { status }
        );
        const before = await read();
        expect(await enqueue()).toBe(false);
        expect(await read()).toEqual(before);
      }
    );

    it.each(['PENDING', 'PROCESSING'])(
      'does not requeue recently enqueued %s work with an old lease',
      async (status) => {
        await sqlExecutor.execute(
          `update ${NFT_LINKS_TABLE} set media_preview_status = :status,
           media_preview_queued_at = ${now} - 540000,
           media_preview_locked_since = 1`,
          { status }
        );
        const before = await read();
        expect(await enqueue()).toBe(false);
        expect(await read()).toEqual(before);
      }
    );

    it('recovers legacy pending work without timestamps and then throttles retries', async () => {
      expect(await enqueue()).toBe(true);
      expect(await enqueue()).toBe(false);
      expect((await read())?.media_preview_status).toBe('PENDING');
    });

    it('never requeues an unchanged READY preview', async () => {
      await sqlExecutor.execute(
        `update ${NFT_LINKS_TABLE} set media_preview_status = 'READY'`
      );
      const before = await read();
      expect(await enqueue()).toBe(false);
      expect(await read()).toEqual(before);
    });

    it('allows changed sources immediately and records a fresh enqueue time', async () => {
      await acquire();
      expect(
        await db.markMediaPreviewPendingIfNeeded(
          { ...options, sourceHash: 'replacement' },
          {}
        )
      ).toBe(true);
      const row = (await read())!;
      expect(row.media_preview_source_hash).toBe('replacement');
      expect(Number(row.media_preview_queued_at)).toBeGreaterThan(
        Date.now() - 60_000
      );
    });
  }
);
