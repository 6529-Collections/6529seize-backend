import { createHash, randomBytes } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  StorageClass
} from '@aws-sdk/client-s3';

/** HTTP headers and user metadata of an object, preserved across rewrites. */
export interface ObjectHeaders {
  readonly contentType?: string;
  readonly cacheControl?: string;
  readonly contentDisposition?: string;
  readonly contentEncoding?: string;
  readonly contentLanguage?: string;
  readonly expires?: string;
  readonly storageClass?: string;
  readonly metadata: Record<string, string>;
}

export interface ObjectHead {
  readonly etag: string;
  readonly size: number;
  readonly versionId?: string;
  readonly checksumSha256?: string;
  readonly lastModified?: Date;
  readonly headers: ObjectHeaders;
}

export interface ListedObject {
  readonly key: string;
  readonly size: number;
  readonly lastModified: Date;
}

export interface ObjectVersion {
  readonly key: string;
  readonly versionId: string;
  readonly etag: string;
  readonly isLatest: boolean;
}

export type VersioningStatus = 'Enabled' | 'Suspended' | 'Disabled' | 'unknown';

export interface LifecycleExpiration {
  readonly prefix: string;
  readonly days: number | null;
}

/** The object changed since it was read: an S3 conditional request failed. */
export class ObjectChangedError extends Error {
  constructor(key: string) {
    super(`Object ${key} changed during the run`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ObjectChangedError';
  }
}

export class ObjectTooLargeError extends Error {
  constructor(key: string) {
    super(`Object ${key} is larger than the read limit`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'ObjectTooLargeError';
  }
}

export interface MediaObjectStore {
  readonly bucket: string;
  head(key: string): Promise<ObjectHead | null>;
  getBytes(
    key: string,
    options: { readonly ifMatch?: string; readonly maxBytes: number }
  ): Promise<Buffer>;
  getRange(key: string, start: number, endInclusive: number): Promise<Buffer>;
  put(
    key: string,
    body: Buffer,
    headers: ObjectHeaders,
    options?: { readonly ifMatch?: string }
  ): Promise<void>;
  list(prefix: string): AsyncIterable<ListedObject>;
  delete(key: string): Promise<void>;
  versioningStatus(): Promise<VersioningStatus>;
  listVersions(key: string): Promise<ObjectVersion[]>;
  deleteVersion(key: string, versionId: string): Promise<void>;
  /** True when all four public access blocks are on; null when unreadable. */
  publicAccessFullyBlocked(): Promise<boolean | null>;
  /** Enabled expiration rules; null when unreadable. */
  expiringLifecycleRules(): Promise<LifecycleExpiration[] | null>;
}

export function sha256Base64(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('base64');
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
}

function nameOf(error: unknown): string | undefined {
  return (error as { name?: string })?.name;
}

function isNotFound(error: unknown): boolean {
  const name = nameOf(error);
  return statusOf(error) === 404 || name === 'NotFound' || name === 'NoSuchKey';
}

function isPreconditionFailed(error: unknown): boolean {
  return statusOf(error) === 412 || nameOf(error) === 'PreconditionFailed';
}

function definedHeaders(headers: ObjectHeaders) {
  return {
    ContentType: headers.contentType,
    CacheControl: headers.cacheControl,
    ContentDisposition: headers.contentDisposition,
    ContentEncoding: headers.contentEncoding,
    ContentLanguage: headers.contentLanguage,
    Expires: headers.expires ? new Date(headers.expires) : undefined,
    StorageClass: headers.storageClass as StorageClass | undefined,
    Metadata: headers.metadata
  };
}

async function readBody(body: unknown, key: string): Promise<Buffer> {
  const stream = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (!stream?.transformToByteArray) {
    throw new Error(`Missing object body for ${key}`);
  }
  return Buffer.from(await stream.transformToByteArray());
}

/** One S3 bucket. Every write carries a SHA-256 checksum that S3 verifies. */
export class S3MediaObjectStore implements MediaObjectStore {
  constructor(
    private readonly s3: S3Client,
    readonly bucket: string
  ) {}

