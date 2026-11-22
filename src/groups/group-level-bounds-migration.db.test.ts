import 'reflect-metadata';
import path from 'node:path';
import * as mcache from 'memory-cache';
import { mock } from 'ts-jest-mocker';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { USER_GROUPS_TABLE } from '@/constants';
import * as profileLevel from '@/profiles/profile-level';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { withProfileGroups } from '@/tests/fixtures/profile-group.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { UserGroupsDb } from '@/user-groups/user-groups.db';

type LevelBoundsMigration = {
  readonly up: (db: {
    runSql: (sql: string) => Promise<unknown>;
  }) => Promise<unknown>;
};

// The first rewrite ships while levels end at 100. The second, the same
// rewrite, runs just before levels go above 100 and catches groups saved in
// the old form while the first was deploying.
const MIGRATIONS = [
  '20261122180000-rewrite-group-level-bounds-for-uncapped-levels',
  '20261123090000-rewrite-group-level-bounds-saved-during-rollout'
];
const loadMigration = (name: string) =>
  require(
    path.resolve(process.cwd(), `migrations/${name}.js`)
  ) as LevelBoundsMigration;

// Made-up scores around and above level 100's border of 25,000,000. Each
// name is the score's level; while levels ended at 100, every score from
// 25,000,000 up was level 100.
const SCORES: Record<string, number> = {
  negative: -100,
  zero: 0,
  low: 1000,
  l99: 24500000,
  l100: 25000000,
  l100top: 25900000,
  l101: 26000000,
  l104: 30000000,
  l110: 38000000,
  l150: 180000000,
  l200: 1300000000
};

const fakeWallet = (index: number) =>
  `0x${index.toString(16).padStart(40, '0')}`;

const identityNames = Object.keys(SCORES);
const everyone = [...identityNames].sort((a, b) => a.localeCompare(b));
const profileId = (name: string) => `level-bounds-${name}`;
const identities = identityNames.map((name, index) =>
  anIdentity(
    {
      level_raw: SCORES[name],
      tdh: Math.max(SCORES[name], 0)
    },
    {
      consolidation_key: fakeWallet(index + 1),
      profile_id: profileId(name),
      primary_address: fakeWallet(index + 1),
      handle: `level-bounds-${name}`
    }
  )
);
const nameByProfileId = Object.fromEntries(
  identityNames.map((name) => [profileId(name), name])
);

const INCLUDE_ZERO = 'level-bounds-list-zero';
const INCLUDE_TOP = 'level-bounds-list-top';
const EXCLUDE_104 = 'level-bounds-exclude-104';
const INCLUDE_LOW = 'level-bounds-list-low';

const profileGroupRows = [
  { profile_group_id: INCLUDE_ZERO, profile_id: profileId('zero') },
  { profile_group_id: INCLUDE_TOP, profile_id: profileId('l200') },
  { profile_group_id: EXCLUDE_104, profile_id: profileId('l104') },
  { profile_group_id: INCLUDE_LOW, profile_id: profileId('low') }
];

type Bounds = { level_min: number | null; level_max: number | null };

type GroupSpec = {
  readonly name: string;
  readonly before: Partial<UserGroupEntity>;
  // The bounds after the migration, when it changes them.
  readonly after?: Bounds;
};

const GROUPS: GroupSpec[] = [
  { name: 'max-99', before: { level_max: 99 } },
  {
    name: 'max-100',
    before: { level_max: 100 },
    after: { level_min: 0, level_max: null }
  },
  {
    name: 'max-120',
    before: { level_max: 120 },
    after: { level_min: 0, level_max: null }
  },
  {
    name: 'max-150',
    before: { level_max: 150 },
    after: { level_min: 0, level_max: null }
  },
  { name: 'max-negative', before: { level_max: -1 } },
  { name: 'min-0', before: { level_min: 0 } },
  { name: 'min-1', before: { level_min: 1 } },
  { name: 'min-100', before: { level_min: 100 } },
  {
    name: 'min-101',
    before: { level_min: 101 },
    after: { level_min: 101, level_max: -1 }
  },
  {
    name: 'min-150',
    before: { level_min: 150 },
    after: { level_min: 150, level_max: -1 }
  },
  {
    name: 'min-negative-max-100',
    before: { level_min: -5, level_max: 100 },
    after: { level_min: -5, level_max: null }
  },
  {
    name: 'min-50-max-100',
    before: { level_min: 50, level_max: 100 },
    after: { level_min: 50, level_max: null }
  },
  {
    name: 'min-100-max-100',
    before: { level_min: 100, level_max: 100 },
    after: { level_min: 100, level_max: null }
  },
  {
    name: 'min-150-max-200',
    before: { level_min: 150, level_max: 200 },
    after: { level_min: 150, level_max: -1 }
  },
  { name: 'min-150-max-50', before: { level_min: 150, level_max: 50 } },
  {
    name: 'max-100-with-list',
    before: { level_max: 100, profile_group_id: INCLUDE_ZERO },
    after: { level_min: 0, level_max: null }
  },
  {
    name: 'min-101-with-list',
    before: { level_min: 101, profile_group_id: INCLUDE_TOP },
    after: { level_min: 101, level_max: -1 }
  },
  {
    name: 'max-100-with-exclusion',
    before: { level_max: 100, excluded_profile_group_id: EXCLUDE_104 },
    after: { level_min: 0, level_max: null }
  },
  {
    name: 'max-100-with-tdh',
    before: { level_max: 100, tdh_min: 30000000 },
    after: { level_min: 0, level_max: null }
  },
  {
    name: 'min-110-with-tdh',
    before: { level_min: 110, tdh_min: 0 },
    after: { level_min: 110, level_max: -1 }
  },
  { name: 'list-only', before: { profile_group_id: INCLUDE_LOW } }
];

