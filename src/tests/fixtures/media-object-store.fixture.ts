import { createHash } from 'node:crypto';
import {
  LifecycleExpiration,
  ListedObject,
  MediaObjectStore,
  ObjectChangedError,
  ObjectHead,
  ObjectHeaders,
  ObjectTooLargeError,
  ObjectVersion,
  VersioningStatus
} from '@/media/metadata-backfill/backfill-storage';

interface StoredObject {
  body: Buffer;
  headers: ObjectHeaders;
  etag: string;
  versionId: string;
  lastModified: Date;
}

/**
 * An in-memory S3 bucket with conditional writes, versions and an operation
 * log, for tests of the media backfill. Writes keep every version; reads see
 * the latest.
 */
export class InMemoryObjectStore implements MediaObjectStore {
  readonly operations: string[] = [];
  private readonly versions = new Map<string, StoredObject[]>();
  private versionCounter = 0;
  versioning: VersioningStatus = 'Disabled';
  publicAccessBlocked: boolean | null = true;
  lifecycle: LifecycleExpiration[] | null = [];
  now = () => new Date('2026-11-16T12:00:00Z');
  /** Called before each put; throwing simulates a storage failure. */
  beforePut: (key: string) => void = () => undefined;

  constructor(readonly bucket: string) {}

  seed(key: string, body: Buffer, headers: Partial<ObjectHeaders> = {}) {
    this.store(key, body, { metadata: {}, ...headers });
  }

  bodyOf(key: string): Buffer | undefined {
    return this.latest(key)?.body;
  }

  headersOf(key: string): ObjectHeaders | undefined {
    return this.latest(key)?.headers;
  }

  versionsOf(key: string): readonly StoredObject[] {
    return this.versions.get(key) ?? [];
  }

  keys(): string[] {
    return Array.from(this.versions.keys()).filter((key) => this.latest(key));
  }

  setLastModified(key: string, date: Date): void {
    const latest = this.latest(key);
    if (latest) latest.lastModified = date;
  }

  private latest(key: string): StoredObject | undefined {
    const versions = this.versions.get(key);
    return versions?.[versions.length - 1];
  }

  private store(key: string, body: Buffer, headers: ObjectHeaders) {
    const object: StoredObject = {
      body: Buffer.from(body),
      headers: { ...headers, metadata: { ...headers.metadata } },
      etag: `"${createHash('md5').update(body).digest('hex')}"`, // NOSONAR: test fixture imitating S3 ETag (MD5 by S3 definition); not security-sensitive.
      versionId: `v${++this.versionCounter}`,
      lastModified: this.now()
    };
    const versions = this.versions.get(key) ?? [];
    if (this.versioning === 'Enabled') versions.push(object);
    else versions.splice(0, versions.length, object);
    this.versions.set(key, versions);
  }

  async head(key: string): Promise<ObjectHead | null> {
    this.operations.push(`head ${key}`);
    const object = this.latest(key);
    if (!object) return null;
    return {
      etag: object.etag,
      size: object.body.length,
      versionId: this.versioning === 'Disabled' ? undefined : object.versionId,
      checksumSha256: createHash('sha256').update(object.body).digest('base64'),
      lastModified: object.lastModified,
      headers: { ...object.headers, metadata: { ...object.headers.metadata } }
    };
  }

  async getBytes(
    key: string,
    { ifMatch, maxBytes }: { ifMatch?: string; maxBytes: number }
  ): Promise<Buffer> {
    this.operations.push(`get ${key}`);
    const object = this.latest(key);
    if (!object)
      throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
    if (ifMatch !== undefined && ifMatch !== object.etag) {
      throw new ObjectChangedError(key);
    }
    if (object.body.length > maxBytes) throw new ObjectTooLargeError(key);
    return Buffer.from(object.body);
  }

  async getRange(key: string, start: number, endInclusive: number) {
    this.operations.push(`range ${key} ${start}-${endInclusive}`);
    const object = this.latest(key);
    if (!object) throw new Error('NoSuchKey');
    return object.body.subarray(start, endInclusive + 1);
  }

  async put(
    key: string,
    body: Buffer,
    headers: ObjectHeaders,
    options?: { ifMatch?: string }
  ): Promise<void> {
    this.operations.push(`put ${key}`);
    this.beforePut(key);
    const current = this.latest(key);
    if (options?.ifMatch !== undefined && options.ifMatch !== current?.etag) {
      throw new ObjectChangedError(key);
    }
    this.store(key, body, headers);
  }

  list(prefix: string): AsyncIterable<ListedObject> {
    this.operations.push(`list ${prefix}`);
    const listed = this.keys()
      .filter((key) => key.startsWith(prefix))
      .sort((a, b) => a.localeCompare(b))
      .map((key) => {
        const object = this.latest(key)!;
        return {
          key,
          size: object.body.length,
          lastModified: object.lastModified
        };
      });
    return asyncIterableOf(listed);
  }

  async delete(key: string): Promise<void> {
    this.operations.push(`delete ${key}`);
    this.versions.delete(key);
  }

  async versioningStatus(): Promise<VersioningStatus> {
    return this.versioning;
  }

  async listVersions(key: string): Promise<ObjectVersion[]> {
    const versions = this.versions.get(key) ?? [];
    return versions.map((version, index) => ({
      key,
      versionId: version.versionId,
      etag: version.etag,
      isLatest: index === versions.length - 1
    }));
  }

  async deleteVersion(key: string, versionId: string): Promise<void> {
    this.operations.push(`delete-version ${key} ${versionId}`);
    const versions = this.versions.get(key) ?? [];
    this.versions.set(
      key,
      versions.filter((version) => version.versionId !== versionId)
    );
  }

  async publicAccessFullyBlocked(): Promise<boolean | null> {
    return this.publicAccessBlocked;
  }

  async expiringLifecycleRules(): Promise<LifecycleExpiration[] | null> {
    return this.lifecycle;
  }
}

/** A snapshot served as an async iterable, like a paginated S3 listing. */
function asyncIterableOf<T>(items: readonly T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        next: (): Promise<IteratorResult<T>> =>
          Promise.resolve(
            index < items.length
              ? { value: items[index++], done: false }
              : { value: undefined, done: true }
          )
      };
    }
  };
}
