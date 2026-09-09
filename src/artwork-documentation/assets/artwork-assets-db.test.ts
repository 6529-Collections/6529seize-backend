import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { ArtworkAssetsDb } from '@/artwork-documentation/assets/artwork-assets.db';
import {
  anArtworkAsset,
  artistAssetAccess
} from '@/artwork-documentation/assets/artwork-assets.test-support';
import { ArtworkAssetsProcessor } from '@/artwork-documentation/assets/artwork-assets.processor';
import { ArtworkAssetsService } from '@/artwork-documentation/assets/artwork-assets.service';
import { ArtworkAssetStorage } from '@/artwork-documentation/assets/artwork-assets.storage';
import { sqlExecutor } from '@/sql-executor';
import {
  ARTWORK_ASSETS_TABLE,
  ARTWORK_ASSET_QUOTAS_TABLE
} from '@/artwork-documentation/assets/artwork-assets.types';
import { ARTWORK_UPLOAD_POLICY } from '@/artwork-documentation/assets/artwork-assets.policy';

describe('artwork archive reservations and leases', () => {
  let db: ArtworkAssetsDb;
  beforeEach(async () => {
    await sqlExecutor.execute(`delete from ${ARTWORK_ASSETS_TABLE}`);
    await sqlExecutor.execute(`delete from ${ARTWORK_ASSET_QUOTAS_TABLE}`);
    db = new ArtworkAssetsDb(() => sqlExecutor);
  });

  it('serializes simultaneous reservations at the 20GiB context boundary', async () => {
    const fourGiB = 4 * 1024 ** 3;
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        db.reserve(
          anArtworkAsset({ size_bytes: fourGiB, reserved_bytes: fourGiB })
        )
      )
    );
    expect(
      results.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(5);
    expect(
      results.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    const rows = await db.list('context-1');
    expect(rows.reduce((sum, row) => sum + Number(row.reserved_bytes), 0)).toBe(
      20 * 1024 ** 3
    );
  });

  it('replays an identical upload request without a second reservation', async () => {
    const row = anArtworkAsset();
    const first = await db.reserve(row);
    const retried = await db.reserve({ ...row, id: randomUUID() });
    expect(retried.id).toBe(first.id);
    expect(await db.list(row.context_id)).toHaveLength(1);
    await expect(
      db.reserve({ ...row, id: randomUUID(), request_hash: 'b'.repeat(64) })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });

  it('releases quota after durable cancellation and isolates contexts', async () => {
    const row = await db.reserve(anArtworkAsset());
    await db.withLocked(row.id, row.context_id, async (_asset, connection) => {
      await db.update(
        row.id,
        { reserved_bytes: 0, state: 'cancelled' },
        connection
      );
    });
    expect(await db.list(row.context_id)).toHaveLength(0);
    expect(await db.find(row.id, 'another-context')).toBeNull();
  });

  it('claims a processing asset only once until lease expiry', async () => {
    const now = Date.now();
    const row = await db.reserve(anArtworkAsset({ state: 'processing' }));
    const results = await Promise.all([
      db.claimProcessing(now),
      db.claimProcessing(now)
    ]);
    const claimed = results.find(Boolean)!;
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(claimed.id).toBe(row.id);
    const fresh = await db.claimProcessing(now + 16 * 60_000);
    expect(fresh?.attempts).toBe(2);
    await db.finishProcessing(claimed, { state: 'ready' });
    expect((await db.find(row.id))?.state).toBe('processing');
    await db.finishProcessing(fresh!, { state: 'ready' });
    expect((await db.find(row.id))?.state).toBe('ready');
  });

  it('retains originals referenced by any committed revision', async () => {
    const row = await db.reserve(
      anArtworkAsset({ state: 'ready', expires_at: Date.now() - 1000 })
    );
    await sqlExecutor.executeNativeQueriesInTransaction(async (connection) => {
      await db.find(row.id, row.context_id, connection, true);
      await db.markReferenced(row.context_id, [row.id], connection);
    });
    expect(await db.claimCleanup(Date.now())).toBeNull();
    const retained = await sqlExecutor.oneOrNull<{
      referenced: number;
      expires_at: number;
    }>(
      `select referenced, expires_at from ${ARTWORK_ASSETS_TABLE} where id = :id`,
      { id: row.id }
    );
    expect(Number(retained?.referenced)).toBe(1);
    expect(Number(retained?.expires_at)).toBe(0);
  });

  it('reports queue age from completion even when retry timestamps keep changing', async () => {
    const now = Date.now();
    await db.reserve(
      anArtworkAsset({
        state: 'processing',
        expires_at: now + ARTWORK_UPLOAD_POLICY.orphan_lifetime_ms - 7200_000,
        updated_at: now
      })
    );
    await db.reserve(anArtworkAsset({ state: 'failed', updated_at: now }));
    const stats = await db.operationalStats(now);
    expect(stats.pending).toBe(1);
    expect(stats.oldestAgeSeconds).toBe(7200);
    expect(stats.failuresLastHour).toBe(1);
    expect(stats.maxQuotaPercent).toBeGreaterThan(0);
  });

  it('skips a reference transaction holding the row and preserves its committed retention', async () => {
    const now = Date.now();
    const row = await db.reserve(
      anArtworkAsset({ state: 'ready', expires_at: now - 1000 })
    );
    let acquired!: () => void;
    let release!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const retaining = sqlExecutor.executeNativeQueriesInTransaction(
      async (connection) => {
        await db.find(row.id, row.context_id, connection, true);
        acquired();
        await proceed;
        await db.markReferenced(row.context_id, [row.id], connection);
      }
    );
    try {
      await locked;
      expect(await db.claimCleanup(now)).toBeNull();
    } finally {
      release();
      await retaining;
    }
    expect(await db.claimCleanup(now)).toBeNull();
    expect(Number((await db.find(row.id))?.referenced)).toBe(1);
  });

  it('releases the SQL lock before S3 cleanup and rejects a late attachment', async () => {
    const row = await db.reserve(
      anArtworkAsset({
        state: 'ready',
        expires_at: Date.now() - 1000,
        sha256: 'a'.repeat(64),
        scan_status: 'NO_THREATS_FOUND'
      })
    );
    const storage = {
      cancel: jest.fn(async () => {
        await db.withLocked(
          row.id,
          row.context_id,
          async (current, connection) => {
            expect(current.state).toBe('expired');
            const service = new ArtworkAssetsService(
              db,
              {} as ArtworkAssetStorage
            );
            await expect(
              service.validateReadyAsset(
                row.context_id,
                row.id,
                artistAssetAccess,
                connection
              )
            ).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
            await db.markReferenced(row.context_id, [row.id], connection);
          }
        );
      })
    };
    await new ArtworkAssetsProcessor(
      db,
      storage as unknown as ArtworkAssetStorage
    ).cleanup();
    expect(storage.cancel).toHaveBeenCalledTimes(1);
    const expired = await db.find(row.id);
    expect(expired?.state).toBe('expired');
    expect(Number(expired?.referenced)).toBe(0);
    expect(Number(expired?.reserved_bytes)).toBe(0);
  });

  it('retains cleanup quota across storage failure and fences stale cleanup workers', async () => {
    const now = Date.now();
    const row = await db.reserve(
      anArtworkAsset({ state: 'ready', expires_at: now - 1000 })
    );
    const first = (await db.claimCleanup(now))!;
    expect(first.id).toBe(row.id);
    expect(await db.claimCleanup(now + 1)).toBeNull();
    await db.finishCleanup(first, false, now);
    const failed = await db.find(row.id);
    expect(failed?.state).toBe('expired');
    expect(failed?.failure_code).toBe('ASSET_CLEANUP_RETRY');
    expect(Number(failed?.reserved_bytes)).toBe(row.size_bytes);
    expect(await db.claimCleanup(now + 1)).toBeNull();
    const retry = (await db.claimCleanup(now + 60_001))!;
    expect(retry.attempts).toBe(2);
    await db.finishCleanup(first, true, now + 60_002);
    expect(Number((await db.find(row.id))?.reserved_bytes)).toBe(
      row.size_bytes
    );
    const recovered = (await db.claimCleanup(now + 17 * 60_000))!;
    expect(recovered.attempts).toBe(3);
    await db.finishCleanup(retry, true, now + 17 * 60_000);
    expect(Number((await db.find(row.id))?.reserved_bytes)).toBe(
      row.size_bytes
    );
    await db.finishCleanup(recovered, true, now + 17 * 60_001);
    expect(Number((await db.find(row.id))?.reserved_bytes)).toBe(0);
  });
});
