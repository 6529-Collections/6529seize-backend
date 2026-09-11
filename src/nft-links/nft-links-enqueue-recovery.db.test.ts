import { NFT_LINKS_TABLE } from '@/constants/db-tables';
import { describeWithSeed } from '@/tests/_setup/seed';
import { sqlExecutor } from '@/sql-executor';
import { NftLinksDb } from '@/nft-links/nft-links.db';

describeWithSeed(
  'NFT preview enqueue recovery',
  {
    table: NFT_LINKS_TABLE,
    rows: ['pending', 'ready', 'processing', 'new-source'].map((id) => ({
      canonical_id: id,
      platform: 'OPENSEA',
      last_tried_to_update: 1,
      media_uri: 'https://example.com/previous.png',
      media_preview_status: id === 'ready' ? 'READY' : 'PENDING',
      media_preview_source_hash: id === 'new-source' ? 'new' : 'old',
      media_preview_locked_since: id === 'processing' ? 123 : null
    }))
  },
  () => {
    it('makes a failed enqueue retryable without overwriting cached data, active consumers, or newer sources', async () => {
      const db = new NftLinksDb(() => sqlExecutor);
      for (const id of ['pending', 'ready', 'processing', 'new-source']) {
        await db.markMediaPreviewEnqueueFailed(id, 'old', {});
      }
      const rows = await sqlExecutor.execute<{
        canonical_id: string;
        media_preview_status: string;
        media_uri: string;
      }>(`select * from ${NFT_LINKS_TABLE}`);
      expect(
        Object.fromEntries(
          rows.map((row) => [row.canonical_id, row.media_preview_status])
        )
      ).toEqual({
        pending: 'FAILED',
        ready: 'READY',
        processing: 'PENDING',
        'new-source': 'PENDING'
      });
      expect(
        rows.every(
          (row) => row.media_uri === 'https://example.com/previous.png'
        )
      ).toBe(true);
      await expect(
        db.markMediaPreviewPendingIfNeeded(
          { canonicalId: 'pending', sourceHash: 'old', kind: 'image' },
          {}
        )
      ).resolves.toBe(true);
    });
  }
);
