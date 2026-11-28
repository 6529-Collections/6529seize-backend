import * as mcache from 'memory-cache';
import {
  UserGroupsService,
  userGroupsService
} from '@/api/community-members/user-groups.service';
import { MetricsRecorder } from '@/metrics/MetricsRecorder';
import { getRedisClient, WAVE_GROUPS_VERSION_CACHE_KEY } from '@/redis';
import {
  aChainGroupRow,
  chainWord,
  FakeDocuments,
  fakeObjectEffects,
  FakeObjectsStore
} from '@/tests/fixtures/waves-chain-mirror.objects.fixture';
import { Time } from '@/time';
import { UserGroupsDb, userGroupsDb } from '@/user-groups/user-groups.db';
import { groupRowOf, NO_CRITERIA } from './waves-chain-mirror.groups';
import { groupListId } from './waves-chain-mirror.ids';
import { WavesChainObjectsMirror } from './waves-chain-mirror.objects';
import { defaultObjectEffects } from './waves-chain-mirror.objects.effects';
import { PlanCounter } from './waves-chain-mirror.plan-support';

jest.mock('@/redis', () => ({
  ...jest.requireActual('@/redis'),
  getRedisClient: jest.fn(),
  waitForRedisReady: jest.fn().mockResolvedValue(true)
}));

const G = chainWord('0a');
const A1 = `0x${'a1'.repeat(20)}`;
const Z = 'profile-z';
const INCLUDE = groupListId(G, 1, 'include');
const ELIGIBILITY_KEYS = 'cache_6529_eligible_groups';

/**
 * Redis as the eligibility cache uses it: its own keys, and the lease and
 * publish scripts. The wave groups' catalogue keys aren't kept, so the
 * catalogue is read from the database each time.
 */
function fakeRedis() {
  const keys = new Map<string, string>([[WAVE_GROUPS_VERSION_CACHE_KEY, '7']]);
  return {
    isReady: true,
    get: jest.fn(async (key: string) => keys.get(key) ?? null),
    set: jest.fn(
      async (key: string, value: string, options?: { NX?: boolean }) => {
        if (!key.startsWith(ELIGIBILITY_KEYS)) return 'OK';
        if (options?.NX && keys.has(key)) return null;
        keys.set(key, value);
        return 'OK';
      }
    ),
    del: jest.fn(async (key: string) => Number(keys.delete(key))),
    eval: jest.fn(
      async (
        script: string,
        options?: { keys?: string[]; arguments?: string[] }
      ) => {
        const [lease, result, marker] = options?.keys ?? [];
        const args = options?.arguments ?? [];
        if (script.includes("redis.call('SET', KEYS[2], ARGV[3]")) {
          // A result is kept only under its lease, at the marker it read.
          if (
            keys.get(lease) !== args[0] ||
            (keys.get(marker) ?? '') !== args[1]
          ) {
            return 0;
          }
          keys.set(result, args[2]);
          keys.delete(lease);
          return 1;
        }
        if (script.includes("redis.call('GET', KEYS[1]) == ARGV[1]")) {
          if (keys.get(lease) === args[0]) keys.delete(lease);
        }
        return 1;
      }
    )
  };
}

/** What eligibility reads, with G's list as the mirror's store holds it. */
function eligibilityDb(
  store: FakeObjectsStore,
  changes: ReadonlyMap<string, number[]>
) {
  const group = {
    ...groupRowOf({
      id: G,
      name: 'Posters',
      createdAt: new Date(1),
      createdBy: 'profile-1',
      criteria: NO_CRITERIA,
      repUser: null,
      includeListId: INCLUDE,
      excludeListId: null,
      visible: true,
      isPrivate: false
    }),
    is_pure_profile_group: true
  };
  return {
    getLatestProfileGroupChangeMillis: jest.fn(async (profileId: string) => {
      const times = changes.get(profileId) ?? [];
      return times.length ? Math.max(...times) : null;
    }),
    getAllWaveRelatedGroups: jest.fn().mockResolvedValue([G]),
    getIdentityByProfileId: jest.fn().mockResolvedValue({
      profile_id: Z,
      rep: 0,
      cic: 0,
      tdh: 0,
      xtdh: 0,
      level_raw: 0
    }),
    getByIds: jest.fn().mockResolvedValue([group]),
    getGroupsUserIsEligibleByIdentity: jest.fn(async () =>
      store.lists.get(INCLUDE)?.has(Z) ? [G] : []
    ),
    getGroupsUserIsExcludedFromByIdentity: jest.fn().mockResolvedValue([]),
    getGivenCicAndRep: jest.fn().mockResolvedValue({ cic: 0, rep: 0 }),
    getAllProfileOwnedTokensByProfileIdGroupedByContract: jest
      .fn()
      .mockResolvedValue({}),
    getRatings: jest.fn().mockResolvedValue([]),
    findBeneficiaryGrantGroupIdsForProfile: jest.fn().mockResolvedValue([])
  };
}

