import {
  DROP_MEDIA_SANITIZED_METADATA_KEY,
  DROP_MEDIA_SANITIZED_METADATA_VALUE
} from '@/drops/drop-media-upload.config';
import {
  ContainerDescription,
  describeImageContainer,
  LosslessStripFormat
} from '@/media/metadata-strip/lossless-metadata-strip';
import {
  PixelVerifiedStripOutcome,
  stripMetadataWithPixelCheck
} from '@/media/metadata-strip/pixel-verified-metadata-strip';
import {
  MediaObjectStore,
  ObjectChangedError,
  ObjectHead,
  ObjectTooLargeError,
  SafetyCopyLayout,
  SafetyCopyManifest,
  sha256Base64,
  sha256Hex
} from './backfill-storage';
import { ChatMediaTarget } from './chat-media-candidates';
import { findIdentifyingMetadata } from './identifying-metadata';
import { sniffImageContainer } from './image-container';
import { CleanState, MetadataCategory } from './metadata-category';
import { invalidationPathsFor } from './media-references';

/** Marks objects this tool rewrote, so restore only touches its own writes. */
export const BACKFILL_RUN_METADATA_KEY = 'metadata-backfill-run';
/**
 * The lossless path holds the source, its output and a decoded copy in
 * memory; it matches the upload sanitizer's lossless source limit.
 */
export const BACKFILL_MAX_IMAGE_BYTES = 64 * 1024 * 1024;

export enum ObjectSkipReason {
  MISSING_OBJECT = 'missing_object',
  TOO_LARGE = 'too_large',
  CONTENT_ENCODED = 'content_encoded',
  UNSUPPORTED_FORMAT = 'unsupported_format',
  UNPARSEABLE_CONTAINER = 'unparseable_container',
  /** The lossless strip or its pixel-hash check did not verify. */
  VERIFICATION_FAILED = 'verification_failed',
  /** The strip would keep the SDR image but drop its HDR gain map. */
  GAIN_MAP_NOT_KEPT = 'gain_map_not_kept',
  CHANGED_DURING_RUN = 'changed_during_run'
}

export type ImageOutcome =
  | {
      readonly kind: 'skipped';
      readonly reason: ObjectSkipReason;
      readonly categories: MetadataCategory[];
      readonly size: number;
    }
  | {
      readonly kind: 'clean';
      readonly state: CleanState;
      readonly size: number;
    }
  | {
      readonly kind: 'rewrite';
      readonly categories: MetadataCategory[];
      readonly originalSize: number;
      readonly strippedSize: number;
      /** HDR gain map images kept in the rewritten file. */
      readonly gainMapsKept: number;
      /** False in a dry run. */
      readonly written: boolean;
    };

export type StripFunction = (
  input: Buffer,
  format: LosslessStripFormat
) => Promise<PixelVerifiedStripOutcome>;

export interface ObjectProcessorDeps {
  readonly publicStore: MediaObjectStore;
  /** Null in a dry run: nothing is ever written then. */
  readonly writer: {
    readonly safetyStore: MediaObjectStore;
    readonly layout: SafetyCopyLayout;
    readonly onRewritten: (paths: string[]) => void;
  } | null;
  readonly runId: string;
  readonly now: () => Date;
  readonly strip?: StripFunction;
  readonly maxImageBytes?: number;
}

class SafetyCopyUnverifiedError extends Error {
  constructor(key: string) {
    super(
      `Safety copy of ${key} did not verify; the original was not replaced`
    );
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'SafetyCopyUnverifiedError';
  }
}

function skipped(
  reason: ObjectSkipReason,
  size: number,
  categories: MetadataCategory[] = []
): ImageOutcome {
  return { kind: 'skipped', reason, categories, size };
}

function cleanState(description: ContainerDescription): CleanState {
  return description.orientation === 1
    ? CleanState.NO_METADATA
    : CleanState.ORIENTATION_ONLY;
}

function isEncoded(head: ObjectHead): boolean {
  const encoding = head.headers.contentEncoding?.trim().toLowerCase();
  return !!encoding && encoding !== 'identity';
}

/**
 * Inspects one public image and, only when it carries identifying metadata
 * and a lossless, pixel-verified strip exists, replaces it in place: first a
 * verified private safety copy and manifest, then a conditional overwrite of
 * the same key with the same headers. A file without identifying metadata is
 * never written. Nothing is ever re-encoded.
 */
export class ChatMediaObjectProcessor {
  private readonly strip: StripFunction;
  private readonly maxImageBytes: number;

  constructor(private readonly deps: ObjectProcessorDeps) {
    this.strip = deps.strip ?? stripMetadataWithPixelCheck;
    this.maxImageBytes = deps.maxImageBytes ?? BACKFILL_MAX_IMAGE_BYTES;
  }

  async processImage(target: ChatMediaTarget): Promise<ImageOutcome> {
    const { publicStore } = this.deps;
    const head = await publicStore.head(target.key);
    if (!head) return skipped(ObjectSkipReason.MISSING_OBJECT, 0);
    if (isEncoded(head)) {
      return skipped(ObjectSkipReason.CONTENT_ENCODED, head.size);
    }
    if (head.size > this.maxImageBytes) {
      return skipped(ObjectSkipReason.TOO_LARGE, head.size);
    }
    let original: Buffer;
    try {
      original = await publicStore.getBytes(target.key, {
        ifMatch: head.etag,
        maxBytes: this.maxImageBytes
      });
    } catch (error) {
      return this.readFailure(error, head.size);
    }
    return this.inspectAndRewrite(target, head, original);
  }

