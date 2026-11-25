import { RequestContext } from '@/request.context';
import {
  PROFILE_CMS_MAX_CHANGE_ATTEMPTS,
  ProfileCmsChainFollower
} from '@/profile-cms/chain/profile-cms-chain-follower';
import { createProfileCmsChainPort } from '@/profile-cms/chain/profile-cms-chain-port.factory';
import {
  ProfileCmsChainPort,
  ProfileCmsProfileChange
} from '@/profile-cms/chain/profile-cms-chain.port';
import {
  PROFILE_CMS_LOG_LANE,
  ProfileCmsPrivateEntry,
  ProfileCmsPrivateLog,
  profileCmsPrivateLog,
  readProfileCmsPrivateEntry
} from '@/profile-cms/personal-log/profile-cms-private-log';
import { RecordLogEntry } from '@/signed-records/record-log/record-log-format';

type RebuildItem =
  | {
      readonly height: number;
      readonly version: number;
      readonly change: ProfileCmsProfileChange;
    }
  | {
      readonly height: number;
      readonly version: number;
      readonly entry: ProfileCmsPrivateEntry;
    };

/**
 * Rebuilds every profile site table from empty: the chain's Profile changes
 * (public rows, events, signatures, legacy sites) and the private log's
 * entries (drafts, agent grants, proposals and events). Each entry replays
 * right after the chain change it was stamped with (height, then document
 * version) and before the profile's next one; entries keep their log order.
 * Changes of different people in one block touch different profiles, so
 * ordering them by version is safe; one person's versions keep their chain
 * order. Live, the same two writers made the rows in that order.
 *
 * The follower runs in `rebuild` mode: a change still unreadable after its
 * last try fails the rebuild instead of serving no site.
 */
export async function rebuildProfileCms(
  sources: {
    readonly port: ProfileCmsChainPort;
    readonly fromHeight: number;
    readonly privateEntries:
      | AsyncIterable<ProfileCmsPrivateEntry>
      | Iterable<ProfileCmsPrivateEntry>;
  },
  ctx: RequestContext,
  deps: {
    readonly follower?: ProfileCmsChainFollower;
    readonly privateLog?: Pick<ProfileCmsPrivateLog, 'applyEntry'>;
  } = {}
): Promise<{ readonly changes: number; readonly entries: number }> {
  const follower =
    deps.follower ??
    new ProfileCmsChainFollower(sources.port, undefined, undefined, 'rebuild');
  const privateLog = deps.privateLog ?? profileCmsPrivateLog;
  const items: RebuildItem[] = [];
  for (const change of await allChanges(sources.port, sources.fromHeight)) {
    items.push({ height: change.height, version: change.version, change });
  }
  let entries = 0;
  for await (const entry of sources.privateEntries) {
    items.push({
      height: entry.height ?? -1,
      version: entry.doc_version ?? -1,
      entry
    });
    entries++;
  }
  // Array.prototype.sort is stable: entries keep their log order and
  // changes of one height and version their chain order.
  items.sort(
    (left, right) =>
      left.height - right.height ||
      left.version - right.version ||
      Number('entry' in left) - Number('entry' in right)
  );
  for (const item of items) {
    if ('change' in item) {
      // A change that waits is tried again; in rebuild mode the follower
      // fails the rebuild once its tries are used up.
      let result = await follower.applyChange(item.change, ctx);
      for (let tries = 1; result.status === 'retry'; tries++) {
        if (tries >= PROFILE_CMS_MAX_CHANGE_ATTEMPTS) {
          throw new Error(
            `Profile site rebuild stopped at height ${item.change.height}: ${result.reason}`
          );
        }
        result = await follower.applyChange(item.change, ctx);
      }
    } else {
      await privateLog.applyEntry(item.entry, ctx);
    }
  }
  return { changes: items.length - entries, entries };
}

/** The lane `publish` entries of the record log's private chain, in order. */
export async function* profileCmsPrivateEntries(
  walk: AsyncIterable<{ readonly entry: RecordLogEntry }>
): AsyncGenerator<ProfileCmsPrivateEntry> {
  for await (const { entry } of walk) {
    if (entry.t !== 'entry' || entry.lane !== PROFILE_CMS_LOG_LANE) {
      continue;
    }
    const parsed = readProfileCmsPrivateEntry(entry.body);
    if (!parsed) {
      throw new Error('Malformed profile site entry in the private record log');
    }
    yield parsed;
  }
}

async function allChanges(
  port: ProfileCmsChainPort,
  fromHeight: number
): Promise<ProfileCmsProfileChange[]> {
  const changes: ProfileCmsProfileChange[] = [];
  let height = fromHeight;
  for (;;) {
    const page = await port.getChanges(height);
    changes.push(...page.changes);
    if (page.next_height === null) {
      return changes;
    }
    if (page.next_height <= height) {
      if (page.changes.length === 0) {
        return changes;
      }
      throw new Error(
        `The chain port's page from height ${height} ends inside a block (next height ${page.next_height}); it must give whole blocks`
      );
    }
    height = page.next_height;
  }
}

/**
 * The private chain of the interim record log, walked from its head drops.
 * It needs a reader of the records wave and the record log's segment fetcher
 * and provider keys; until those are wired it refuses, so a rebuild never
 * runs without the private half.
 */
export function createProfileCmsPrivateLogWalk(): AsyncIterable<{
  readonly entry: RecordLogEntry;
}> {
  throw new Error(
    'No records wave reader yet: the private record log cannot be walked here.'
  );
}

/** The rebuild check's step for every profile site table. */
export async function rebuildProfileCmsFromChainAndLog(
  ctx: { readonly sources: { readonly gateway: string | null } },
  deps: {
    readonly createPort?: (gateway: string | null) => ProfileCmsChainPort;
    readonly privateWalk?: () => AsyncIterable<{
      readonly entry: RecordLogEntry;
    }>;
  } = {}
): Promise<void> {
  const fromHeight = Number(process.env.PROFILE_CMS_CHAIN_FROM_HEIGHT ?? '0');
  if (!Number.isSafeInteger(fromHeight) || fromHeight < 0) {
    throw new Error('PROFILE_CMS_CHAIN_FROM_HEIGHT must be a height');
  }
  const port = (deps.createPort ?? createProfileCmsChainPort)(
    ctx.sources.gateway
  );
  const walk = (deps.privateWalk ?? createProfileCmsPrivateLogWalk)();
  await rebuildProfileCms(
    { port, fromHeight, privateEntries: profileCmsPrivateEntries(walk) },
    {}
  );
}
