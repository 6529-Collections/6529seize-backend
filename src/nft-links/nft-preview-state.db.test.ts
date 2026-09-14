import { describeWithSeed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import { NFT_LINKS_TABLE } from '@/constants';
import { NftLinksDb } from './nft-links.db';
import { NftLinkEntity } from '@/entities/INftLink';
import { Time } from '@/time';
import { NftPreviewOversizeError } from './nft-preview-size-policy';
import { mapNftLinkEntityToApiLink } from './nft-link-api.mapper';

const db = new NftLinksDb(() => sqlExecutor);
const options = {
  canonicalId: 'preview-fixture',
  sourceHash: 'a',
  kind: 'image' as const,
  maxBytes: 200
};
const oversize = new NftPreviewOversizeError(
  200,
  271,
  'content-length'
).toStoredMessage();
const read = async () => (await db.findByCanonicalId('preview-fixture', {}))!;
const acquire = async (source = 'a') => {
  const row = await db.lockMediaPreviewForProcessing(
    {
      canonicalId: 'preview-fixture',
      expectedSourceHash: source,
      lockTTL: Time.minutes(2)
    },
    {}
  );
  if (!row) throw new Error('Expected fixture acquisition');
  return {
    sourceHash: row.media_preview_source_hash,
    lease: row.media_preview_error_message
  };
};
const fail = (fence: Awaited<ReturnType<typeof acquire>>, message = oversize) =>
  db.updateMediaPreviewWithFailure(
    { canonicalId: 'preview-fixture', message, fence },
    {}
  );

describeWithSeed(
  'NFT preview cooldown and completion fencing',
  {
    table: NFT_LINKS_TABLE,
    rows: [
      {
        canonical_id: 'preview-fixture',
        platform: 'OPENSEA',
        last_tried_to_update: 1,
        media_preview_status: 'PENDING',
        media_preview_source_hash: 'a',
        media_preview_card_url: 'https://example.com/cached.webp',
        media_preview_last_success_at: 1,
        media_uri: 'https://example.com/original.png'
      }
    ]
  },
  () => {
    afterEach(() => jest.restoreAllMocks());

    it('records the first failure, preserves cache, and atomically suppresses repeat enqueue until expiry', async () => {
      expect(await fail(await acquire())).toBe(true);
      const before = await read();
      expect(before.media_preview_status).toBe('FAILED');
      expect(before.media_preview_error_message).toBe(oversize);
      expect(before.media_preview_card_url).toBe(
        'https://example.com/cached.webp'
      );
      expect(before.media_preview_last_success_at).toBe(1);
      expect(
        await Promise.all([
          db.markMediaPreviewPendingIfNeeded(options, {}),
          db.markMediaPreviewPendingIfNeeded(options, {})
        ])
      ).toEqual([false, false]);
      expect(await read()).toEqual(before);
      await sqlExecutor.execute(
        `update ${NFT_LINKS_TABLE} set media_preview_last_tried_at = unix_timestamp(current_timestamp(3))*1000 - 3600000`
      );
      const results = await Promise.all([
        db.markMediaPreviewPendingIfNeeded(options, {}),
        db.markMediaPreviewPendingIfNeeded(options, {})
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it.each([100, 300])(
      'retries immediately when the observed cap changes to %i',
      async (maxBytes) => {
        await fail(await acquire());
        expect(
          await db.markMediaPreviewPendingIfNeeded({ ...options, maxBytes }, {})
        ).toBe(true);
      }
    );

    it.each(['legacy error', '{}', oversize.replace('/v1', '/v2')])(
      'does not suppress unrecognized state %s',
      async (message) => {
        await fail(await acquire(), message);
        expect(await db.markMediaPreviewPendingIfNeeded(options, {})).toBe(
          true
        );
      }
    );

    it('does not strand a failure with a future or absent timestamp', async () => {
      await fail(await acquire());
      await sqlExecutor.execute(
        `update ${NFT_LINKS_TABLE} set media_preview_last_tried_at = 9007199254740991`
      );
      expect(await db.markMediaPreviewPendingIfNeeded(options, {})).toBe(true);
      await fail(await acquire());
      await sqlExecutor.execute(
        `update ${NFT_LINKS_TABLE} set media_preview_last_tried_at = null`
      );
      expect(await db.markMediaPreviewPendingIfNeeded(options, {})).toBe(true);
    });

    it('fences A→B→A and stale success even when stored acquisition timestamps are equal', async () => {
      const a = await acquire();
      const acquiredAt = (await read()).media_preview_locked_since;
      expect(
        await db.markMediaPreviewPendingIfNeeded(
          { ...options, sourceHash: 'b' },
          {}
        )
      ).toBe(true);
      const b = await acquire('b');
      expect(await db.markMediaPreviewPendingIfNeeded(options, {})).toBe(true);
      const again = await acquire();
      await sqlExecutor.execute(
        `update ${NFT_LINKS_TABLE} set media_preview_locked_since = :acquiredAt`,
        { acquiredAt }
      );
      expect(again.lease).not.toBe(a.lease);
      expect(await fail(a)).toBe(false);
      expect(await fail(b)).toBe(false);
      const success = {
        canonicalId: 'preview-fixture',
        kind: 'image' as const,
        sourceHash: 'a',
        cardUrl: 'new',
        thumbUrl: 'new',
        smallUrl: 'new',
        width: 1,
        height: 1,
        mimeType: 'image/webp',
        bytes: 1
      };
      expect(
        await db.updateMediaPreviewWithSuccess({ ...success, fence: a }, {})
      ).toBe(false);
      expect((await read()).media_preview_error_message).toBe(again.lease);
      expect(
        await db.updateMediaPreviewWithSuccess({ ...success, fence: again }, {})
      ).toBe(true);
      const complete = await read();
      expect(complete.media_preview_status).toBe('READY');
      expect(complete.media_preview_error_message).toBeNull();
      expect(complete.media_preview_locked_since).toBeNull();
    });

    it.each(['legacy error', 'nft-preview-lease/v2:unknown'])(
      'respects active legacy leases and can acquire after expiry: %s',
      async (message) => {
        await acquire();
        await sqlExecutor.execute(
          `update ${NFT_LINKS_TABLE} set media_preview_error_message = :message`,
          { message }
        );
        expect(
          await db.lockMediaPreviewForProcessing(
            {
              canonicalId: 'preview-fixture',
              expectedSourceHash: 'a',
              lockTTL: Time.minutes(2)
            },
            {}
          )
        ).toBeNull();
        await sqlExecutor.execute(
          `update ${NFT_LINKS_TABLE} set media_preview_locked_since = 1`
        );
        expect((await acquire()).lease).not.toBe(message);
      }
    );

    it('bounds malformed future legacy locks and leaves real active locks unchanged', async () => {
      await acquire();
      await sqlExecutor.execute(
        `update ${NFT_LINKS_TABLE} set media_preview_locked_since = 9007199254740991`
      );
      await acquire();
      expect(
        await db.lockMediaPreviewForProcessing(
          {
            canonicalId: 'preview-fixture',
            expectedSourceHash: 'a',
            lockTTL: Time.minutes(2)
          },
          {}
        )
      ).toBeNull();
    });

    it('does not acknowledge a failed database completion write or expose private state', async () => {
      const lease = await acquire();
      await sqlExecutor.execute(`create trigger preview_failure_fixture before update on ${NFT_LINKS_TABLE}
        for each row signal sqlstate '45000' set message_text = 'fixture write failure'`);
      try {
        await expect(fail(lease)).rejects.toThrow('fixture write failure');
      } finally {
        await sqlExecutor.execute('drop trigger preview_failure_fixture');
      }
      const row = await read();
      expect(row.media_preview_error_message).toBe(lease.lease);
      const api = mapNftLinkEntityToApiLink(row as NftLinkEntity);
      expect(JSON.stringify(api)).not.toContain(lease.lease);
      expect(JSON.stringify(api)).not.toContain('media_preview_error_message');
      await expect(fail({ ...lease, lease: 'unknown' })).rejects.toThrow(
        'Invalid NFT preview completion lease'
      );
    });
  }
);
