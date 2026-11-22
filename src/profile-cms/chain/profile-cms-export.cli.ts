import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ProfileCmsExporter,
  profileCmsExportDb
} from '@/profile-cms/chain/profile-cms-export';
import {
  cmsFieldsJson,
  exportSummary,
  getJson,
  reportJson,
  runProfileCmsExport,
  storedPublicationFetcher
} from '@/profile-cms/chain/profile-cms-export.run';

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
  const exporter = new ProfileCmsExporter(
    storedPublicationFetcher(options.frozenAt, (receipt) =>
      profileCmsPublicationStorage.verify(receipt)
    )
  );
  const run = await doInDbContext(
    async () => {
      await mkdir(join(options.out, 'files'), { recursive: true });
      return await runProfileCmsExport(options, {
        db: profileCmsExportDb,
        exporter,
        sink: {
          writeFile: (cid, bytes) =>
            writeFile(join(options.out, 'files', cid), bytes)
        },
        getJson
      });
    },
    { syncEntities: false, skipRedis: true }
  );
  await writeFile(join(options.out, 'cms-fields.json'), cmsFieldsJson(run));
  await writeFile(
    join(options.out, 'report.json'),
    reportJson(options.frozenAt, run)
  );
  process.stdout.write(exportSummary(run));
  if (run.rebuiltRefused > 0) {
    process.stderr.write(
      `${run.rebuiltRefused} rebuilt publication records fail the reader's check; see rebuilt_refused in report.json.
`
    );
  }
  if (run.unavailableProfiles > 0) {
    process.stderr.write(
      `${run.unavailableProfiles} profiles have stored publication records that could not be fetched; see report.json. Do not use this export.
`
    );
    process.exitCode = 1;
  }
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