  async head(key: string): Promise<ObjectHead | null> {
    try {
      const head = await this.s3.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ChecksumMode: 'ENABLED'
        })
      );
      return {
        etag: head.ETag ?? '',
        size: head.ContentLength ?? 0,
        versionId: head.VersionId,
        checksumSha256: head.ChecksumSHA256,
        lastModified: head.LastModified,
        headers: {
          contentType: head.ContentType,
          cacheControl: head.CacheControl,
          contentDisposition: head.ContentDisposition,
          contentEncoding: head.ContentEncoding,
          contentLanguage: head.ContentLanguage,
          expires: head.Expires?.toISOString(),
          storageClass: head.StorageClass,
          metadata: { ...(head.Metadata ?? {}) }
        }
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getBytes(
    key: string,
    { ifMatch, maxBytes }: { ifMatch?: string; maxBytes: number }
  ): Promise<Buffer> {
    try {
      const object = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          IfMatch: ifMatch
        })
      );
      if ((object.ContentLength ?? 0) > maxBytes) {
        (object.Body as { destroy?: () => void })?.destroy?.();
        throw new ObjectTooLargeError(key);
      }
      const bytes = await readBody(object.Body, key);
      if (
        object.ContentLength !== undefined &&
        bytes.length !== object.ContentLength
      ) {
        throw new Error(`Short read of ${key}`);
      }
      return bytes;
    } catch (error) {
      if (isPreconditionFailed(error)) throw new ObjectChangedError(key);
      throw error;
    }
  }

  async getRange(key: string, start: number, endInclusive: number) {
    const object = await this.s3.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: `bytes=${start}-${endInclusive}`
      })
    );
    return readBody(object.Body, key);
  }

  async put(
    key: string,
    body: Buffer,
    headers: ObjectHeaders,
    options?: { ifMatch?: string }
  ): Promise<void> {
    try {
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ChecksumSHA256: sha256Base64(body),
          IfMatch: options?.ifMatch,
          ...definedHeaders(headers)
        })
      );
    } catch (error) {
      if (isPreconditionFailed(error)) throw new ObjectChangedError(key);
      throw error;
    }
  }

  async *list(prefix: string): AsyncIterable<ListedObject> {
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token
        })
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        yield {
          key: object.Key,
          size: object.Size ?? 0,
          lastModified: object.LastModified ?? new Date(0)
        };
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  async delete(key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }

  async versioningStatus(): Promise<VersioningStatus> {
    try {
      const result = await this.s3.send(
        new GetBucketVersioningCommand({ Bucket: this.bucket })
      );
      if (result.Status === 'Enabled' || result.Status === 'Suspended') {
        return result.Status;
      }
      return 'Disabled';
    } catch {
      return 'unknown';
    }
  }

  async listVersions(key: string): Promise<ObjectVersion[]> {
    const versions: ObjectVersion[] = [];
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectVersionsCommand({
          Bucket: this.bucket,
          Prefix: key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker
        })
      );
      for (const version of page.Versions ?? []) {
        if (version.Key !== key || !version.VersionId) continue;
        versions.push({
          key,
          versionId: version.VersionId,
          etag: version.ETag ?? '',
          isLatest: version.IsLatest === true
        });
      }
      keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      versionMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (keyMarker);
    return versions;
  }

  async deleteVersion(key: string, versionId: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
        VersionId: versionId
      })
    );
  }

  async publicAccessFullyBlocked(): Promise<boolean | null> {
    try {
      const result = await this.s3.send(
        new GetPublicAccessBlockCommand({ Bucket: this.bucket })
      );
      const config = result.PublicAccessBlockConfiguration;
      return !!(
        config?.BlockPublicAcls &&
        config.BlockPublicPolicy &&
        config.IgnorePublicAcls &&
        config.RestrictPublicBuckets
      );
    } catch {
      return null;
    }
  }

  async expiringLifecycleRules(): Promise<LifecycleExpiration[] | null> {
    try {
      const result = await this.s3.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: this.bucket })
      );
      return (result.Rules ?? [])
        .filter((rule) => rule.Status === 'Enabled' && rule.Expiration)
        .map((rule) => ({
          prefix:
            rule.Filter?.Prefix ??
            rule.Filter?.And?.Prefix ??
            rule.Prefix ??
            '',
          days: rule.Expiration?.Days ?? null
        }));
    } catch (error) {
      return nameOf(error) === 'NoSuchLifecycleConfiguration' ? [] : null;
    }
  }
}

