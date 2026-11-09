import { describeError, KeyList } from './backfill-report';
import {
  ListedObject,
  MediaObjectStore,
  ObjectChangedError,
  SafetyCopyLayout,
  SafetyCopyManifest,
  sha256Hex
} from './backfill-storage';
import { InvalidationQueue } from './cdn-invalidation';
import { BACKFILL_RUN_METADATA_KEY } from './chat-media-object-processor';

/** Originals stay restorable at least this long; purging sooner is refused. */
export const MIN_SAFETY_PERIOD_MILLIS = 7 * 24 * 60 * 60 * 1000;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface OriginalsDeps {
  readonly publicStore: MediaObjectStore;
  readonly safetyStore: MediaObjectStore;
  readonly layout: SafetyCopyLayout;
  /** False for a dry run, which only reports what it would do. */
  readonly execute: boolean;
  /** Null in a dry run. */
  readonly invalidations: InvalidationQueue | null;
  readonly now: () => Date;
}

/** Counts and keys of one restore, purge or invalidate command. */
export class OriginalsReport {
  readonly counts: Record<string, number> = {};
  readonly keys: Record<string, KeyList> = {};
  readonly failed: { key: string; error: string }[] = [];

  constructor(
    readonly command: string,
    readonly runId: string,
    readonly mode: 'dry-run' | 'execute'
  ) {}

  add(outcome: string, key: string): void {
    this.counts[outcome] = (this.counts[outcome] ?? 0) + 1;
    this.keys[outcome] ??= new KeyList();
    this.keys[outcome].add(key);
  }

  fail(key: string, error: unknown): void {
    this.counts.failed = (this.counts.failed ?? 0) + 1;
    this.failed.push({ key, error: describeError(error) });
  }

  toJSON() {
    return {
      command: this.command,
      run_id: this.runId,
      mode: this.mode,
      counts: this.counts,
      keys: this.keys,
      failed: this.failed
    };
  }
}

interface ManifestEntry {
  readonly listed: ListedObject;
  readonly manifest: SafetyCopyManifest;
}

/** Parses a manifest and checks it belongs to this run and prefix. */
function parseManifest(
  bytes: Buffer,
  layout: SafetyCopyLayout,
  manifestKey: string
): SafetyCopyManifest {
  const manifest = JSON.parse(bytes.toString('utf8')) as SafetyCopyManifest;
  if (
    manifest.version !== 1 ||
    manifest.run_id !== layout.runId ||
    layout.manifestKey(manifest.public_key) !== manifestKey ||
    manifest.safety_copy_key !== layout.objectKey(manifest.public_key)
  ) {
    throw new Error(`Manifest ${manifestKey} does not belong to this run`);
  }
  return manifest;
}

/**
 * Restore, invalidate and purge for one backfill run. Every command reads
 * the run's manifests, so it only touches keys that run replaced, and every
 * public write is conditional on the object still being that run's output.
 */
export class BackfillOriginals {
  constructor(private readonly deps: OriginalsDeps) {}

  private get execute(): boolean {
    return this.deps.execute;
  }

  private async *manifests(
    report: OriginalsReport
  ): AsyncGenerator<ManifestEntry> {
    const { safetyStore, layout } = this.deps;
    for await (const listed of safetyStore.list(layout.manifestPrefix)) {
      try {
        const bytes = await safetyStore.getBytes(listed.key, {
          maxBytes: MAX_MANIFEST_BYTES
        });
        yield { listed, manifest: parseManifest(bytes, layout, listed.key) };
      } catch (error) {
        report.fail(listed.key, error);
      }
    }
  }

  private async writtenByRun(manifest: SafetyCopyManifest) {
    const current = await this.deps.publicStore.head(manifest.public_key);
    const ours =
      current?.headers.metadata[BACKFILL_RUN_METADATA_KEY] === manifest.run_id;
    return { current, ours };
  }

  /** Puts each original back (or one key) and invalidates its CDN paths. */
  async restore(onlyKey: string | null): Promise<OriginalsReport> {
    const report = new OriginalsReport(
      'restore',
      this.deps.layout.runId,
      this.mode
    );
    for await (const { manifest } of this.manifests(report)) {
      if (onlyKey !== null && manifest.public_key !== onlyKey) continue;
      try {
        report.add(await this.restoreOne(manifest), manifest.public_key);
      } catch (error) {
        report.fail(manifest.public_key, error);
      }
    }
    await this.deps.invalidations?.flush();
    return report;
  }

  private async restoreOne(manifest: SafetyCopyManifest): Promise<string> {
    const { current, ours } = await this.writtenByRun(manifest);
    if (!current) return 'public_object_missing';
    if (!ours) {
      return current.etag === manifest.original.etag
        ? 'already_original'
        : 'changed_since_run';
    }
    const original = await this.deps.safetyStore.getBytes(
      manifest.safety_copy_key,
      {
        maxBytes: manifest.original.size
      }
    );
    if (sha256Hex(original) !== manifest.original.sha256) {
      throw new Error('Safety copy does not match its manifest checksum');
    }
    if (!this.execute) return 'would_restore';
    try {
      await this.deps.publicStore.put(
        manifest.public_key,
        original,
        manifest.headers,
        {
          ifMatch: current.etag
        }
      );
    } catch (error) {
      if (error instanceof ObjectChangedError) return 'changed_since_run';
      throw error;
    }
    this.deps.invalidations!.add(manifest.invalidation_paths);
    return 'restored';
  }

