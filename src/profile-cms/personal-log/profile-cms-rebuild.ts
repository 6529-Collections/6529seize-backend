import fetch from 'node-fetch';
import { AppFeatures, appFeatures } from '@/app-features';
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
import {
  RecordLogReader,
  RecordsWaveReader,
  SegmentFetcher
} from '@/signed-records/record-log/record-log-reader';
import { LocalRecordsWaveReader } from '@/signed-records/record-log/records-wave-local-reader';
import { loadProviderKeys, ProviderKey } from '@/signed-records/sealed-crypto';

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

/** The records wave and segment files a walk of the record log reads. */
export interface ProfileCmsRecordLogSources {
  readonly wave: RecordsWaveReader;
  readonly fetcher: SegmentFetcher;
  readonly serviceWallets: readonly string[];
  readonly providers: readonly ProviderKey[];
}

/**
 * The record log as a rebuild reads it: the records wave from the drops the
 * records service posted (rebuilt from the relays), each segment file from
 * the run's files source by CID or Arweave id, opened with the provider
 * keys. The SIGNED_RECORDS_* settings name the wave, the service and the
 * keys.
 */
export function profileCmsRecordLogSources(
  files: string | null,
  env: Readonly<Record<string, string | undefined>> = process.env
): ProfileCmsRecordLogSources {
  if (!files) {
    throw new Error(
      'The profile site rebuild reads segment files: the run has no files source'
    );
  }
  const waveId = env.SIGNED_RECORDS_WAVE_ID;
  const profileId = env.SIGNED_RECORDS_SERVICE_PROFILE_ID;
  const wallet = env.SIGNED_RECORDS_SERVICE_WALLET?.toLowerCase();
  if (!waveId || !profileId || !wallet) {
    throw new Error(
      'SIGNED_RECORDS_WAVE_ID, SIGNED_RECORDS_SERVICE_PROFILE_ID and SIGNED_RECORDS_SERVICE_WALLET are needed to read the records wave'
    );
  }
  const providers = loadProviderKeys(env.SIGNED_RECORDS_PROVIDER_KEYS);
  if (providers.length === 0) {
    throw new Error('SIGNED_RECORDS_PROVIDER_KEYS is not configured');
  }
  return {
    wave: new LocalRecordsWaveReader({ waveId, profileId, wallet }),
    fetcher: filesSourceFetcher(files),
    serviceWallets: [wallet],
    providers
  };
}

/** Segment files from the run's files source (`/ipfs/<cid>`, `/ar/<id>`). */
function filesSourceFetcher(base: string): SegmentFetcher {
  const root = base.endsWith('/') ? base.slice(0, -1) : base;
  const get = async (path: string): Promise<Buffer> => {
    const response = await fetch(`${root}${path}`);
    if (!response.ok) {
      throw new Error(
        `The files source answered ${response.status} for ${path}`
      );
    }
    return response.buffer();
  };
  return {
    fetchCid: (cid) => get(`/ipfs/${encodeURIComponent(cid)}`),
    fetchArweave: (id) => get(`/ar/${encodeURIComponent(id)}`)
  };
}

/**
 * The private chain of the interim record log, walked from its head drops:
 * every segment in order, each checked against its head.
 */
export function createProfileCmsPrivateLogWalk(
  sources: ProfileCmsRecordLogSources
): AsyncIterable<{ readonly entry: RecordLogEntry }> {
  return new RecordLogReader(sources).walk('private');
}

/**
 * Reads no chain: with FEATURE_PROFILE_CMS_CHAIN_POINTER off the live index
 * applies no chain change, so a rebuild of what it wrote reads none either.
 */
const CHAIN_FLAG_OFF: ProfileCmsChainPort = {
  getChanges: async () => ({ changes: [], next_height: null }),
  getIdentityByPrincipal: chainFlagOff,
  getIdentityImport: chainFlagOff,
  getImportedProfileDocCid: chainFlagOff,
  getProfileDoc: chainFlagOff,
  getDocBytes: chainFlagOff,
  putDocBytes: chainFlagOff
};

async function chainFlagOff(): Promise<never> {
  throw new Error(
    'FEATURE_PROFILE_CMS_CHAIN_POINTER is off: the profile site rebuild reads no chain'
  );
}

/**
 * The rebuild check's step for every profile site table. It follows
 * FEATURE_PROFILE_CMS_CHAIN_POINTER, as the live index does: on, the
 * chain's Profile changes (through createProfileCmsChainPort, at the run's
 * gateway) and the private log; off, the private log alone, since the live
 * index then applied no chain change.
 */
export async function rebuildProfileCmsFromChainAndLog(
  ctx: {
    readonly sources: {
      readonly gateway: string | null;
      readonly files: string | null;
    };
  },
  deps: {
    readonly features?: Pick<AppFeatures, 'isProfileCmsChainPointerEnabled'>;
    readonly createPort?: (gateway: string | null) => ProfileCmsChainPort;
    readonly recordLog?: ProfileCmsRecordLogSources;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {}
): Promise<{ readonly changes: number; readonly entries: number }> {
  const env = deps.env ?? process.env;
  const fromHeight = Number(env.PROFILE_CMS_CHAIN_FROM_HEIGHT ?? '0');
  if (!Number.isSafeInteger(fromHeight) || fromHeight < 0) {
    throw new Error('PROFILE_CMS_CHAIN_FROM_HEIGHT must be a height');
  }
  const port = (deps.features ?? appFeatures).isProfileCmsChainPointerEnabled()
    ? (deps.createPort ?? createProfileCmsChainPort)(ctx.sources.gateway)
    : CHAIN_FLAG_OFF;
  const walk = createProfileCmsPrivateLogWalk(
    deps.recordLog ?? profileCmsRecordLogSources(ctx.sources.files, env)
  );
  return rebuildProfileCms(
    { port, fromHeight, privateEntries: profileCmsPrivateEntries(walk) },
    {}
  );
}