const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const STAGE = /^(?:prod|staging|local)$/;

export function newRunId(now: Date, suffix = randomBytes(4).toString('hex')) {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return `${stamp}-${suffix}`;
}

export function assertRunId(runId: string): string {
  if (!RUN_ID.test(runId)) {
    throw new Error(
      `Invalid run id "${runId}"; expected e.g. 20261116T120000Z-1a2b3c4d`
    );
  }
  return runId;
}

/**
 * Where one run keeps its private originals: `<stage>/backfill-originals/
 * <run id>/objects/<public key>` holds each original with its headers, and
 * `.../manifest/<public key>.json` records what was replaced. The stage
 * segment keeps staging and production apart in the shared private bucket,
 * and no lifecycle rule covers this prefix, so nothing expires on its own.
 */
export class SafetyCopyLayout {
  readonly runPrefix: string;

  constructor(
    readonly stage: string,
    readonly runId: string
  ) {
    if (!STAGE.test(stage)) throw new Error(`Invalid stage "${stage}"`);
    assertRunId(runId);
    this.runPrefix = `${stage}/backfill-originals/${runId}/`;
  }

  get manifestPrefix(): string {
    return `${this.runPrefix}manifest/`;
  }

  objectKey(publicKey: string): string {
    return `${this.runPrefix}objects/${publicKey}`;
  }

  manifestKey(publicKey: string): string {
    return `${this.manifestPrefix}${publicKey}.json`;
  }
}

/** What one overwrite replaced; never contains image metadata values. */
export interface SafetyCopyManifest {
  readonly version: 1;
  readonly run_id: string;
  readonly public_bucket: string;
  readonly public_key: string;
  readonly safety_copy_key: string;
  readonly original: {
    readonly etag: string;
    readonly version_id: string | null;
    readonly size: number;
    readonly sha256: string;
  };
  readonly stripped: { readonly size: number; readonly sha256: string };
  readonly headers: ObjectHeaders;
  readonly invalidation_paths: string[];
  readonly backed_up_at: string;
}

/**
 * Refuses to write unless the safety bucket is a different, fully private
 * bucket with no expiration rule over the run prefix, so originals stay
 * until an explicit purge.
 */
export async function assertSafetyLocation(
  safety: MediaObjectStore,
  publicStore: MediaObjectStore,
  layout: SafetyCopyLayout
): Promise<void> {
  if (safety.bucket === publicStore.bucket) {
    throw new Error('The safety bucket must not be the public bucket');
  }
  if ((await safety.publicAccessFullyBlocked()) !== true) {
    throw new Error(
      `Could not verify that ${safety.bucket} blocks all public access`
    );
  }
  const rules = await safety.expiringLifecycleRules();
  if (rules === null) {
    throw new Error(`Could not read the lifecycle rules of ${safety.bucket}`);
  }
  const covering = rules.filter((rule) =>
    layout.runPrefix.startsWith(rule.prefix)
  );
  if (covering.length) {
    throw new Error(
      `A lifecycle expiration rule covers ${layout.runPrefix}; originals would expire on their own`
    );
  }
}
