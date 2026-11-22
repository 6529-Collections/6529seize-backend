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
    new Promise((resolve) => setTimeout(resolve, ms))
): ProfileCmsPublicationFetcher {
  return async (receipt) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
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

/**
 * Exports every profile with a site (or one), writing each file once to the
 * sink as soon as its profile is done, so no more than one profile's files are
 * held at a time. The CLI and the dbDumpsDaily export job both run this.
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
  }
): Promise<ProfileCmsExportRun> {
  const checkEntries: PublicPrimaryCheckEntry[] = [];
  const fields: Record<string, unknown> = {};
  const reports: Record<string, ProfileCmsExportReport> = {};
  const written = new Set<string>();
  let bytes = 0;
  const profileIds = options.profile
    ? [options.profile]
    : await deps.db.listProfileIds();
  deps.progress?.(0, profileIds.length);
  for (const profileId of profileIds) {
    const source = await deps.db.loadSource(profileId);
    const entry = await deps.exporter.exportProfile(
      profileId,
      source,
      options.frozenAt
    );
    for (const file of entry.files) {
      if (written.has(file.cid)) continue;
      await deps.sink.writeFile(file.cid, file.bytes);
      written.add(file.cid);
      bytes += file.bytes.length;
    }
    if (entry.cms) {
      fields[profileId] = snapshotCmsValue(entry.cms);
    }
    reports[profileId] = entry.report;
    checkEntries.push({
      profile_id: profileId,
      handle: entry.handle,
      cms: entry.cms,
      primaryHandle: entry.report.primary_handle,
      refusedPrimaryHash: entry.report.primary_refused
        ? entry.report.primary_package_hash
        : null
    });
    deps.progress?.(checkEntries.length, profileIds.length);
  }
  if (options.publicApi && !deps.getJson) {
    throw new Error('A public API check needs a JSON getter');
  }
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
    files: written.size,
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
