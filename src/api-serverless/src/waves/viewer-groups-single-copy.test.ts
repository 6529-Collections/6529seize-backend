import { DropsDb } from '@/drops/drops.db';
import { SqlExecutor } from '@/sql-executor';
import { resetViewerGroupsCteSupport } from '@/waves/viewer-groups-cte';
import { WavesApiDb } from './waves.api.db';

type Recorded = { sql: string; params: Record<string, unknown> };

/** Answers the collation probe as `collation`, records every other statement. */
function fakeExecutor(collation: 'match' | 'mismatch') {
  const statements: Recorded[] = [];
  const answer = async (sql: string, params: Record<string, unknown> = {}) => {
    if (sql.includes('information_schema.columns')) {
      const name =
        collation === 'match' ? 'utf8mb4_0900_ai_ci' : 'utf8mb4_unicode_ci';
      return (params.tables as string[]).map(() => ({ collation_name: name }));
    }
    statements.push({ sql, params });
    return sql.includes('count(*) as count') ? [{ count: 5 }] : [];
  };
  const db = {
    execute: jest.fn(answer),
    oneOrNull: jest.fn(async (sql: string, params?: Record<string, unknown>) =>
      answer(sql, params).then(() => ({ cnt: 0 }))
    )
  } as unknown as SqlExecutor;
  return { db, statements };
}

const groups = Array.from({ length: 300 }, (_, i) => `group-${i}`);
const waveIds = Array.from({ length: 20 }, (_, i) => `wave-${i}`);

/** Each case: the call, its shared table's name and its group checks per statement. */
const cases: [
  string,
  string,
  number,
  (waves: WavesApiDb, drops: DropsDb) => Promise<unknown>
][] = [
  [
    'follow candidates',
    'fc_viewer_groups',
    2,
    (waves) =>
      (waves as any).findFollowedCandidateWaveIds({
        authenticated_user_id: 'viewer',
        waveIds,
        eligibleGroups: groups
      })
  ],
  [
    'waves by ids',
    'wi_viewer_groups',
    2,
    (waves) => waves.findWavesByIds(waveIds, groups)
  ],
  [
    'waves by ids eligible for read',
    'wr_viewer_groups',
    2,
    (waves) => waves.findWavesByIdsEligibleForRead(waveIds, groups)
  ],
  [
    'active TDH voting waves (count and page)',
    'tv_viewer_groups',
    2,
    (waves) =>
      waves.findActiveTdhVotingWaves(
        { eligibleGroups: groups, now: 1, limit: 10, offset: 0 },
        {}
      )
  ],
  [
    'recently dropped overview with followed subwaves',
    'ov_viewer_groups',
    3,
    (waves) =>
      waves.findRecentlyDroppedToWaves({
        authenticated_user_id: 'viewer',
        only_waves_followed_by_authenticated_user: true,
        offset: 0,
        limit: 10,
        eligibleGroups: groups,
        pinned: null
      })
  ],
  [
    'scored overview with followed subwaves',
    'ov_viewer_groups',
    3,
    (waves) =>
      waves.findScoredRecentlyDroppedToWaves({
        authenticated_user_id: 'viewer',
        only_waves_followed_by_authenticated_user: true,
        offset: 0,
        limit: 10,
        eligibleGroups: groups,
        pinned: null,
        score_sort: 'QUALITY' as never,
        exclude_followed: false
      })
  ],
  [
    'DM unread states',
    'dm_viewer_groups',
    2,
    (waves) =>
      waves.findDmUnreadConversationStates(
        { identityId: 'viewer', eligibleGroups: groups },
        {}
      )
  ],
  [
    'boosted drops',
    'bd_viewer_groups',
    2,
    (_, drops) =>
      drops.findBoostedDrops(
        {
          wave_id: null,
          eligibile_groups: groups,
          limit: 10,
          offset: 0,
          booster_id: null,
          author_id: null,
          min_boosts: null,
          order_by: 'last_boosted_at',
          count_only_boosts_after: 0,
          order: 'DESC'
        },
        {}
      )
  ],
  [
    'boosted drops count',
    'bd_viewer_groups',
    2,
    (_, drops) =>
      drops.countBoostedDrops(
        {
          wave_id: null,
          eligibile_groups: groups,
          booster_id: null,
          author_id: null,
          min_boosts: null,
          count_only_boosts_after: 0
        },
        {}
      )
  ]
];

describe('single-copy viewer groups, batch 2', () => {
  beforeEach(() => resetViewerGroupsCteSupport());

  it.each(cases)(
    '%s inlines the groups once, as one JSON parameter',
    async (_name, cte, checks, call) => {
      const { db, statements } = fakeExecutor('match');
      await call(new WavesApiDb(() => db), new DropsDb(() => db));
      expect(statements.length).toBeGreaterThan(0);
      const hinted = new RegExp(
        `select /\\*\\+ NO_MERGE\\(${cte}\\) SUBQUERY\\(MATERIALIZATION\\) \\*/ id from ${cte}`,
        'g'
      );
      for (const { sql, params } of statements) {
        expect(sql.match(new RegExp(`${cte} as \\(`, 'g'))).toHaveLength(1);
        expect(sql.match(/json_table\(/g)).toHaveLength(1);
        expect(sql.match(hinted)).toHaveLength(checks);
        expect(sql).not.toMatch(
          /in \(:(eligibleGroups|groupIdsUserIsEligibleFor|eligibile_groups)\)/
        );
        expect(JSON.parse(params[`${cte}_json`] as string)).toEqual(groups);
      }
    }
  );

  it.each(cases)(
    '%s keeps the inlined list while the collations differ',
    async (_name, cte, _checks, call) => {
      const { db, statements } = fakeExecutor('mismatch');
      await call(new WavesApiDb(() => db), new DropsDb(() => db));
      for (const { sql } of statements) {
        expect(sql).not.toContain(cte);
        expect(sql).toMatch(
          /in \(:(eligibleGroups|groupIdsUserIsEligibleFor|eligibile_groups)\)/
        );
      }
    }
  );
});
