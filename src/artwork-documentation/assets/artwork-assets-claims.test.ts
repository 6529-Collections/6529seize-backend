import {
  ArtworkAssetsDb,
  MAX_ASSET_PROCESSING_ATTEMPTS,
  processingClaimRetryDelayMs
} from '@/artwork-documentation/assets/artwork-assets.db';
import { anArtworkAsset } from '@/artwork-documentation/assets/artwork-assets.test-support';
import {
  ARTWORK_ASSETS_TABLE,
  AssetConnection,
  StoredAsset
} from '@/artwork-documentation/assets/artwork-assets.types';
import { SqlExecutor } from '@/sql-executor';

const queues = [
  { method: 'claimProcessing', state: 'processing', attempts: 4 },
  { method: 'claimCleanup', state: 'ready', attempts: 1 },
  { method: 'claimCleanup', state: 'expired', attempts: 4 }
] as const;

function claimExecutor() {
  const connection: AssetConnection = { connection: {} };
  const executor = {
    oneOrNull: jest.fn(),
    execute: jest.fn(),
    executeNativeQueriesInTransaction: jest.fn(
      async (
        operation: (held: AssetConnection) => Promise<StoredAsset | null>
      ) => operation(connection)
    )
  };
  return {
    connection,
    executor,
    db: new ArtworkAssetsDb(() => executor as unknown as SqlExecutor)
  };
}

describe('artwork asset queue row hydration', () => {
  it.each(queues)(
    '$method locks the ID before hydrating $state metadata and updating its lease',
    async ({ method, state, attempts }) => {
      const { db, executor, connection } = claimExecutor();
      const now = 1_000_000;
      const asset = anArtworkAsset({
        state,
        attempts: 3,
        technical_metadata_json: JSON.stringify({
          warnings: ['x'.repeat(300_000)]
        }),
        parts_json: JSON.stringify({ receipts: 'y'.repeat(100_000) })
      });
      executor.oneOrNull
        .mockResolvedValueOnce({ id: asset.id })
        .mockResolvedValueOnce(asset);

      const claimed = await db[method](now);

      expect(executor.executeNativeQueriesInTransaction).toHaveBeenCalledTimes(
        1
      );
      expect(executor.oneOrNull).toHaveBeenCalledTimes(2);
      const selection = executor.oneOrNull.mock.calls[0];
      expect(selection[0]).toMatch(
        new RegExp(`^select id from ${ARTWORK_ASSETS_TABLE} where `)
      );
      expect(selection[0]).toMatch(/limit 1 for update skip locked$/);
      expect(selection[1]).toEqual({ now });
      expect(selection[2].wrappedConnection).toBe(connection);
      const hydration = executor.oneOrNull.mock.calls[1];
      expect(hydration[0]).toMatch(
        new RegExp(
          `^select \\* from ${ARTWORK_ASSETS_TABLE} where id = :id +for update$`
        )
      );
      expect(hydration[0]).not.toMatch(/order by/i);
      expect(hydration[1].id).toBe(asset.id);
      expect(hydration[2].wrappedConnection).toBe(connection);
      expect(claimed).toMatchObject({
        id: asset.id,
        technical_metadata_json: asset.technical_metadata_json,
        parts_json: asset.parts_json,
        lease_until: now + 15 * 60_000,
        attempts,
        state: method === 'claimCleanup' ? 'expired' : 'processing'
      });
      expect(executor.execute).toHaveBeenCalledTimes(1);
      const update = executor.execute.mock.calls[0];
      expect(update[1]).toMatchObject({
        id: asset.id,
        lease_until: now + 15 * 60_000,
        attempts
      });
      expect(update[2].wrappedConnection).toBe(connection);
    }
  );

  it.each(['claimProcessing', 'claimCleanup'] as const)(
    '%s leaves an empty queue untouched',
    async (method) => {
      const { db, executor } = claimExecutor();
      executor.oneOrNull.mockResolvedValueOnce(null);
      expect(await db[method](1_000_000)).toBeNull();
      expect(executor.oneOrNull).toHaveBeenCalledTimes(1);
      expect(executor.execute).not.toHaveBeenCalled();
    }
  );
});

