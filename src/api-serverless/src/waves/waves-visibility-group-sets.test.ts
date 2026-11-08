import * as mysql from 'mysql';
import {
  isLegacyCompetitionGetFacadeScope,
  legacyCompetitionGetSql,
  withLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import { SqlExecutor } from '@/sql-executor';
import { resetViewerGroupsCteSupport } from '@/waves/viewer-groups-cte';
import { viewerGroupSets } from '@/waves/viewer-group-sets';
import { WavesApiDb } from './waves.api.db';

const groups = Array.from(
  { length: 400 },
  (_, i) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`
);
const waveIds = Array.from(
  { length: 20 },
  (_, i) => `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`
);
const PIN_BYTES = 16_384;
const FLAG = 'FEATURE_VIEWER_GROUP_SET_TABLE';

/** The statement as the driver sends it: named parameters inlined. */
function sent(sql: string, params: Record<string, unknown>): string {
  return sql.replace(/:(\w+)/g, (text, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return text;
    const value = params[key];
    return Array.isArray(value)
      ? value.map((it) => mysql.escape(it)).join(', ')
      : mysql.escape(value);
  });
}

/**
 * Records what the API executor would send (db-api applies the rewriter),
 * answering the set store's own reads: the members column's collation and
 * a stored, recently used set.
 */
function apiLikeExecutor() {
  const visibility: {
    raw: string;
    effective: string;
    inFacade: boolean;
    bytes: number;
  }[] = [];
  const db = {
    execute: async (sql: string, params: Record<string, unknown> = {}) => {
      if (sql.includes('information_schema.columns'))
        return [{ collation_name: 'utf8mb4_0900_ai_ci' }];
      if (sql.includes('from viewer_group_sets where set_hash'))
        return [{ last_used_at: Date.now(), created_at: 0 }];
      if (/child_wave_id|parent_wave_id as wave_id/.test(sql))
        visibility.push({
          raw: sql,
          effective: legacyCompetitionGetSql(sql),
          inFacade: isLegacyCompetitionGetFacadeScope(),
          bytes: Buffer.byteLength(sent(sql, params))
        });
      return [];
    },
    executeNativeQueriesInTransaction: async (
      work: (connection: unknown) => Promise<unknown>
    ) => work({}),
    getAffectedRows: () => 1
  } as unknown as SqlExecutor;
  return { db, visibility };
}

const reads: [string, string, (waves: WavesApiDb) => Promise<unknown>][] = [
  [
    'visible parents by child wave ids',
    'vp_viewer_groups',
    (waves) => waves.findVisibleParentWavesByChildWaveIds(waveIds, groups, {})
  ],
  [
    'wave ids with visible subwaves',
    'vs_viewer_groups',
    (waves) => waves.findWaveIdsWithVisibleSubwaves(waveIds, groups, {})
  ]
];

describe('visible parents and subwaves with stored viewer group sets', () => {
  beforeEach(() => {
    viewerGroupSets.reset();
    resetViewerGroupsCteSupport(true);
  });
  afterEach(() => {
    delete process.env[FLAG];
    viewerGroupSets.reset();
    resetViewerGroupsCteSupport();
  });

  it.each(reads)(
    '%s: flag off inlines the groups and pins; a stored set fits under the pinning size',
    async (_name, cte, read) => {
      const { db, visibility } = apiLikeExecutor();
      await withLegacyCompetitionGetFacade(() =>
        read(new WavesApiDb(() => db))
      );
      process.env[FLAG] = 'true';
      await withLegacyCompetitionGetFacade(() =>
        read(new WavesApiDb(() => db))
      );
      expect(visibility).toHaveLength(2);
      const [off, stored] = visibility;
      expect(off.raw).toContain(':groupIdsUserIsEligibleFor');
      expect(off.raw).not.toContain(cte);
      expect(off.bytes).toBeGreaterThan(PIN_BYTES);
      expect(stored.raw).toContain(`${cte} as (`);
      expect(stored.raw).toContain('viewer_group_set_members');
      expect(stored.raw).not.toContain(':groupIdsUserIsEligibleFor');
      expect(stored.bytes).toBeLessThan(4_096);
      // Both reach MySQL as written: every legacy table is named as its
      // view, so the API facade's rewrite changes nothing.
      for (const it of visibility) {
        expect(it.inFacade).toBe(true);
        expect(it.effective).toBe(it.raw);
      }
    }
  );
});
