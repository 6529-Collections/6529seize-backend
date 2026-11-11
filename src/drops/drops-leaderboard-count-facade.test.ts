import {
  isLegacyCompetitionGetFacadeScope,
  legacyCompetitionGetSql,
  withLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import { PageSortDirection } from '@/api/page-request';
import { SqlExecutor } from '@/sql-executor';
import { DropsDb, LeaderboardParams, LeaderboardSort } from './drops.db';

/** Records what the API executor would send (db-api applies the rewriter). */
function apiLikeExecutor() {
  const sent: { raw: string; effective: string; inFacade: boolean }[] = [];
  const db = {
    oneOrNull: async (sql: string) => {
      sent.push({
        raw: sql,
        effective: legacyCompetitionGetSql(sql),
        inFacade: isLegacyCompetitionGetFacadeScope()
      });
      return { cnt: 0 };
    }
  } as unknown as SqlExecutor;
  return { db, sent };
}

const params: LeaderboardParams = {
  wave_id: 'wave-1',
  page_size: 20,
  page: 1,
  sort_direction: PageSortDirection.DESC,
  sort: LeaderboardSort.RANK,
  curation_id: null,
  unvoted_by_me: false,
  is_additional_action_promised: null,
  price_currency: null,
  min_price: null,
  max_price: null
};

describe('leaderboard drop count under the API legacy facade', () => {
  it.each([
    ['no filters', {}],
    ['additional action promised', { is_additional_action_promised: true }],
    ['unvoted by me', { unvoted_by_me: true }],
    ['curation', { curation_id: 'curation-1' }],
    ['price bounds', { min_price: 1, max_price: 5, price_currency: 'ETH' }]
  ] as const)(
    '%s: reaches MySQL unrewritten, reading the base drops table for candidates',
    async (_name, filters) => {
      const { db, sent } = apiLikeExecutor();
      await withLegacyCompetitionGetFacade(() =>
        new DropsDb(() => db).countParticipatoryDrops(
          { ...params, ...filters },
          {},
          'voter-1'
        )
      );
      expect(sent).toHaveLength(1);
      const [{ raw, effective, inFacade }] = sent;
      expect(inFacade).toBe(false);
      expect(effective).toBe(raw);
      expect(raw).toMatch(/from\s+drops\s+pd/i);
      // The guard matters: inside the facade, that read becomes the view.
      const rewritten = withLegacyCompetitionGetFacade(() =>
        legacyCompetitionGetSql(raw)
      );
      expect(rewritten).toMatch(/from\s+`legacy_get_drops`\s+pd/i);
      // And it is the only read the guard keeps from the rewrite: every
      // other legacy table is already named as its view.
      expect(rewritten.split('`legacy_get_drops` pd').join('drops pd')).toBe(
        raw
      );
    }
  );
});
