import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { ArtworkAssetsDb } from '@/artwork-documentation/assets/artwork-assets.db';
import { ArtworkAssetStorage } from '@/artwork-documentation/assets/artwork-assets.storage';
import { ArtworkAssetsProcessor } from '@/artwork-documentation/assets/artwork-assets.processor';
import { anArtworkAsset } from '@/artwork-documentation/assets/artwork-assets.test-support';

function setup(
  scan: string | null,
  contents = Buffer.from('Artist interview text.')
) {
  const db = { finishProcessing: jest.fn(async () => undefined) };
  const storage = {
    scanStatus: jest.fn(async () => scan),
    read: jest.fn(async () => Readable.from([contents]))
  };
  const processor = new ArtworkAssetsProcessor(
    db as unknown as ArtworkAssetsDb,
    storage as unknown as ArtworkAssetStorage
  );
  const asset = anArtworkAsset({
    state: 'processing',
    extension: 'txt',
    size_bytes: contents.length,
    object_version: 'immutable-version-1',
    lease_until: Date.now() + 60000,
    attempts: 1
  });
  return { db, storage, processor, asset, contents };
}

describe('archive verification worker', () => {
  it.each([null, 'THREATS_FOUND', 'UNSUPPORTED', 'ACCESS_DENIED', 'FAILED'])(
    'never reads or marks ready without a successful real malware scan (%s)',
    async (scan) => {
      const { processor, asset, storage, db } = setup(scan);
      await processor.process(asset);
      expect(storage.read).not.toHaveBeenCalled();
      expect(db.finishProcessing).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ state: 'ready' })
      );
      if (scan === 'THREATS_FOUND' || scan === 'UNSUPPORTED')
        expect(db.finishProcessing).toHaveBeenCalledWith(
          asset,
          expect.objectContaining({ state: 'quarantined' })
        );
    }
  );
  it('only marks ready after scanning and hashing the exact original version', async () => {
    const { processor, asset, contents, db } = setup('NO_THREATS_FOUND');
    await processor.process(asset);
    expect(db.finishProcessing).toHaveBeenCalledWith(
      asset,
      expect.objectContaining({
        state: 'ready',
        sha256: createHash('sha256').update(contents).digest('hex'),
        scan_status: 'NO_THREATS_FOUND',
        detected_mime: 'text/plain'
      })
    );
  });
  it('quarantines bytes that disagree with the declared size even when malware clean', async () => {
    const { processor, asset, db } = setup('NO_THREATS_FOUND');
    asset.size_bytes += 1;
    await processor.process(asset);
    expect(db.finishProcessing).toHaveBeenCalledWith(
      asset,
      expect.objectContaining({
        state: 'quarantined',
        failure_code: 'UPLOAD_SIZE_MISMATCH'
      })
    );
  });
});
