import {
  ProfileCmsChainFollower,
  ProfileCmsSyncResult
} from '@/profile-cms/chain/profile-cms-chain-follower';
import { createProfileCmsChainPort } from '@/profile-cms/chain/profile-cms-chain-port.factory';
import { ProfileCmsChainPort } from '@/profile-cms/chain/profile-cms-chain.port';

const USAGE =
  'profile-cms:chain-sync --from-height <height> [--gateway <base url>]\n' +
  'Applies finalized Profile changes from <height> to the head to the profile site tables of the\n' +
  'database the environment names. For the side-by-side check, point it at a separate, empty database.\n' +
  'It ignores FEATURE_PROFILE_CMS_CHAIN_POINTER: it is an operator tool, not the live path.\n' +
  'As a rebuild does, it retries a change whose files are missing and fails once its tries are used up.\n';

interface SyncDeps {
  readonly createPort: (gatewayBaseUrl: string | null) => ProfileCmsChainPort;
  readonly inDb: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly write: (text: string) => void;
}

const defaultDeps: SyncDeps = {
  createPort: createProfileCmsChainPort,
  inDb: async (fn) => {
    const { doInDbContext } = await import('@/secrets');
    return doInDbContext(fn, { syncEntities: false, skipRedis: true });
  },
  write: (text) => process.stdout.write(text)
};

export async function main(
  args = process.argv.slice(2),
  deps: SyncDeps = defaultDeps
): Promise<ProfileCmsSyncResult | null> {
  if (args.includes('--help')) {
    deps.write(USAGE);
    return null;
  }
  const options = parseArgs(args);
  const port = deps.createPort(options.gateway);
  const result = await deps.inDb(() =>
    rebuildFollower(port).syncUntilSettled(options.fromHeight, {})
  );
  deps.write(
    `applied ${result.applied} Profile changes; next height ${result.nextHeight}\n`
  );
  return result;
}

/**
 * The rebuild check's step for the profile site tables: replays the Profile
 * change feed from `PROFILE_CMS_CHAIN_FROM_HEIGHT` (default 0) to the head,
 * until no change waits; a change still unreadable after its tries fails it.
 */
export async function rebuildProfileCmsFromChain(ctx: {
  readonly sources: { readonly gateway: string | null };
}): Promise<void> {
  const fromHeight = Number(process.env.PROFILE_CMS_CHAIN_FROM_HEIGHT ?? '0');
  if (!Number.isSafeInteger(fromHeight) || fromHeight < 0) {
    throw new Error('PROFILE_CMS_CHAIN_FROM_HEIGHT must be a height');
  }
  await rebuildFollower(
    createProfileCmsChainPort(ctx.sources.gateway)
  ).syncUntilSettled(fromHeight, {});
}

function rebuildFollower(port: ProfileCmsChainPort): ProfileCmsChainFollower {
  return new ProfileCmsChainFollower(port, undefined, undefined, 'rebuild');
}

function parseArgs(args: readonly string[]): {
  fromHeight: number;
  gateway: string | null;
} {
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
  const fromHeight = Number(values.get('from-height'));
  if (!Number.isSafeInteger(fromHeight) || fromHeight < 0) {
    throw new Error(`--from-height is required\n${USAGE}`);
  }
  return { fromHeight, gateway: values.get('gateway') ?? null };
}

if (require.main === module)
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Profile site chain sync failed'}\n`
    );
    process.exitCode = 1;
  });