describe('artwork asset processing claim backoff', () => {
  const now = 1_000_000_000;
  const lease = now + 15 * 60_000;

  it('moves next_attempt_at past the lease so a stuck asset is not offered first again', async () => {
    const { db, executor } = claimExecutor();
    const asset = anArtworkAsset({
      state: 'processing',
      attempts: 2,
      created_at: now
    });
    executor.oneOrNull
      .mockResolvedValueOnce({ id: asset.id })
      .mockResolvedValueOnce(asset);

    const claimed = await db.claimProcessing(now);

    const expectedNext = lease + processingClaimRetryDelayMs(3);
    expect(claimed).toMatchObject({
      attempts: 3,
      lease_until: lease,
      next_attempt_at: expectedNext
    });
    expect(executor.execute.mock.calls[0][1]).toMatchObject({
      attempts: 3,
      lease_until: lease,
      next_attempt_at: expectedNext
    });
    expect(expectedNext).toBeGreaterThan(lease);
  });

  it('grows the retry delay with attempts up to one hour', () => {
    expect(processingClaimRetryDelayMs(1)).toBe(60_000);
    expect(processingClaimRetryDelayMs(5)).toBe(5 * 60_000);
    expect(processingClaimRetryDelayMs(500)).toBe(60 * 60_000);
    for (let attempts = 1; attempts < 100; attempts++) {
      expect(processingClaimRetryDelayMs(attempts + 1)).toBeGreaterThanOrEqual(
        processingClaimRetryDelayMs(attempts)
      );
    }
  });

  it('marks an asset that used all attempts failed and claims the next one', async () => {
    const { db, executor } = claimExecutor();
    const exhausted = anArtworkAsset({
      id: 'exhausted',
      state: 'processing',
      attempts: MAX_ASSET_PROCESSING_ATTEMPTS,
      created_at: now
    });
    const next = anArtworkAsset({
      id: 'next',
      state: 'processing',
      attempts: 0,
      created_at: now
    });
    executor.oneOrNull
      .mockResolvedValueOnce({ id: exhausted.id })
      .mockResolvedValueOnce(exhausted)
      .mockResolvedValueOnce({ id: next.id })
      .mockResolvedValueOnce(next);

    const claimed = await db.claimProcessing(now);

    expect(claimed).toMatchObject({ id: 'next', attempts: 1 });
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(executor.execute.mock.calls[0][1]).toMatchObject({
      id: 'exhausted',
      state: 'failed',
      failure_code: 'ASSET_PROCESSING_TIMEOUT',
      lease_until: 0
    });
  });

  it('marks an asset past its scan window failed', async () => {
    const { db, executor } = claimExecutor();
    const stale = anArtworkAsset({
      state: 'processing',
      attempts: 1,
      created_at: now - 31 * 60 * 60_000
    });
    executor.oneOrNull
      .mockResolvedValueOnce({ id: stale.id })
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(null);

    expect(await db.claimProcessing(now)).toBeNull();
    expect(executor.execute.mock.calls[0][1]).toMatchObject({
      state: 'failed',
      failure_code: 'ASSET_PROCESSING_TIMEOUT'
    });
  });

  it('stops after a bounded number of exhausted assets', async () => {
    const { db, executor } = claimExecutor();
    const exhausted = anArtworkAsset({
      state: 'processing',
      attempts: MAX_ASSET_PROCESSING_ATTEMPTS,
      created_at: now
    });
    executor.oneOrNull.mockImplementation(async (sql: string) =>
      sql.startsWith('select id') ? { id: exhausted.id } : exhausted
    );

    expect(await db.claimProcessing(now)).toBeNull();
    expect(executor.execute.mock.calls.length).toBeLessThanOrEqual(11);
  });
});
