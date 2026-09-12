import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
import {
  AssetTechnicalMetadata,
  StoredAsset
} from '@/artwork-documentation/assets/artwork-assets.types';
import {
  MAX_PDF_BYTES,
  PdfContentViolationError,
  validatePdfContent
} from '@/attachments/pdf-content-validator';
import { characterizeAssetHeader } from '@/artwork-documentation/assets/artwork-assets.characterization';
import { inspectArtworkArchive } from '@/artwork-documentation/assets/artwork-assets.archive';
import { identifyPronomFormat } from '@/artwork-documentation/assets/artwork-assets.pronom';
import { characterizeMp4 } from '@/artwork-documentation/assets/artwork-assets.av';
import { characterizeTiff } from '@/artwork-documentation/assets/artwork-assets.tiff';
import {
  C2PA_FILE_EXTENSIONS,
  validateAssetC2pa
} from '@/artwork-documentation/assets/artwork-assets.c2pa';

const SCAN_TIMEOUT_MS = 6 * 60 * 60_000;
const MAX_PROCESSING_ATTEMPTS = 360;

export class ArtworkAssetsProcessor {
  constructor(
    private readonly db: ArtworkAssetsDb,
    private readonly storage: ArtworkAssetStorage
  ) {}
  async tick(): Promise<boolean> {
    await this.cleanup();
    const asset = await this.db.claimProcessing(Date.now());
    if (asset) await this.process(asset);
    return Boolean(asset);
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
      if (
        error instanceof AssetInspectionError ||
        error instanceof PdfContentViolationError
      ) {
        await this.db.finishProcessing(asset, {
          state: 'quarantined',
          inspection_status: 'failed',
          failure_code:
            error instanceof AssetInspectionError
              ? error.code
              : 'PDF_CONTENT_REJECTED'
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
      if (asset.extension === 'pdf' && Number(asset.size_bytes) > MAX_PDF_BYTES)
        throw new AssetInspectionError('PDF_SIZE_LIMIT');
      if (
        previewEligible ||
        asset.extension === 'pdf' ||
        C2PA_FILE_EXTENSIONS.has(asset.extension)
      )
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
      const technical = characterizeAssetHeader(
        result.prefix,
        asset.extension,
        result.size,
        result.sha256
      );
      technical.format_registry = identifyPronomFormat(
        result.prefix,
        result.suffix
      );
      if (technical.format_registry.status === 'signature_match')
        technical.warnings = technical.warnings.filter(
          (warning) => warning !== 'FORMAT_REGISTRY_IDENTIFICATION_PENDING'
        );
      const dimensions = this.headerDimensions(result.prefix);
      const metadata: Partial<StoredAsset> = {
        ...inspection,
        sha256: result.sha256,
        ...dimensions
      };
      if (['tif', 'tiff', 'dng'].includes(asset.extension)) {
        const tiff = await characterizeTiff(result.size, (start, length) =>
          this.storage.readRange(asset, start, length, controller.signal)
        );
        if (tiff) {
          Object.assign(technical.properties, tiff);
          if (typeof tiff.width === 'number') metadata.width = tiff.width;
          if (typeof tiff.height === 'number') metadata.height = tiff.height;
        } else technical.warnings.push('TIFF_CHARACTERIZATION_LIMIT');
      }
      if (asset.extension === 'pdf' && path) {
        const validated = await validatePdfContent(await readFile(path));
        technical.properties.page_count = validated.pageCount;
        technical.properties.pdf_object_stream_normalization_required =
          validated.normalized;
        technical.warnings.push(
          'PDF_ORIGINAL_RETAINED_DISPLAY_DERIVATIVE_NOT_PUBLISHED'
        );
        metadata.inspection_status = 'verified';
      }
      if (['zip', 'epub'].includes(asset.extension)) {
        technical.archive = await inspectArtworkArchive(
          result.size,
          (start, length) =>
            this.storage.readRange(asset, start, length, controller.signal),
          (start, length) =>
            this.storage.readRangeStream(
              asset,
              start,
              length,
              controller.signal
            ),
          controller.signal
        );
        technical.method = 'stream-zip-inspector/1';
        metadata.inspection_status = 'verified';
      }
      if (['mp4', 'mov', 'm4a'].includes(asset.extension)) {
        const av = await characterizeMp4(result.size, (start, length) =>
          this.storage.readRange(asset, start, length, controller.signal)
        );
        if (av) Object.assign(technical.properties, av);
        else technical.warnings.push('AV_CHARACTERIZATION_LIMIT');
      }
      if (path && previewEligible)
        Object.assign(
          metadata,
          await this.createPreview(asset, path, technical.properties)
        );
      else if (PREVIEW_EXTENSIONS.includes(asset.extension))
        metadata.inspection_status = 'unsupported';
      if (path && C2PA_FILE_EXTENSIONS.has(asset.extension)) {
        const c2pa = await validateAssetC2pa(
          path,
          inspection.detected_mime,
          result.sha256
        );
        technical.c2pa = c2pa.metadata;
        if (c2pa.reportPath)
          metadata.validation_report_key =
            await this.storage.putValidationReport(
              asset,
              c2pa.reportPath,
              c2pa.metadata.report_size_bytes!,
              c2pa.metadata.report_sha256!
            );
        if (
          technical.c2pa.status === 'failed' ||
          technical.c2pa.status === 'unsupported'
        )
          technical.warnings.push(
            technical.c2pa.error_code ?? 'C2PA_VALIDATION_UNSUPPORTED'
          );
      }
      Object.assign(technical.properties, {
        width: metadata.width ?? null,
        height: metadata.height ?? null
      });
      metadata.technical_metadata_json = JSON.stringify(technical);
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
    path: string,
    properties: AssetTechnicalMetadata['properties']
  ): Promise<Partial<StoredAsset>> {
    let preview: Buffer;
    let dimensions: { width: number | null; height: number | null };
    try {
      const pipeline = sharp(path, {
        limitInputPixels: PREVIEW_PIXEL_LIMIT,
        sequentialRead: true,
        pages: 1
      }).timeout({ seconds: 25 });
      const info = await pipeline.metadata();
      const depth: Record<string, number> = {
        char: 8,
        uchar: 8,
        short: 16,
        ushort: 16,
        int: 32,
        uint: 32,
        float: 32,
        double: 64
      };
      Object.assign(properties, {
        color_space: info.space ?? null,
        sample_storage_depth: info.depth ?? null,
        bit_depth: info.depth ? (depth[info.depth] ?? null) : null,
        channels: info.channels ?? null,
        has_alpha: info.hasAlpha ?? false,
        has_embedded_color_profile: info.hasProfile ?? false,
        embedded_density_ppi: info.density ?? null,
        orientation: info.orientation ?? null,
        image_pages: info.pages ?? 1
      });
      dimensions = { width: info.width ?? null, height: info.height ?? null };
      preview = await pipeline
        .rotate()
        .resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (error) {
      // Bounded parser limits do not reject an otherwise safely scanned archival original.
      if (
        error instanceof Error &&
        /pixel limit|timeout|unsupported image format/i.test(error.message)
      )
        return { inspection_status: 'unsupported' };
      throw new AssetInspectionError('INVALID_IMAGE_DATA');
    }
    // Storage failures remain operational retries, never invalid-image findings.
    // No withMetadata/keepMetadata: generated pixels contain no source metadata.
    const key = await this.storage.putPreview(asset, preview);
    return {
      preview_key: key,
      ...dimensions,
      inspection_status: 'verified'
    };
  }
  async cleanup(): Promise<void> {
    for (let count = 0; count < 20; count++) {
      // The expired-state claim commits before S3 access. Attachment cannot
      // retain a claimed asset because validation and reference writes require ready.
      const asset = await this.db.claimCleanup(Date.now());
      if (!asset) return;
      let succeeded = false;
      try {
        await this.storage.cancel(asset);
        succeeded = true;
      } catch {
        // Preserve the claim and quota for retry without retaining raw SDK errors.
      }
      await this.db.finishCleanup(asset, succeeded, Date.now());
    }
  }
}
export const artworkAssetsProcessor = new ArtworkAssetsProcessor(
  artworkAssetsDb,
  artworkAssetStorage
);