  private readFailure(error: unknown, size: number): ImageOutcome {
    if (error instanceof ObjectChangedError) {
      return skipped(ObjectSkipReason.CHANGED_DURING_RUN, size);
    }
    if (error instanceof ObjectTooLargeError) {
      return skipped(ObjectSkipReason.TOO_LARGE, size);
    }
    throw error;
  }

  private async inspectAndRewrite(
    target: ChatMediaTarget,
    head: ObjectHead,
    original: Buffer
  ): Promise<ImageOutcome> {
    const sniffed = sniffImageContainer(original);
    if (sniffed.kind === 'unsupported') {
      return skipped(ObjectSkipReason.UNSUPPORTED_FORMAT, original.length);
    }
    let description: ContainerDescription;
    try {
      description = describeImageContainer(original, sniffed.format);
    } catch {
      return skipped(ObjectSkipReason.UNPARSEABLE_CONTAINER, original.length);
    }
    if (!description.metadataBlocks.length) {
      return {
        kind: 'clean',
        state: cleanState(description),
        size: original.length
      };
    }
    const { categories } = findIdentifyingMetadata(
      original,
      sniffed.format,
      description.metadataBlocks
    );
    if (!categories.length) {
      return {
        kind: 'clean',
        state: CleanState.TECHNICAL_EXIF_ONLY,
        size: original.length
      };
    }
    const stripped = await this.strip(original, sniffed.format);
    if (stripped.kind !== 'lossless') {
      return skipped(
        ObjectSkipReason.VERIFICATION_FAILED,
        original.length,
        categories
      );
    }
    if (stripped.gainMaps?.kind === 'dropped') {
      return skipped(
        ObjectSkipReason.GAIN_MAP_NOT_KEPT,
        original.length,
        categories
      );
    }
    const gainMapsKept =
      stripped.gainMaps?.kind === 'kept' ? stripped.gainMaps.count : 0;
    if (!this.deps.writer) {
      return {
        kind: 'rewrite',
        categories,
        originalSize: original.length,
        strippedSize: stripped.buffer.length,
        gainMapsKept,
        written: false
      };
    }
    try {
      await this.replace(target, head, original, stripped.buffer);
    } catch (error) {
      if (error instanceof ObjectChangedError) {
        return skipped(
          ObjectSkipReason.CHANGED_DURING_RUN,
          original.length,
          categories
        );
      }
      throw error;
    }
    return {
      kind: 'rewrite',
      categories,
      originalSize: original.length,
      strippedSize: stripped.buffer.length,
      gainMapsKept,
      written: true
    };
  }

  private async replace(
    target: ChatMediaTarget,
    head: ObjectHead,
    original: Buffer,
    stripped: Buffer
  ): Promise<void> {
    const writer = this.deps.writer!;
    const paths = invalidationPathsFor(target.key, target.urls);
    await this.writeSafetyCopy(target.key, head, original, stripped, paths);
    await this.deps.publicStore.put(
      target.key,
      stripped,
      {
        ...head.headers,
        metadata: {
          ...head.headers.metadata,
          [DROP_MEDIA_SANITIZED_METADATA_KEY]:
            DROP_MEDIA_SANITIZED_METADATA_VALUE,
          [BACKFILL_RUN_METADATA_KEY]: this.deps.runId
        }
      },
      { ifMatch: head.etag }
    );
    writer.onRewritten(paths);
  }

  /** The original and its manifest are stored and verified before any overwrite. */
  private async writeSafetyCopy(
    key: string,
    head: ObjectHead,
    original: Buffer,
    stripped: Buffer,
    paths: string[]
  ): Promise<void> {
    const { safetyStore, layout } = this.deps.writer!;
    const copyKey = layout.objectKey(key);
    await safetyStore.put(copyKey, original, head.headers);
    const copy = await safetyStore.head(copyKey);
    if (
      copy?.size !== original.length ||
      (copy.checksumSha256 !== undefined &&
        copy.checksumSha256 !== sha256Base64(original))
    ) {
      throw new SafetyCopyUnverifiedError(key);
    }
    const manifest: SafetyCopyManifest = {
      version: 1,
      run_id: this.deps.runId,
      public_bucket: this.deps.publicStore.bucket,
      public_key: key,
      safety_copy_key: copyKey,
      original: {
        etag: head.etag,
        version_id: head.versionId ?? null,
        size: original.length,
        sha256: sha256Hex(original)
      },
      stripped: { size: stripped.length, sha256: sha256Hex(stripped) },
      headers: head.headers,
      invalidation_paths: paths,
      backed_up_at: this.deps.now().toISOString()
    };
    await safetyStore.put(
      layout.manifestKey(key),
      Buffer.from(JSON.stringify(manifest, null, 2)),
      { contentType: 'application/json', metadata: {} }
    );
  }
}
