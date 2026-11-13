import { CLOUDFRONT_LINK } from '@/constants';
import type { LegacyDmMediaEntry } from './legacy-dm-purge';

/**
 * Media of unencrypted DMs, deleted after their rows (D146). The purge writes
 * a manifest of what it unlinked; this module turns it into S3 targets and
 * deletes every version, but only of objects no remaining row references.
 * IPFS pins are listed for the operator to unpin by hand (see the runbook):
 * copies other IPFS nodes already fetched cannot be recalled.
 */

/** One S3 deletion target: an exact key, or a whole per-upload directory. */
export interface LegacyDmMediaTarget {
  readonly bucket: string;
  readonly key: string;
  /** `prefix`: delete everything under `key` (a `drops/<uuid>/` directory). */
  readonly scope: 'exact' | 'prefix';
  /** The CloudFront path to invalidate, or null for private buckets. */
  readonly cdnPath: string | null;
}

export interface LegacyDmObjectVersion {
  readonly key: string;
  readonly versionId: string | null;
  readonly size: number;
}

export interface LegacyDmObjectStore {
  listVersions(
    bucket: string,
    prefix: string
  ): Promise<LegacyDmObjectVersion[]>;
  deleteVersions(
    bucket: string,
    versions: readonly LegacyDmObjectVersion[]
  ): Promise<number>;
}

/** Drop media keys are unique per upload: `drops/<uuid>/<file>`. */
const DROP_MEDIA_KEY = /^drops\/([0-9a-f-]{36})\/[^/]+$/i;

/** The S3 key behind a 6529 CDN URL, or null for any other host. */
export function mediaKeyFromUrl(url: string): string | null {
  const prefix = `${CLOUDFRONT_LINK}/`;
  if (!url.startsWith(prefix)) return null;
  const path = url.slice(prefix.length).split(/[?#]/)[0];
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return null;
  }
}

/**
 * Resized variants live beside the original (`<dir>/<size>/<file>`), so a
 * per-upload `drops/<uuid>/` directory is deleted whole. Any other key is
 * deleted exactly; its variants are matched by the caller's listing.
 */
export function targetForKey(
  bucket: string,
  key: string,
  cdn: boolean
): LegacyDmMediaTarget {
  const match = DROP_MEDIA_KEY.exec(key);
  if (match) {
    const dir = `drops/${match[1]}/`;
    return {
      bucket,
      key: dir,
      scope: 'prefix',
      cdnPath: cdn ? `/${dir}*` : null
    };
  }
  return { bucket, key, scope: 'exact', cdnPath: cdn ? `/${key}` : null };
}

export interface LegacyDmMediaBuckets {
  /** The public images bucket behind CLOUDFRONT_LINK. */
  readonly publicBucket: string;
}

export interface LegacyDmMediaTargets {
  readonly targets: LegacyDmMediaTarget[];
  readonly ipfsCids: string[];
  /** URLs on other hosts: not 6529's to delete; reported. */
  readonly externalUrls: string[];
}

/** Deduplicated deletion targets from manifest entries. */
export function mediaTargetsFromManifest(
  entries: readonly LegacyDmMediaEntry[],
  buckets: LegacyDmMediaBuckets
): LegacyDmMediaTargets {
  const targets = new Map<string, LegacyDmMediaTarget>();
  const ipfs = new Set<string>();
  const external = new Set<string>();
  const addTarget = (target: LegacyDmMediaTarget) =>
    targets.set(`${target.bucket}\n${target.key}\n${target.scope}`, target);
  for (const entry of entries) {
    switch (entry.kind) {
      case 'drop_media_url': {
        const key = mediaKeyFromUrl(entry.url);
        if (key) addTarget(targetForKey(buckets.publicBucket, key, true));
        else external.add(entry.url);
        break;
      }
      case 'upload_object':
        if (entry.role === 'public') {
          addTarget(targetForKey(buckets.publicBucket, entry.key, true));
        } else if (entry.bucket) {
          addTarget({
            bucket: entry.bucket,
            key: entry.key,
            scope: 'exact',
            cdnPath: null
          });
        }
        break;
      case 'attachment_object':
        if (entry.bucket) {
          addTarget({
            bucket: entry.bucket,
            key: entry.key,
            scope: 'exact',
            cdnPath: null
          });
        }
        break;
      case 'attachment_ipfs':
        ipfs.add(entry.cid);
        break;
    }
  }
  const byKey = (a: LegacyDmMediaTarget, b: LegacyDmMediaTarget) =>
    `${a.bucket}/${a.key}`.localeCompare(`${b.bucket}/${b.key}`);
  return {
    targets: Array.from(targets.values()).sort(byKey),
    ipfsCids: Array.from(ipfs).sort((a, b) => a.localeCompare(b)),
    externalUrls: Array.from(external).sort((a, b) => a.localeCompare(b))
  };
}

export interface LegacyDmMediaResult {
  readonly targets: number;
  readonly skippedStillReferenced: number;
  readonly versions: number;
  readonly bytes: number;
  readonly deletedVersions: number;
  readonly cdnPaths: string[];
}

/**
 * Lists (dry run) or deletes every version of each target. A target that a
 * remaining database row still references is skipped: media can be shared
 * with a public drop, and only DM-only objects may go.
 */
export async function deleteLegacyDmMedia(input: {
  readonly targets: readonly LegacyDmMediaTarget[];
  readonly store: LegacyDmObjectStore;
  readonly isStillReferenced: (target: LegacyDmMediaTarget) => Promise<boolean>;
  readonly execute: boolean;
  readonly log?: (line: string) => void;
}): Promise<LegacyDmMediaResult> {
  const log = input.log ?? (() => undefined);
  let skipped = 0;
  let versions = 0;
  let bytes = 0;
  let deleted = 0;
  const cdnPaths: string[] = [];
  for (const target of input.targets) {
    if (await input.isStillReferenced(target)) {
      skipped += 1;
      log(`skip (still referenced): ${target.bucket}/${target.key}`);
      continue;
    }
    const listPrefix =
      target.scope === 'prefix'
        ? target.key
        : target.key.slice(0, target.key.lastIndexOf('/') + 1);
    const listed = (
      await input.store.listVersions(target.bucket, listPrefix)
    ).filter(
      (v) => target.scope === 'prefix' || isExactOrVariant(target.key, v.key)
    );
    versions += listed.length;
    bytes += listed.reduce((sum, v) => sum + v.size, 0);
    if (input.execute && listed.length) {
      for (let i = 0; i < listed.length; i += 1000) {
        deleted += await input.store.deleteVersions(
          target.bucket,
          listed.slice(i, i + 1000)
        );
      }
      if (target.cdnPath) cdnPaths.push(target.cdnPath);
    }
  }
  log(
    `${input.execute ? 'deleted' : 'would delete'} ${input.execute ? deleted : versions} object versions (${bytes} bytes); ${skipped} targets skipped`
  );
  return {
    targets: input.targets.length,
    skippedStillReferenced: skipped,
    versions,
    bytes,
    deletedVersions: deleted,
    cdnPaths
  };
}

/** `dir/file` itself, or a resized variant `dir/<size>/file` of it. */
export function isExactOrVariant(key: string, candidate: string): boolean {
  if (candidate === key) return true;
  const slash = key.lastIndexOf('/');
  const dir = key.slice(0, slash + 1);
  const file = key.slice(slash + 1);
  if (!candidate.startsWith(dir) || !candidate.endsWith(`/${file}`))
    return false;
  const middle = candidate.slice(
    dir.length,
    candidate.length - file.length - 1
  );
  return middle.length > 0 && !middle.includes('/');
}
