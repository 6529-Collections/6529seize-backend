import {
  ProfileCmsExportDb,
  ProfileCmsExporter,
  ProfileCmsExportReport,
  ProfileCmsPublicationFetcher,
  snapshotCmsValue
} from '@/profile-cms/chain/profile-cms-export';
import {
  checkExportAgainstPublicApi,
  httpPublicPrimaryLookup,
  PublicPrimaryCheckEntry,
  PublicPrimaryCheckResult
} from '@/profile-cms/chain/profile-cms-public-check';
import { canonicalizeJson } from '@/profile-cms/protocol/v1';

/** What the profile site export run is asked for (the CLI's arguments). */
export interface ProfileCmsExportRunOptions {
  /** Unix milliseconds of the freeze: the export's moment T. */
  readonly frozenAt: number;
  /** Only this profile, or every profile with a site when null. */
  readonly profile: string | null;
  /** Base URL of the public API to check primaries against, or null. */
  readonly publicApi: string | null;
}

/** Where a run writes its content-addressed files. */
export interface ProfileCmsExportSink {
  /** Called once per CID, in the order the profiles are exported. */
  writeFile(cid: string, bytes: Buffer): Promise<void>;
}

export interface ProfileCmsExportRun {
  readonly profiles: number;
  readonly fields: Record<string, unknown>;
  readonly reports: Record<string, ProfileCmsExportReport>;
  readonly publicCheck: PublicPrimaryCheckResult | null;
  /** Rebuilt publication records that fail the reader's check. */
  readonly rebuiltRefused: number;
  /** Profiles with a stored publication record that couldn't be fetched. */
  readonly unavailableProfiles: number;
  readonly files: number;
  readonly bytes: number;
}

export type JsonGetter = (
  url: string
) => Promise<{ readonly status: number; readonly body: unknown }>;

/**
 * The fetcher of stored publication records, as the export uses it: a record
 * is fetched up to three times; one that still fails is reported and fails
 * the run, never replaced.
 */
export function storedPublicationFetcher(
  frozenAt: number,
  verify: (receipt: {
    readonly provider: 'ipfs' | 'arweave';
    readonly uri: string;
    readonly content_hash: string;
    readonly recorded_at: string;
  }) => Promise<Buffer>,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  /**
   * Runs before each attempt, outside its retry: a throw (the job's
   * deadline) stops the export instead of counting as a failed fetch.
   */
  beforeAttempt: () => void = () => undefined
): ProfileCmsPublicationFetcher {
  return async (receipt) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      beforeAttempt();
      try {
        return await verify({
          provider: receipt.uri.startsWith('ipfs://') ? 'ipfs' : 'arweave',
          uri: receipt.uri,
          content_hash: receipt.content_hash,
          recorded_at: new Date(frozenAt).toISOString()
        });
      } catch {
        await sleep(attempt * 2_000);
      }
    }
    return null;
  };
}

/** Profiles exported at once at most, when asked for more than one. */
export const MAX_EXPORT_CONCURRENCY = 4;

/**
 * Exports every profile with a site (or one), writing each file once to the
 * sink as soon as its profile is done, so no more than `concurrency`
 * profiles' files are held at a time. With a concurrency above 1, that many
 * profiles are exported at once (their stored records fetched in parallel);
 * the output is the same: files are content-addressed, the reports are
 * keyed by profile id in order, and the public check runs in profile order.
 * The CLI and the dbDumpsDaily export job both run this.
 */
