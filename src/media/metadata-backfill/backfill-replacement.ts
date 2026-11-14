import {
  DROP_MEDIA_SANITIZED_METADATA_KEY,
  DROP_MEDIA_SANITIZED_METADATA_VALUE
} from '@/drops/drop-media-upload.config';
import { BACKFILL_RUN_METADATA_KEY } from './backfill-markers';
import {
  fileDigest,
  MediaObjectStore,
  ObjectHead,
  ObjectHeaders,
  SafetyCopyLayout,
  SafetyCopyManifest,
  sha256Base64,
  sha256Hex
} from './backfill-storage';
import { invalidationPathsFor } from './media-references';
import { ChatMediaTarget } from './chat-media-candidates';

/** An object body held in memory (images) or in a temporary file (videos). */
export interface ReplacementBody {
  readonly size: number;
  readonly sha256Hex: string;
  readonly sha256Base64: string;
  put(
    store: MediaObjectStore,
    key: string,
    headers: ObjectHeaders,
    options?: { readonly ifMatch?: string }
  ): Promise<void>;
}

export function bufferBody(bytes: Buffer): ReplacementBody {
  return {
    size: bytes.length,
    sha256Hex: sha256Hex(bytes),
    sha256Base64: sha256Base64(bytes),
    put: (store, key, headers, options) =>
      store.put(key, bytes, headers, options)
  };
}

export async function fileBody(path: string): Promise<ReplacementBody> {
  const digest = await fileDigest(path);
  return {
    size: digest.size,
    sha256Hex: digest.sha256Hex,
    sha256Base64: digest.sha256Base64,
    put: (store, key, headers, options) =>
      store.putFile(key, path, headers, options)
  };
}

export interface ReplacementWriter {
  readonly safetyStore: MediaObjectStore;
  readonly layout: SafetyCopyLayout;
  readonly onRewritten: (paths: string[]) => void;
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

/** The original and its manifest are stored and verified before any overwrite. */
async function writeSafetyCopy({
  writer,
  publicStore,
  runId,
  now,
  key,
  head,
  original,
  stripped,
  paths
}: ReplaceInPlaceInput & { paths: string[] }): Promise<void> {
  const { safetyStore, layout } = writer;
  const copyKey = layout.objectKey(key);
  await original.put(safetyStore, copyKey, head.headers);
  const copy = await safetyStore.head(copyKey);
  if (
    copy?.size !== original.size ||
    (copy.checksumSha256 !== undefined &&
      copy.checksumSha256 !== original.sha256Base64)
  ) {
    throw new SafetyCopyUnverifiedError(key);
  }
  const manifest: SafetyCopyManifest = {
    version: 1,
    run_id: runId,
    public_bucket: publicStore.bucket,
    public_key: key,
    safety_copy_key: copyKey,
    original: {
      etag: head.etag,
      version_id: head.versionId ?? null,
      size: original.size,
      sha256: original.sha256Hex
    },
    stripped: { size: stripped.size, sha256: stripped.sha256Hex },
    headers: head.headers,
    invalidation_paths: paths,
    backed_up_at: now().toISOString()
  };
  await safetyStore.put(
    layout.manifestKey(key),
    Buffer.from(JSON.stringify(manifest, null, 2)),
    { contentType: 'application/json', metadata: {} }
  );
}

export interface ReplaceInPlaceInput {
  readonly writer: ReplacementWriter;
  readonly publicStore: MediaObjectStore;
  readonly runId: string;
  readonly now: () => Date;
  readonly key: string;
  readonly head: ObjectHead;
  readonly original: ReplacementBody;
  readonly stripped: ReplacementBody;
}

/**
 * Stores a verified private safety copy and manifest, then overwrites the
 * public object only if its ETag still matches what was read, with the same
 * headers plus the privacy and run markers, and queues its CDN paths.
 */
export async function replaceInPlace(
  target: ChatMediaTarget,
  input: ReplaceInPlaceInput
): Promise<void> {
  const paths = invalidationPathsFor(target.key, target.urls);
  await writeSafetyCopy({ ...input, paths });
  const { head } = input;
  await input.stripped.put(
    input.publicStore,
    input.key,
    {
      ...head.headers,
      metadata: {
        ...head.headers.metadata,
        [DROP_MEDIA_SANITIZED_METADATA_KEY]:
          DROP_MEDIA_SANITIZED_METADATA_VALUE,
        [BACKFILL_RUN_METADATA_KEY]: input.runId
      }
    },
    { ifMatch: head.etag }
  );
  input.writer.onRewritten(paths);
}
