import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
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
    read: jest.fn(async () => Readable.from([contents])),
    putPreview: jest.fn(async () => 'previews/synthetic.jpg')
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
  it('validates object-stream PDFs while recording the digest of the untouched original', async () => {
    const document = await PDFDocument.create();
    document.addPage([100, 100]);
    const bytes = Buffer.from(await document.save());
    const { processor, asset, db, storage } = setup('NO_THREATS_FOUND', bytes);
    asset.extension = 'pdf';
    await processor.process(asset);
    expect(db.finishProcessing).toHaveBeenCalledWith(
      asset,
      expect.objectContaining({
        state: 'ready',
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
    );
    expect(storage.putPreview).not.toHaveBeenCalled();
    const patch = (
      db.finishProcessing.mock.calls as unknown as [unknown, unknown][]
    )[0][1] as {
      technical_metadata_json: string;
    };
    expect(JSON.parse(patch.technical_metadata_json).properties).toMatchObject({
      page_count: 1,
      pdf_object_stream_normalization_required: true
    });
  });
  it('quarantines a PDF rejected by website policy even after a clean malware scan', async () => {
    const { processor, asset, db } = setup(
      'NO_THREATS_FOUND',
      Buffer.from('%PDF-1.7\n/JavaScript')
    );
    asset.extension = 'pdf';
    await processor.process(asset);
    expect(db.finishProcessing).toHaveBeenCalledWith(
      asset,
      expect.objectContaining({
        state: 'quarantined',
        failure_code: 'PDF_CONTENT_REJECTED'
      })
    );
  });
  it('retries a preview storage fault and then marks the valid original ready', async () => {
    const bytes = await sharp({
      create: { width: 3, height: 2, channels: 3, background: '#abcdef' }
    })
      .png()
      .toBuffer();
    const { processor, asset, storage, db } = setup('NO_THREATS_FOUND', bytes);
    asset.extension = 'png';
    storage.putPreview.mockRejectedValueOnce(
      new Error('Temporary storage fault')
    );
    await processor.process(asset);
    expect(db.finishProcessing).toHaveBeenLastCalledWith(
      asset,
      expect.objectContaining({ failure_code: 'ASSET_PROCESSING_RETRY' })
    );
    expect(db.finishProcessing).not.toHaveBeenCalledWith(
      asset,
      expect.objectContaining({ state: 'quarantined' })
    );
    await processor.process({ ...asset, attempts: 2 });
    expect(db.finishProcessing).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        state: 'ready',
        width: 3,
        height: 2,
        preview_key: 'previews/synthetic.jpg'
      })
    );
  });
  it('still quarantines a corrupt image as an image-validation failure', async () => {
    const { processor, asset, db, storage } = setup(
      'NO_THREATS_FOUND',
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
    );
    asset.extension = 'png';
    await processor.process(asset);
    expect(db.finishProcessing).toHaveBeenCalledWith(
      asset,
      expect.objectContaining({
        state: 'quarantined',
        failure_code: 'INVALID_IMAGE_DATA'
      })
    );
    expect(storage.putPreview).not.toHaveBeenCalled();
  });
  it('finishes a failed external cleanup as retryable without blocking other work', async () => {
    const claim = anArtworkAsset({ state: 'expired' });
    const db = {
      claimCleanup: jest
        .fn()
        .mockResolvedValueOnce(claim)
        .mockResolvedValue(null),
      finishCleanup: jest.fn(async () => undefined)
    };
    const storage = {
      cancel: jest.fn().mockRejectedValue(new Error('Temporary storage fault'))
    };
    const processor = new ArtworkAssetsProcessor(
      db as unknown as ArtworkAssetsDb,
      storage as unknown as ArtworkAssetStorage
    );
    await processor.cleanup();
    expect(db.finishCleanup).toHaveBeenCalledWith(
      claim,
      false,
      expect.any(Number)
    );
  });
});
