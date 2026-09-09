import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { imageSize } from 'image-size';
import {
  artworkAssetsDb,
  ArtworkAssetsDb
} from '@/artwork-documentation/assets/artwork-assets.db';
import {
  artworkAssetStorage,
  ArtworkAssetStorage
} from '@/artwork-documentation/assets/artwork-assets.storage';
import { ARTWORK_UPLOAD_POLICY } from '@/artwork-documentation/assets/artwork-assets.policy';
import {
  AssetInspectionError,
  hashAssetStream,
  inspectAssetHeader,
  PREVIEW_EXTENSIONS,
  PREVIEW_FILE_LIMIT,
  PREVIEW_PIXEL_LIMIT
} from '@/artwork-documentation/assets/artwork-assets.inspection';
import { StoredAsset } from '@/artwork-documentation/assets/artwork-assets.types';

const SCAN_TIMEOUT_MS = 6 * 60 * 60_000;
const MAX_PROCESSING_ATTEMPTS = 360;

export class ArtworkAssetsProcessor {
  constructor(
    private readonly db: ArtworkAssetsDb,
    private readonly storage: ArtworkAssetStorage
  ) {}
  async tick(): Promise<void> {
    await this.cleanup();
    const asset = await this.db.claimProcessing(Date.now());
    if (asset) await this.process(asset);
  }
  async process(asset: StoredAsset): Promise<void> {
    try {
      const scanStatus = await this.storage.scanStatus(asset);
      if (scanStatus !== 'NO_THREATS_FOUND') {
        await this.handleScanState(asset, scanStatus);
        return;
      }
      const metadata = await this.verifyBytes(asset);
      await this.db.finishProcessing(asset, {
        ...metadata,
        state: 'ready',
        scan_status: scanStatus,
        failure_code: null,
        expires_at: Date.now() + ARTWORK_UPLOAD_POLICY.orphan_lifetime_ms
      });
    } catch (error) {
      if (error instanceof AssetInspectionError) {
        await this.db.finishProcessing(asset, {
          state: 'quarantined',
          inspection_status: 'failed',
          failure_code: error.code
        });
        return;
      }
      if (
        asset.attempts >= MAX_PROCESSING_ATTEMPTS ||
        Date.now() - Number(asset.created_at) >
          SCAN_TIMEOUT_MS + ARTWORK_UPLOAD_POLICY.upload_lifetime_ms
      ) {
        await this.db.finishProcessing(asset, {
          state: 'failed',
          failure_code: 'ASSET_PROCESSING_TIMEOUT'
        });
        return;
      }
      // Durable retry has no raw SDK error, private filename, object key or signed URL in logs/API.
      await this.db.finishProcessing(asset, {
        next_attempt_at: Date.now() + 60_000,
        failure_code: 'ASSET_PROCESSING_RETRY'
      });
    }
  }
  private async handleScanState(
    asset: StoredAsset,
    status: string | null
  ): Promise<void> {
    if (status === 'THREATS_FOUND' || status === 'UNSUPPORTED') {
      await this.db.finishProcessing(asset, {
        state: 'quarantined',
        scan_status: status,
        inspection_status: 'failed',
        failure_code:
          status === 'THREATS_FOUND'
            ? 'MALWARE_DETECTED'
            : 'MALWARE_SCAN_UNSUPPORTED'
      });
    } else if (status === 'ACCESS_DENIED' || status === 'FAILED') {
      await this.db.finishProcessing(asset, {
        state: 'failed',
        scan_status: status,
        failure_code: 'MALWARE_SCAN_FAILED'
      });
    } else if (asset.attempts >= MAX_PROCESSING_ATTEMPTS) {
      await this.db.finishProcessing(asset, {
        state: 'failed',
        failure_code: 'MALWARE_SCAN_TIMEOUT'
      });
    } else {
      await this.db.finishProcessing(asset, {
        next_attempt_at: Date.now() + 60_000,
        failure_code: null
      });
    }
  }
  private async verifyBytes(asset: StoredAsset): Promise<Partial<StoredAsset>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12 * 60_000);
    const previewEligible =
      PREVIEW_EXTENSIONS.includes(asset.extension) &&
      Number(asset.size_bytes) <= PREVIEW_FILE_LIMIT;
    let directory: string | undefined;
    try {
      if (previewEligible)
        directory = await mkdtemp(join(tmpdir(), 'artwork-asset-'));
      const path = directory ? join(directory, 'original') : undefined;
      const stream = await this.storage.read(asset, controller.signal);
      const result = await hashAssetStream(
        stream,
        Number(asset.size_bytes),
        asset.extension,
        controller.signal,
        path
      );
      const inspection = inspectAssetHeader(result.prefix, asset.extension);
      const dimensions = this.headerDimensions(result.prefix);
      const metadata: Partial<StoredAsset> = {
        ...inspection,
        sha256: result.sha256,
        ...dimensions
      };
      if (path) Object.assign(metadata, await this.createPreview(asset, path));
      else if (PREVIEW_EXTENSIONS.includes(asset.extension))
        metadata.inspection_status = 'unsupported';
      return metadata;
    } finally {
      clearTimeout(timeout);
      // Only the mkdtemp path created in this invocation is removed.
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  }
  private headerDimensions(prefix: Buffer): {
    width: number | null;
    height: number | null;
  } {
    try {
      const result = imageSize(prefix);
      return { width: result.width, height: result.height };
    } catch {
      return { width: null, height: null };
    }
  }
  private async createPreview(
    asset: StoredAsset,
    path: string
  ): Promise<Partial<StoredAsset>> {
    try {
      const pipeline = sharp(path, {
        limitInputPixels: PREVIEW_PIXEL_LIMIT,
        sequentialRead: true,
        pages: 1
      }).timeout({ seconds: 25 });
      const info = await pipeline.metadata();
      const preview = await pipeline
        .rotate()
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      // No withMetadata/keepMetadata: generated pixels contain no GPS, EXIF, XMP or artist instrument metadata.
      const key = await this.storage.putPreview(asset, preview);
      return {
        preview_key: key,
        width: info.width ?? null,
        height: info.height ?? null,
        inspection_status: 'verified'
      };
    } catch (error) {
      // Bounded parser limits do not reject an otherwise safely scanned archival original.
      if (
        error instanceof Error &&
        /pixel limit|timeout|unsupported image format/i.test(error.message)
      )
        return { inspection_status: 'unsupported' };
      throw new AssetInspectionError('INVALID_IMAGE_DATA');
    }
  }
  async cleanup(): Promise<void> {
    const candidates = await this.db.cleanupCandidates(Date.now());
    for (const candidate of candidates) {
      await this.db.withLocked(
        candidate.id,
        candidate.context_id,
        async (asset, connection) => {
          // Core confirmation/attachment holds the same asset lock before marking retained.
          if (
            asset.referenced ||
            asset.state === 'processing' ||
            Number(asset.expires_at) > Date.now() ||
            Number(asset.reserved_bytes) === 0
          )
            return;
          await this.storage.cancel(asset);
          await this.db.update(
            asset.id,
            { state: 'expired', reserved_bytes: 0, updated_at: Date.now() },
            connection
          );
        }
      );
    }
  }
}
export const artworkAssetsProcessor = new ArtworkAssetsProcessor(
  artworkAssetsDb,
  artworkAssetStorage
);