const groupId = (name: string) => `level-bounds--${name}`;
const groups = GROUPS.map((spec) =>
  aUserGroup(
    { is_direct_message: false, ...spec.before },
    { id: groupId(spec.name), name: spec.name }
  )
);
const groupNameById = Object.fromEntries(
  GROUPS.map((spec) => [groupId(spec.name), spec.name])
);

const boundsBefore = (spec: GroupSpec): Bounds => ({
  level_min: spec.before.level_min ?? null,
  level_max: spec.before.level_max ?? null
});

/** Group name to sorted member names. */
type Membership = Record<string, string[]>;

const realGetLevelFromScore = profileLevel.getLevelFromScore;
const realGetBorder = profileLevel.getLevelComponentsBorderByLevel;

/**
 * Runs the code as it was while levels ended at 100. The table up to level
 * 100 did not change, so that level is today's capped at 100, and the border
 * of any level above 100 was Number.MAX_SAFE_INTEGER. With that border, a
 * level_max of 100 or more gives the SQL bound level_raw <
 * Number.MAX_SAFE_INTEGER, which no score here reaches; the capped code left
 * that bound out. So the member sets are the capped code's.
 */
function useLevelsCappedAt100() {
  jest
    .spyOn(profileLevel, 'getLevelFromScore')
    .mockImplementation((score) => Math.min(realGetLevelFromScore(score), 100));
  jest
    .spyOn(profileLevel, 'getLevelComponentsBorderByLevel')
    .mockImplementation((level) =>
      level > 100 ? Number.MAX_SAFE_INTEGER : realGetBorder(level)
    );
}