  /** Re-submits CDN invalidations for keys still holding this run's output. */
  async invalidate(): Promise<OriginalsReport> {
    const report = new OriginalsReport(
      'invalidate',
      this.deps.layout.runId,
      this.mode
    );
    for await (const { manifest } of this.manifests(report)) {
      try {
        const { ours } = await this.writtenByRun(manifest);
        if (!ours) {
          report.add('not_current', manifest.public_key);
          continue;
        }
        this.deps.invalidations?.add(manifest.invalidation_paths);
        report.add(
          this.execute ? 'invalidated' : 'would_invalidate',
          manifest.public_key
        );
      } catch (error) {
        report.fail(manifest.public_key, error);
      }
    }
    await this.deps.invalidations?.flush();
    return report;
  }

  /**
   * Deletes the run's private originals older than the safety period, which
   * may not be shorter than seven days. With `deleteNoncurrentVersions`, and
   * only on a versioned public bucket, it first deletes the noncurrent public
   * version holding each original, because that version would otherwise
   * keep the metadata retrievable.
   */
  async purge({
    olderThanMillis,
    deleteNoncurrentVersions
  }: {
    olderThanMillis: number;
    deleteNoncurrentVersions: boolean;
  }): Promise<OriginalsReport> {
    if (olderThanMillis < MIN_SAFETY_PERIOD_MILLIS) {
      throw new Error('--older-than must be at least 7d');
    }
    if (deleteNoncurrentVersions) await this.assertVersionedPublicBucket();
    const report = new OriginalsReport(
      'purge-originals',
      this.deps.layout.runId,
      this.mode
    );
    const cutoff = this.deps.now().getTime() - olderThanMillis;
    // A failed version deletion keeps that key's original and manifest.
    const keep = new Set<string>();
    if (deleteNoncurrentVersions) {
      for await (const { listed, manifest } of this.manifests(report)) {
        if (listed.lastModified.getTime() >= cutoff) continue;
        if (!(await this.purgeNoncurrentVersion(manifest, report))) {
          keep.add(listed.key);
          keep.add(manifest.safety_copy_key);
        }
      }
    }
    await this.purgeObjects(cutoff, keep, report);
    return report;
  }

  private async assertVersionedPublicBucket(): Promise<void> {
    const status = await this.deps.publicStore.versioningStatus();
    if (status !== 'Enabled' && status !== 'Suspended') {
      throw new Error(
        `The public bucket versioning status is ${status}; there are no noncurrent versions to delete`
      );
    }
  }

  /** False when the version could not be handled, so its original is kept. */
  private async purgeNoncurrentVersion(
    manifest: SafetyCopyManifest,
    report: OriginalsReport
  ): Promise<boolean> {
    try {
      const { ours } = await this.writtenByRun(manifest);
      if (!ours) {
        report.add('noncurrent_kept_not_current', manifest.public_key);
        return true;
      }
      const versions = await this.deps.publicStore.listVersions(
        manifest.public_key
      );
      const originals = versions.filter(
        (version) =>
          !version.isLatest &&
          (manifest.original.version_id
            ? version.versionId === manifest.original.version_id
            : version.etag === manifest.original.etag)
      );
      for (const version of originals) {
        if (this.execute) {
          await this.deps.publicStore.deleteVersion(
            manifest.public_key,
            version.versionId
          );
        }
        report.add(
          this.execute
            ? 'noncurrent_version_deleted'
            : 'noncurrent_version_would_delete',
          manifest.public_key
        );
      }
      return true;
    } catch (error) {
      report.fail(manifest.public_key, error);
      return false;
    }
  }

  private async purgeObjects(
    cutoff: number,
    keep: ReadonlySet<string>,
    report: OriginalsReport
  ) {
    const { safetyStore, layout } = this.deps;
    for await (const listed of safetyStore.list(layout.runPrefix)) {
      if (!listed.key.startsWith(layout.runPrefix)) continue;
      if (keep.has(listed.key)) {
        report.add('kept_version_not_deleted', listed.key);
        continue;
      }
      if (listed.lastModified.getTime() >= cutoff) {
        report.add('kept_too_recent', listed.key);
        continue;
      }
      try {
        if (this.execute) await safetyStore.delete(listed.key);
        report.add(this.execute ? 'deleted' : 'would_delete', listed.key);
      } catch (error) {
        report.fail(listed.key, error);
      }
    }
  }

  private get mode(): 'dry-run' | 'execute' {
    return this.execute ? 'execute' : 'dry-run';
  }
}