describe("a profile a group's member lists drop, and its cached eligibility", () => {
  let now = 0;
  beforeEach(() => {
    mcache.clear();
    jest.spyOn(Time, 'currentMillis').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['after the cached answer was computed', 1_050],
    ['in the millisecond the cached answer was computed', 1_000]
  ])(
    "can't post in the chat that group gates on the next read, when the change logged after the commit lands %s",
    async (_, committedAt) => {
      const redis = fakeRedis();
      (getRedisClient as jest.Mock).mockReturnValue(redis);
      // profile_group_changes, by profile.
      const changes = new Map<string, number[]>();
      const log = (profiles: readonly string[], at: number) =>
        profiles.forEach((p) =>
          changes.set(p, [...(changes.get(p) ?? []), at])
        );
      jest
        .spyOn(userGroupsDb, 'insertGroupChanges')
        .mockImplementation(async (profiles) => {
          log(profiles, now);
          return null;
        });
      // The wave groups' cache clear isn't what is under test.
      jest
        .spyOn(userGroupsService, 'onWaveRelatedGroupsChanged')
        .mockResolvedValue(undefined);

      const store = new FakeObjectsStore();
      store.addressProfiles.set(A1, Z);
      store.chainGroups = [
        aChainGroupRow(G, { includes: [{ kind: 'address', value: A1 }] })
      ];
      // The change rows written with the lists are stamped inside their
      // transaction, before it commits: here before the read that is cached.
      const rewrite = store.rewriteGroupLists.bind(store);
      store.rewriteGroupLists = async (lists, profiles) => {
        await rewrite(lists, profiles);
        log(profiles, 900);
      };
      const mirror = new WavesChainObjectsMirror(
        store,
        async (ids) => new Map(ids.map((id) => [id, 'profile-1'])),
        {
          ...fakeObjectEffects(),
          groupsChanged: defaultObjectEffects.groupsChanged
        },
        { check: jest.fn() },
        () => now
      );
      const run = () =>
        mirror.run({
          write: true,
          documents: new FakeDocuments(),
          counter: new PlanCounter(),
          outOfTime: () => false
        });
      now = 500;
      await run();
      expect(store.lists.get(INCLUDE)).toEqual(new Set([Z]));

      const db = eligibilityDb(store, changes);
      const service = new UserGroupsService(
        db as unknown as UserGroupsDb,
        {} as unknown as MetricsRecorder
      );
      // The wave's chat group, as drop creation checks it.
      const wave = { chat_group_id: G };
      now = 1_000;
      expect(await service.getGroupsUserIsEligibleFor(Z)).toContain(
        wave.chat_group_id
      );
      // Cached: the next read computes nothing.
      const computed = db.getGroupsUserIsEligibleByIdentity.mock.calls.length;
      now = 1_010;
      expect(await service.getGroupsUserIsEligibleFor(Z)).toContain(
        wave.chat_group_id
      );
      expect(db.getGroupsUserIsEligibleByIdentity).toHaveBeenCalledTimes(
        computed
      );

      // A1 leaves Z: the re-check drops Z, and logs it again after commit.
      store.addressProfiles.set(A1, 'profile-own-a1');
      now = committedAt;
      await run();
      expect(store.lists.get(INCLUDE)).toEqual(new Set(['profile-own-a1']));
      expect(changes.get(Z)).toEqual([500, 900, committedAt]);

      // The very next read, well inside the cache's lifetime.
      now = 1_100;
      expect(await service.getGroupsUserIsEligibleFor(Z)).not.toContain(
        wave.chat_group_id
      );
      expect(db.getGroupsUserIsEligibleByIdentity).toHaveBeenCalledTimes(
        computed + 1
      );
    }
  );
});
