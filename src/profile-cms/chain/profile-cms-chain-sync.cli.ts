import {
  ProfileCmsChainFollower,
  ProfileCmsSyncResult
} from '@/profile-cms/chain/profile-cms-chain-follower';
import { createProfileCmsChainPort } from '@/profile-cms/chain/profile-cms-chain-port.factory';
import { ProfileCmsChainPort } from '@/profile-cms/chain/profile-cms-chain.port';

const USAGE =
  'profile-cms:chain-sync --from-height <height>\n' +
  'Applies finalized Profile changes from <height> to the head to the profile site tables of the\n' +
  'database the environment names. For the side-by-side check, point it at a separate, empty database.\n' +
  'It reads the chain at CHAIN_GATEWAY_URL, through the identity mirror, as the live index does.\n' +
  'It ignores FEATURE_PROFILE_CMS_CHAIN_POINTER: it is an operator tool, not the live path.\n' +
  'As a rebuild does, it retries a change whose files are missing and fails once its tries are used up.\n';

interface SyncDeps {
  readonly createPort: () => ProfileCmsChainPort;
  readonly inDb: <T>(fn: () => Promise<T>) => Promise<T>;
  readonly write: (text: string) => void;
}

const defaultDeps: SyncDeps = {
  createPort: () => createProfileCmsChainPort(),
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
  const fromHeight = parseFromHeight(args);
  const port = deps.createPort();
  const result = await deps.inDb(() =>
    rebuildFollower(port).syncUntilSettled(fromHeight, {})
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

function parseFromHeight(args: readonly string[]): number {
  if (args.length !== 2 || args[0] !== '--from-height') {
    throw new Error(`Invalid arguments\n${USAGE}`);
  }
  const fromHeight = Number(args[1]);
  if (!Number.isSafeInteger(fromHeight) || fromHeight < 0) {
    throw new Error(`--from-height must be a height\n${USAGE}`);
  }
  return fromHeight;
}

if (require.main === module)
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Profile site chain sync failed'}\n`
    );
    process.exitCode = 1;
  });