export async function runProfileCmsExport(
  options: ProfileCmsExportRunOptions,
  deps: {
    readonly db: Pick<ProfileCmsExportDb, 'listProfileIds' | 'loadSource'>;
    readonly exporter: Pick<ProfileCmsExporter, 'exportProfile'>;
    readonly sink: ProfileCmsExportSink;
    readonly getJson?: JsonGetter;
    /**
     * Called with (0, total) before the first profile and (done, total)
     * after each; a throw stops the run there.
     */
    readonly progress?: (done: number, total: number) => void;
    /** Called before the public API check; a throw stops the run there. */
    readonly beforePublicCheck?: () => void;
    /** Profiles exported at once, 1 to MAX_EXPORT_CONCURRENCY (default 1). */
    readonly concurrency?: number;
  }
): Promise<ProfileCmsExportRun> {
  const concurrency = deps.concurrency ?? 1;
  if (
    !Number.isSafeInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_EXPORT_CONCURRENCY
  ) {
    throw new Error(
      `concurrency must be 1 to ${MAX_EXPORT_CONCURRENCY}, not ${concurrency}`
    );
  }
  const entries = new Map<string, PublicPrimaryCheckEntry>();
  const fieldsById = new Map<string, unknown>();
  const reportsById = new Map<string, ProfileCmsExportReport>();
  // A CID is claimed before it is written, so two profiles exported at once
  // never write the same file twice.
  const claimed = new Set<string>();
  let bytes = 0;
  let done = 0;
  let failed = false;
  const profileIds = options.profile
    ? [options.profile]
    : await deps.db.listProfileIds();
  deps.progress?.(0, profileIds.length);
  const exportOne = async (profileId: string) => {
    const source = await deps.db.loadSource(profileId);
    const entry = await deps.exporter.exportProfile(
      profileId,
      source,
      options.frozenAt
    );
    for (const file of entry.files) {
      if (claimed.has(file.cid)) continue;
      claimed.add(file.cid);
      await deps.sink.writeFile(file.cid, file.bytes);
      bytes += file.bytes.length;
    }
    if (entry.cms) {
      fieldsById.set(profileId, snapshotCmsValue(entry.cms));
    }
    reportsById.set(profileId, entry.report);
    entries.set(profileId, {
      profile_id: profileId,
      handle: entry.handle,
      cms: entry.cms,
      primaryHandle: entry.report.primary_handle,
      refusedPrimaryHash: entry.report.primary_refused
        ? entry.report.primary_package_hash
        : null
    });
    done++;
    deps.progress?.(done, profileIds.length);
  };
  let next = 0;
  const worker = async () => {
    while (!failed && next < profileIds.length) {
      const profileId = profileIds[next++];
      try {
        await exportOne(profileId);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(profileIds.length, 1)) },
      worker
    )
  );
  // Profile order, whatever order the workers finished in.
  const checkEntries = profileIds
    .map((id) => entries.get(id))
    .filter((it): it is PublicPrimaryCheckEntry => !!it);
  const fields: Record<string, unknown> = {};
  const reports: Record<string, ProfileCmsExportReport> = {};
  for (const id of profileIds) {
    if (fieldsById.has(id)) fields[id] = fieldsById.get(id);
    const report = reportsById.get(id);
    if (report) reports[id] = report;
  }
  if (options.publicApi && !deps.getJson) {
    throw new Error('A public API check needs a JSON getter');
  }
  if (options.publicApi) deps.beforePublicCheck?.();
  const publicCheck =
    options.publicApi && deps.getJson
      ? await checkExportAgainstPublicApi(
          checkEntries,
          httpPublicPrimaryLookup(options.publicApi, deps.getJson)
        )
      : null;
  return {
    profiles: checkEntries.length,
    fields,
    reports,
    publicCheck,
    rebuiltRefused: Object.values(reports).reduce(
      (count, report) => count + report.rebuilt_refused.length,
      0
    ),
    unavailableProfiles: Object.values(reports).filter(
      (report) => report.publication_unavailable.length > 0
    ).length,
    files: claimed.size,
    bytes
  };
}

/** cms-fields.json: profile id -> its site and archive, canonical JSON. */
export function cmsFieldsJson(run: ProfileCmsExportRun): string {
  return canonicalizeJson(run.fields);
}

/** report.json: the per-profile reports and the public API check. */
export function reportJson(frozenAt: number, run: ProfileCmsExportRun): string {
  return JSON.stringify(
    {
      frozen_at: frozenAt,
      profiles: run.reports,
      public_check: run.publicCheck
    },
    null,
    2
  );
}

/** The summary line(s) the CLI prints and the job logs. */
export function exportSummary(run: ProfileCmsExportRun): string {
  const lines = [
    `${run.profiles} profiles, ${Object.keys(run.fields).length} with a cms value`
  ];
  if (run.publicCheck) {
    lines.push(
      `public API: ${run.publicCheck.checked} checked, ${run.publicCheck.mismatches.length} mismatches, ${run.publicCheck.refused.length} primaries refused at T`
    );
  }
  return `${lines.join('\n')}\n`;
}

/** A GET of JSON for the public API check: no redirects, 10 s timeout. */
export async function getJson(
  url: string
): Promise<{ readonly status: number; readonly body: unknown }> {
  const { default: fetch } = await import('node-fetch');
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    redirect: 'error',
    timeout: 10_000
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}
