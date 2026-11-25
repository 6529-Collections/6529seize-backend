import { cmsHashFromCid } from '@/profile-cms/chain/profile-cms-cid';
import { ProfileDocCms } from '@/profile-cms/chain/profile-doc-cms';

/** The public API's answer for one handle: its primary package hash, or none. */
export type PublicPrimaryLookup = (
  handle: string
) => Promise<
  | { readonly status: 'found'; readonly package_hash: string }
  | { readonly status: 'none' }
  | { readonly status: 'error'; readonly detail: string }
>;

export interface PublicPrimaryCheckEntry {
  readonly profile_id: string;
  readonly handle: string | null;
  /** The site and archive the export carries for this profile, or null. */
  readonly cms: ProfileDocCms | null;
  /** The handle the exported primary was published under, if any. */
  readonly primaryHandle: string | null;
  /**
   * The package hash of a primary the export refused at T (the reader's
   * check failed), which the public API still serves; null if none.
   */
  readonly refusedPrimaryHash: string | null;
}

export interface PublicPrimaryMismatch {
  readonly profile_id: string;
  readonly handle: string | null;
  readonly exported: string | null;
  readonly public: string | null;
  readonly detail?: string;
}

export interface PublicPrimaryCheckResult {
  readonly checked: number;
  readonly mismatches: readonly PublicPrimaryMismatch[];
  /**
   * Profiles whose primary the export refused at T and the public API still
   * serves: expected differences, listed apart from the mismatches. After the
   * switch these serve no site.
   */
  readonly refused: readonly PublicPrimaryMismatch[];
}

/** At most two requests a second to the public API. */
export const PUBLIC_API_MIN_INTERVAL_MS = 500;

/**
 * An independent check of the export: for every exported profile with a
 * handle, the package the exported site names must be the package the public
 * API serves as that profile's primary today (both absent counts as a
 * match). A primary the export refused at T and the public API serves is
 * listed under `refused`, not as a mismatch. The public API serves only the
 * current primary, so this checks nothing else in the archive.
 */
export async function checkExportAgainstPublicApi(
  entries: readonly PublicPrimaryCheckEntry[],
  lookup: PublicPrimaryLookup,
  wait: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms))
): Promise<PublicPrimaryCheckResult> {
  const mismatches: PublicPrimaryMismatch[] = [];
  const refused: PublicPrimaryMismatch[] = [];
  let checked = 0;
  for (const entry of entries) {
    const carried = exportedPrimaryHash(entry.cms);
    // 6529.io serves no site whose handle changed since it was published, and
    // neither will the chain index: compare what both would serve.
    const exported =
      carried &&
      entry.handle &&
      entry.primaryHandle?.toLowerCase() !== entry.handle.toLowerCase()
        ? null
        : carried;
    if (!entry.handle) {
      if (exported) {
        mismatches.push({
          ...base(entry),
          exported,
          public: null,
          detail: 'no_handle'
        });
      }
      continue;
    }
    if (checked > 0) {
      await wait(PUBLIC_API_MIN_INTERVAL_MS);
    }
    checked++;
    const answer = await lookup(entry.handle);
    if (answer.status === 'error') {
      mismatches.push({
        ...base(entry),
        exported,
        public: null,
        detail: answer.detail
      });
      continue;
    }
    const served = answer.status === 'found' ? answer.package_hash : null;
    if (served === exported) {
      continue;
    }
    if (exported === null && served === entry.refusedPrimaryHash) {
      refused.push({
        ...base(entry),
        exported,
        public: served,
        detail: 'refused_at_t'
      });
      continue;
    }
    mismatches.push({ ...base(entry), exported, public: served });
  }
  return { checked, mismatches, refused };
}

/** A lookup over HTTP: GET {apiBase}/profile-cms/{handle}/primary, no credentials. */
export function httpPublicPrimaryLookup(
  apiBase: string,
  fetchJson: (
    url: string
  ) => Promise<{ readonly status: number; readonly body: unknown }>
): PublicPrimaryLookup {
  const root = apiBase.replace(/\/+$/, '');
  return async (handle) => {
    let response: { status: number; body: unknown };
    try {
      response = await fetchJson(
        `${root}/profile-cms/${encodeURIComponent(handle)}/primary`
      );
    } catch (error) {
      return {
        status: 'error',
        detail: error instanceof Error ? error.message : 'request_failed'
      };
    }
    if (response.status === 404) {
      return { status: 'none' };
    }
    const packageHash = (response.body as { package_hash?: unknown } | null)
      ?.package_hash;
    if (response.status !== 200 || typeof packageHash !== 'string') {
      return { status: 'error', detail: `http_${response.status}` };
    }
    return { status: 'found', package_hash: packageHash };
  };
}

function exportedPrimaryHash(cms: ProfileDocCms | null): string | null {
  return cms?.primary ? cmsHashFromCid(cms.primary.package) : null;
}

function base(entry: PublicPrimaryCheckEntry): {
  profile_id: string;
  handle: string | null;
} {
  return { profile_id: entry.profile_id, handle: entry.handle };
}
