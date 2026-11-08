import * as mysql from 'mysql';
import { PROXY_PIN_STATEMENT_BYTES } from '@/db/proxy-session-pinning';
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

const uuid = (prefix: string, i: number) =>
  `${prefix}-0000-4000-8000-${String(i).padStart(12, '0')}`;
/** Big enough that every gated statement shares (about 12 KB per copy). */
const groups = Array.from({ length: 300 }, (_, i) => uuid('10000000', i));
/** Small enough that every statement keeps the inlined list. */
const fewGroups = groups.slice(0, 20);
const waveIds = Array.from({ length: 20 }, (_, i) => uuid('20000000', i));

type Call = (
  waves: WavesApiDb,
  drops: DropsDb,
  groupIds: string[]
) => Promise<unknown>;

/**
 * Each case: the call, its shared table's name, its shared group checks per
 * statement and the checks that always keep the inlined list.
 */
const cases: [string, string, number, number, Call][] = [
  [
    'follow candidates',
    'fc_viewer_groups',
    2,
    0,
    (waves, _, groupIds) =>
      (waves as any).findFollowedCandidateWaveIds({
        authenticated_user_id: 'viewer',
        waveIds,
        eligibleGroups: groupIds
      })
  ],
  [
    'waves by ids',
    'wi_viewer_groups',
    2,
    0,
    (waves, _, groupIds) => waves.findWavesByIds(waveIds, groupIds)
  ],
  [
    'waves by ids eligible for read',
    'wr_viewer_groups',
    2,
    0,
    (waves, _, groupIds) =>
      waves.findWavesByIdsEligibleForRead(waveIds, groupIds)
  ],
  [
    'recently dropped overview with followed subwaves',
    'ov_viewer_groups',
    2,
    1,
    (waves, _, groupIds) =>
      waves.findRecentlyDroppedToWaves({
        authenticated_user_id: 'viewer',
        only_waves_followed_by_authenticated_user: true,
        offset: 0,
        limit: 10,
        eligibleGroups: groupIds,
        pinned: null
      })
  ],
  [
    'scored overview with followed subwaves',
    'ov_viewer_groups',
    2,
    1,
    (waves, _, groupIds) =>
      waves.findScoredRecentlyDroppedToWaves({
        authenticated_user_id: 'viewer',
        only_waves_followed_by_authenticated_user: true,
        offset: 0,
        limit: 10,
        eligibleGroups: groupIds,
        pinned: null,
        score_sort: 'QUALITY' as never,
        exclude_followed: false
      })
  ],
  [
    'DM unread states',
    'dm_viewer_groups',
    2,
    0,
    (waves, _, groupIds) =>
      waves.findDmUnreadConversationStates(
        { identityId: 'viewer', eligibleGroups: groupIds },
        {}
      )
  ],
  [
    'boosted drops',
    'bd_viewer_groups',
    2,
    0,
    (_, drops, groupIds) =>
      drops.findBoostedDrops(
        {
          wave_id: null,
          eligibile_groups: groupIds,
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
    0,
    (_, drops, groupIds) =>
      drops.countBoostedDrops(
        {
          wave_id: null,
          eligibile_groups: groupIds,
          booster_id: null,
          author_id: null,
          min_boosts: null,
          count_only_boosts_after: 0
        },
        {}
      )
  ]
];

/** The API driver's named-parameter formatting (my-sql.helpers). */
function format(sql: string, params: Record<string, unknown>): string {
  return sql.replace(/:(\w+)/g, (text, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return text;
    const value = params[key];
    return Array.isArray(value)
      ? value.map((item) => mysql.escape(item)).join(', ')
      : mysql.escape(value);
  });
}

const INLINE_GROUPS =
  /in \(:(eligibleGroups|groupIdsUserIsEligibleFor|eligibile_groups)\)/g;

describe('single-copy viewer groups, batch 2', () => {
  beforeEach(() => resetViewerGroupsCteSupport());

  it.each(cases)(
    '%s inlines large group lists once, as one JSON parameter',
    async (_name, cte, checks, inlineChecks, call) => {
      const { db, statements } = fakeExecutor('match');
      await call(new WavesApiDb(() => db), new DropsDb(() => db), groups);
      expect(statements.length).toBeGreaterThan(0);
      const hinted = new RegExp(
        `select /\\*\\+ NO_MERGE\\(${cte}\\) SUBQUERY\\(MATERIALIZATION\\) \\*/ id from ${cte}`,
        'g'
      );
      for (const { sql, params } of statements) {
        expect(sql.match(new RegExp(`${cte} as \\(`, 'g'))).toHaveLength(1);
        expect(sql.match(/json_table\(/g)).toHaveLength(1);
        expect(sql.match(hinted)).toHaveLength(checks);
        expect(sql.match(INLINE_GROUPS) ?? []).toHaveLength(inlineChecks);
        expect(JSON.parse(params[`${cte}_json`] as string)).toEqual(groups);
      }
    }
  );

  it.each(cases)(
    '%s keeps the inlined list for small group lists, without a collation check',
    async (_name, cte, _checks, _inlineChecks, call) => {
      const { db, statements } = fakeExecutor('match');
      await call(new WavesApiDb(() => db), new DropsDb(() => db), fewGroups);
      expect(statements.length).toBeGreaterThan(0);
      expect(db.execute).not.toHaveBeenCalledWith(
        expect.stringContaining('information_schema.columns'),
        expect.anything()
      );
      for (const { sql } of statements) {
        expect(sql).not.toContain(cte);
        expect(sql).toMatch(INLINE_GROUPS);
      }
    }
  );

  it.each(cases)(
    '%s keeps the inlined list while the collations differ',
    async (_name, cte, _checks, _inlineChecks, call) => {
      const { db, statements } = fakeExecutor('mismatch');
      await call(new WavesApiDb(() => db), new DropsDb(() => db), groups);
      for (const { sql } of statements) {
        expect(sql).not.toContain(cte);
        expect(sql).toMatch(INLINE_GROUPS);
      }
    }
  );

  it.each(cases)(
    '%s stays below the pinning size with the largest list it still inlines',
    async (_name, cte, _checks, _inlineChecks, call) => {
      const run = async (count: number) => {
        const { db, statements } = fakeExecutor('match');
        await call(
          new WavesApiDb(() => db),
          new DropsDb(() => db),
          Array.from({ length: count }, (_, i) => uuid('30000000', i))
        );
        return statements;
      };
      let inlined = 1;
      while (
        !(await run(inlined + 1)).some(({ sql }) => sql.includes(`${cte} as (`))
      )
        inlined++;
      for (const { sql, params } of await run(inlined)) {
        expect(sql).not.toContain(cte);
        expect(Buffer.byteLength(format(sql, params))).toBeLessThanOrEqual(
          PROXY_PIN_STATEMENT_BYTES
        );
      }
    }
  );

  it('always inlines the groups for active TDH voting waves (count and page)', async () => {
    const { db, statements } = fakeExecutor('match');
    await new WavesApiDb(() => db).findActiveTdhVotingWaves(
      { eligibleGroups: groups, now: 1, limit: 10, offset: 0 },
      {}
    );
    expect(statements).toHaveLength(2);
    for (const { sql } of statements) {
      expect(sql).not.toContain('json_table');
      expect(sql.match(INLINE_GROUPS)).toHaveLength(2);
    }
  });
});