describeWithSeed(
  'group level bounds migration',
  [
    withIdentities(identities),
    withProfileGroups(profileGroupRows),
    withUserGroups(groups)
  ],
  () => {
    const userGroupsDb = new UserGroupsDb(() => sqlExecutor);
    const service = new UserGroupsService(userGroupsDb, mock(), mock());

    beforeEach(() => {
      mcache.clear();
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    async function sqlMembership(
      read: (id: string) => Promise<{
        sql: string;
        params: Record<string, any>;
      } | null>
    ): Promise<Membership> {
      const result: Membership = {};
      for (const spec of GROUPS) {
        const view = await read(groupId(spec.name));
        if (view === null) {
          throw new Error(`No member SQL for ${spec.name}`);
        }
        const rows = await sqlExecutor.execute<{ profile_id: string }>(
          `${view.sql} select profile_id from ${UserGroupsService.GENERATED_VIEW}`,
          view.params
        );
        result[spec.name] = rows
          .map((row) => nameByProfileId[row.profile_id])
          .filter((name) => name !== undefined)
          .sort((a, b) => a.localeCompare(b));
      }
      return result;
    }

    async function inMemoryMembership(): Promise<Membership> {
      const result: Membership = Object.fromEntries(
        GROUPS.map((spec) => [spec.name, [] as string[]])
      );
      for (const name of identityNames) {
        const eligible = await service.getGroupsUserIsEligibleForByIds(
          profileId(name),
          groups.map((it) => it.id)
        );
        for (const id of eligible) {
          result[groupNameById[id]].push(name);
        }
      }
      for (const name of Object.keys(result)) {
        result[name].sort((a, b) => a.localeCompare(b));
      }
      return result;
    }

    /** Membership through the SQL, broadcast and in-memory paths. */
    async function membershipOnEveryPath(): Promise<Membership> {
      mcache.clear();
      const bySql = await sqlMembership((id) =>
        service.getSqlAndParamsByGroupId(id, {})
      );
      const byBroadcast = await sqlMembership((id) =>
        service.getSqlAndParamsByGroupIdForSystemBroadcast(
          id,
          {},
          { forOnlineRecipients: true }
        )
      );
      const inMemory = await inMemoryMembership();
      expect(byBroadcast).toEqual(bySql);
      expect(inMemory).toEqual(bySql);
      return bySql;
    }

    async function migrate(name: string) {
      await loadMigration(name).up({
        runSql: (sql: string) => sqlExecutor.execute(sql)
      });
    }

    async function storedBounds(idPrefix: string) {
      const rows = await sqlExecutor.execute<{
        id: string;
        level_min: number | null;
        level_max: number | null;
        is_pure_profile_group: number;
      }>(
        `select id, level_min, level_max, is_pure_profile_group from ${USER_GROUPS_TABLE} where id like :prefix`,
        { prefix: `${idPrefix}%` }
      );
      return Object.fromEntries(
        rows.map((row) => [
          row.id.slice(idPrefix.length),
          {
            level_min: row.level_min === null ? null : Number(row.level_min),
            level_max: row.level_max === null ? null : Number(row.level_max),
            pure: !!row.is_pure_profile_group
          }
        ])
      );
    }

    it.each(MIGRATIONS)(
      'keeps every group the same members across %s and levels above 100',
      async (name) => {
        useLevelsCappedAt100();
        const before = await membershipOnEveryPath();
        // Levels ending at 100: everyone is at most level 100, and nobody
        // is above it.
        expect(before['max-100']).toEqual(everyone);
        expect(before['max-150']).toEqual(everyone);
        expect(before['min-101']).toEqual([]);
        expect(before['min-101-with-list']).toEqual(['l200']);
        expect(before['max-100-with-list']).toEqual(everyone);
        expect(before['max-100-with-exclusion']).toEqual(
          everyone.filter((it) => it !== 'l104')
        );
        jest.restoreAllMocks();

        // Without the rewrite, levels above 100 would change these groups.
        const unmigrated = await membershipOnEveryPath();
        const above100 = ['l101', 'l104', 'l110', 'l150', 'l200'];
        expect(unmigrated['max-100']).toEqual(
          everyone.filter((it) => !above100.includes(it))
        );
        expect(unmigrated['min-101']).toEqual(above100);

        jest.spyOn(console, 'log').mockImplementation(() => {});
        await migrate(name);
        jest.restoreAllMocks();

        // The rewritten rows, while levels still end at 100.
        useLevelsCappedAt100();
        expect(await membershipOnEveryPath()).toEqual(before);
        jest.restoreAllMocks();

        // Then levels above 100.
        expect(await membershipOnEveryPath()).toEqual(before);
      }
    );

    it.each(MIGRATIONS)(
      '%s rewrites the bounds and logs the counts',
      async (name) => {
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        await migrate(name);
        // Counts and bound values only: no group ids, names or creators.
        expect(log.mock.calls).toEqual([
          [
            'levels migration: statement 1 rewrites 5 community_groups rows: ' +
              '(min 101, max null) x2, (min 110, max null) x1, ' +
              '(min 150, max null) x1, (min 150, max 200) x1'
          ],
          ['levels migration: statement 1 updated 5 community_groups rows'],
          [
            'levels migration: statement 2 rewrites 9 community_groups rows: ' +
              '(min null, max 100) x4, (min null, max 120) x1, ' +
              '(min null, max 150) x1, (min -5, max 100) x1, ' +
              '(min 50, max 100) x1, (min 100, max 100) x1'
          ],
          ['levels migration: statement 2 updated 9 community_groups rows']
        ]);
        log.mockClear();
        const expected = Object.fromEntries(
          GROUPS.map((spec) => [
            spec.name,
            {
              ...(spec.after ?? boundsBefore(spec)),
              pure: spec.name === 'list-only'
            }
          ])
        );
        expect(await storedBounds(groupId(''))).toEqual(expected);
        // A group keeps a level bound, so none becomes a list-only group.
        // Running the statements again changes nothing.
        await migrate(name);
        expect(await storedBounds(groupId(''))).toEqual(expected);
        expect(log.mock.calls).toEqual([
          ['levels migration: statement 1 rewrites 0 community_groups rows'],
          ['levels migration: statement 1 updated 0 community_groups rows'],
          ['levels migration: statement 2 rewrites 0 community_groups rows'],
          ['levels migration: statement 2 updated 0 community_groups rows']
        ]);
        log.mockRestore();
      }
    );

    it('stores a new save as given', async () => {
      const saved: Bounds[] = [
        { level_min: null, level_max: 100 },
        { level_min: null, level_max: 150 },
        { level_min: 120, level_max: null },
        { level_min: 101, level_max: 200 },
        { level_min: null, level_max: 99 }
      ];
      await userGroupsDb.executeNativeQueriesInTransaction(
        async (connection) => {
          for (let index = 0; index < saved.length; index++) {
            const { is_pure_profile_group: _pure, ...entity } = aUserGroup(
              { is_direct_message: false, ...saved[index] },
              { id: `level-bounds-save--${index}`, name: `save ${index}` }
            );
            await userGroupsDb.save(entity, connection);
          }
        }
      );
      expect(await storedBounds('level-bounds-save--')).toEqual(
        Object.fromEntries(
          saved.map((bounds, index) => [`${index}`, { ...bounds, pure: false }])
        )
      );
    });
  }
);
