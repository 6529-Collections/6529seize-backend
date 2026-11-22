import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProfileCmsExporter,
  profileCmsExportDb,
  ProfileCmsExportReport,
  snapshotCmsValue
} from '@/profile-cms/chain/profile-cms-export';
import {
  checkExportAgainstPublicApi,
  httpPublicPrimaryLookup,
  PublicPrimaryCheckEntry,
  PublicPrimaryCheckResult
} from '@/profile-cms/chain/profile-cms-public-check';
import { canonicalizeJson } from '@/profile-cms/protocol/v1';

const USAGE =
  'profile-cms:export --out <dir> --frozen-at <epoch ms> [--profile <profile id>] [--public-api <api base url>]\n' +
  'Read-only. Writes <dir>/files/<cid> (cores, publication records, archive files, legacy packages),\n' +
  '<dir>/cms-fields.json (profile id -> its site and archive, in the shape the identity snapshot builder reads) and <dir>/report.json.\n' +
  'With --public-api, also checks each exported primary against GET <api base url>/profile-cms/{handle}/primary,\n' +
  'unauthenticated, at most two requests a second, and writes the result into report.json.\n';

interface ExportOptions {
  readonly out: string;
  readonly frozenAt: number;
  readonly profile: string | null;
  readonly publicApi: string | null;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  if (args.includes('--help')) {
    process.stdout.write(USAGE);
    return;
  }
  const options = parseArgs(args);
  const { doInDbContext } = await import('@/secrets');
  const { profileCmsPublicationStorage } =
    await import('@/profile-cms/profile-cms-publication-storage');
  // A stored publication record is fetched up to three times; one that still
  // fails is reported and fails the run, never replaced.
  const exporter = new ProfileCmsExporter(async (receipt) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await profileCmsPublicationStorage.verify({
          provider: receipt.uri.startsWith('ipfs://') ? 'ipfs' : 'arweave',
          uri: receipt.uri,
          content_hash: receipt.content_hash,
          recorded_at: new Date(options.frozenAt).toISOString()
        });
      } catch {
        await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
      }
    }
    return null;
  });
  const checkEntries: PublicPrimaryCheckEntry[] = [];
  const fields: Record<string, unknown> = {};
  const reports: Record<string, ProfileCmsExportReport> = {};
  await doInDbContext(
    async () => {
      const profileIds = options.profile
        ? [options.profile]
        : await profileCmsExportDb.listProfileIds();
      await mkdir(join(options.out, 'files'), { recursive: true });
      for (const profileId of profileIds) {
        const source = await profileCmsExportDb.loadSource(profileId);
        const entry = await exporter.exportProfile(
          profileId,
          source,
          options.frozenAt
        );
        for (const file of entry.files) {
          await writeFile(join(options.out, 'files', file.cid), file.bytes);
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
      }
    },
    { syncEntities: false, skipRedis: true }
  );
  const publicCheck = options.publicApi
    ? await checkExportAgainstPublicApi(
        checkEntries,
        httpPublicPrimaryLookup(options.publicApi, getJson)
      )
    : null;
  await writeFile(
    join(options.out, 'cms-fields.json'),
    canonicalizeJson(fields)
  );
  await writeFile(
    join(options.out, 'report.json'),
    JSON.stringify(
      {
        frozen_at: options.frozenAt,
        profiles: reports,
        public_check: publicCheck
      },
      null,
      2
    )
  );
  process.stdout.write(summary(checkEntries.length, fields, publicCheck));
  const refused = Object.values(reports).reduce(
    (count, report) => count + report.rebuilt_refused.length,
    0
  );
  if (refused > 0) {
    process.stderr.write(
      `${refused} rebuilt publication records fail the reader's check; see rebuilt_refused in report.json.\n`
    );
  }
  const unavailable = Object.entries(reports).filter(
    ([, report]) => report.publication_unavailable.length > 0
  );
  if (unavailable.length > 0) {
    process.stderr.write(
      `${unavailable.length} profiles have stored publication records that could not be fetched; see report.json. Do not use this export.\n`
    );
    process.exitCode = 1;
  }
}

function summary(
  profiles: number,
  fields: Record<string, unknown>,
  publicCheck: PublicPrimaryCheckResult | null
): string {
  const lines = [
    `${profiles} profiles, ${Object.keys(fields).length} with a cms value`
  ];
  if (publicCheck) {
    lines.push(
      `public API: ${publicCheck.checked} checked, ${publicCheck.mismatches.length} mismatches, ${publicCheck.refused.length} primaries refused at T`
    );
  }
  return `${lines.join('\n')}\n`;
}

async function getJson(
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

function parseArgs(args: readonly string[]): ExportOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      !key?.startsWith('--') ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new Error(`Invalid arguments\n${USAGE}`);
    }
    values.set(key.slice(2), value);
  }
  const out = values.get('out');
  const frozenAt = Number(values.get('frozen-at'));
  if (!out || !Number.isSafeInteger(frozenAt) || frozenAt <= 0) {
    throw new Error(`--out and --frozen-at are required\n${USAGE}`);
  }
  const publicApi = values.get('public-api') ?? null;
  if (publicApi !== null && !/^https:\/\/[^/]+/.test(publicApi)) {
    throw new Error(`--public-api must be an https URL\n${USAGE}`);
  }
  return {
    out,
    frozenAt,
    profile: values.get('profile') ?? null,
    publicApi
  };
}

if (require.main === module)
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Profile site export failed'}\n`
    );
    process.exitCode = 1;
  });
