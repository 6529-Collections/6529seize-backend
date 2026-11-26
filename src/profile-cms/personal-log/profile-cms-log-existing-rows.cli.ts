import {
  ProfileCmsPrivateLog,
  profileCmsPrivateLog
} from '@/profile-cms/personal-log/profile-cms-private-log';

const USAGE =
  'profile-cms:log-existing-rows\n' +
  'Appends every row the profile site private log covers, as it stands now, to the interim\n' +
  "record log's private chain. Run it once, after FEATURE_PROFILE_CMS_PERSONAL_LOG=true is live\n" +
  'on the API (every new write is logged from then on), with the same flag set here.\n' +
  'Running it again is harmless: a rebuild replays each row as it stood the last time.\n';

interface LogExistingRowsDeps {
  readonly privateLog: Pick<ProfileCmsPrivateLog, 'logExistingRows'>;
  readonly inDb: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly write: (text: string) => void;
}

const defaultDeps: LogExistingRowsDeps = {
  privateLog: profileCmsPrivateLog,
  inDb: async (fn) => {
    const { doInDbContext } = await import('@/secrets');
    return doInDbContext(fn, { syncEntities: false, skipRedis: true });
  },
  write: (text) => process.stdout.write(text)
};

export async function main(
  args = process.argv.slice(2),
  deps: LogExistingRowsDeps = defaultDeps
): Promise<number | null> {
  if (args.includes('--help')) {
    deps.write(USAGE);
    return null;
  }
  if (args.length > 0) {
    throw new Error(`Unexpected arguments\n${USAGE}`);
  }
  const logged = await deps.inDb(() => deps.privateLog.logExistingRows({}));
  deps.write(`logged ${logged} existing profile site rows\n`);
  return logged;
}

if (require.main === module)
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Logging existing rows failed'}\n`
    );
    process.exitCode = 1;
  });
