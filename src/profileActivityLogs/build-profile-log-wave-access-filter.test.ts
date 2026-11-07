import fc from 'fast-check';
import * as mysql from 'mysql';
import { DB_TEXT_COLLATION } from '@/db/db-collation';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { RateMatter } from '@/entities/IRating';
import { SqlExecutor } from '@/sql-executor';
import {
  buildProfileLogWaveAccessFilter,
  ProfileActivityLogsDb,
  ProfileLogSearchParams,
  resetViewerGroupsCteSupport
} from './profile-activity-logs.db';

const WAVE_SCOPED_TYPES = [
  ProfileActivityLogType.DROP_CREATED,
  ProfileActivityLogType.DROP_VOTE_EDIT,
  ProfileActivityLogType.DROP_CLAPPED,
  ProfileActivityLogType.DROP_COMMENT,
  ProfileActivityLogType.DROP_REACTED,
  ProfileActivityLogType.RATING_EDIT
];

describe('buildProfileLogWaveAccessFilter', () => {
  it('adds no condition when the requested types cannot reference a wave', () => {
    const otherTypes = Object.values(ProfileActivityLogType).filter(
      (type) => !WAVE_SCOPED_TYPES.includes(type)
    );
    fc.assert(
      fc.property(fc.subarray(otherTypes, { minLength: 1 }), (types) => {
        expect(
          buildProfileLogWaveAccessFilter({
            types,
            eligibleGroupIds: ['group-1']
          })
        ).toEqual({ conditions: [], params: {} });
      })
    );
  });

  it('filters wave-scoped rows whenever the requested types may include them', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...WAVE_SCOPED_TYPES),
        fc.subarray(Object.values(ProfileActivityLogType)),
        (waveScopedType, otherTypes) => {
          const filter = buildProfileLogWaveAccessFilter({
            types: [waveScopedType, ...otherTypes],
            eligibleGroupIds: []
          });
          expect(filter.conditions).toHaveLength(1);
        }
      )
    );
    expect(
      buildProfileLogWaveAccessFilter({ eligibleGroupIds: [] }).conditions
    ).toHaveLength(1);
  });

  it('checks the drop wave and the wave rep target against the viewer groups', () => {
    const filter = buildProfileLogWaveAccessFilter({
      eligibleGroupIds: ['group-1']
    });

    expect(filter.conditions[0]).toContain(
      'pa_log_wave.id = pa_logs.additional_data_2'
    );
    expect(filter.conditions[0]).toContain(
      'pa_log_wave.id = pa_logs.target_id'
    );
    expect(filter.conditions[0]).toContain(':wave_access_group_ids');
    expect(filter.conditions[0]).toContain('access_parent');
    expect(filter.params).toEqual({
      wave_access_drop_log_types: [
        ProfileActivityLogType.DROP_CREATED,
        ProfileActivityLogType.DROP_VOTE_EDIT,
        ProfileActivityLogType.DROP_CLAPPED,
        ProfileActivityLogType.DROP_COMMENT,
        ProfileActivityLogType.DROP_REACTED
      ],
      wave_access_rating_edit_type: ProfileActivityLogType.RATING_EDIT,
      wave_access_wave_rep_matter: RateMatter.WAVE_REP,
      wave_access_group_ids: ['group-1']
    });
  });

  it('limits anonymous viewers to public waves', () => {
    const filter = buildProfileLogWaveAccessFilter({ eligibleGroupIds: [] });

    expect(filter.conditions[0]).not.toContain(':wave_access_group_ids');
    expect(filter.params).not.toHaveProperty('wave_access_group_ids');
  });
});

type CollationCheck = 'match' | 'mismatch' | 'error';

/** Answers the per-container collation check, then the search itself. */
function executorFor(check: CollationCheck) {
  return {
    execute: jest.fn(async (sql: string) => {
      if (!sql.includes('information_schema.columns')) return [];
      if (check === 'error') throw new Error('no metadata access');
      const collation =
        check === 'match' ? DB_TEXT_COLLATION : 'utf8mb4_unicode_ci';
      return [{ collation_name: collation }, { collation_name: collation }];
    })
  } as unknown as jest.Mocked<SqlExecutor>;
}

function searchWith(
  executor: jest.Mocked<SqlExecutor>,
  params: Partial<ProfileLogSearchParams>
) {
  const db = new ProfileActivityLogsDb(() => executor, {} as any);
  return db
    .searchLogs(
      {
        group_id: null,
        viewer_eligible_group_ids: ['group-1'],
        pageRequest: { page: 1, page_size: 10 },
        includeProfileIdToIncoming: true,
        order: 'desc',
        ...params
      },
      {}
    )
    .then(() => {
      const call = executor.execute.mock.calls.find(
        ([sql]) => !sql.includes('information_schema.columns')
      )!;
      return {
        sql: call[0],
        params: call[1] as Record<string, unknown>
      };
    });
}

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

describe('ProfileActivityLogsDb.searchLogs wave access', () => {
  beforeEach(() => resetViewerGroupsCteSupport());

  function search(params: Partial<ProfileLogSearchParams>) {
    return searchWith(executorFor('mismatch'), params);
  }

  it('applies the filter inside every limited branch before pagination', async () => {
    const { sql, params } = await search({
      profile_id: 'profile-1',
      type: [
        ProfileActivityLogType.DROP_CREATED,
        ProfileActivityLogType.HANDLE_EDIT
      ]
    });

    // 3 match columns x 2 type branches, each with one CASE condition.
    expect(sql.match(/\(case/g)).toHaveLength(6);
    expect(params.wave_access_group_ids).toEqual(['group-1']);
  });

  it('applies the filter to the scan without a profile', async () => {
    const { sql, params } = await search({});

    expect(sql.match(/\(case/g)).toHaveLength(1);
    expect(sql.indexOf('(case')).toBeLessThan(sql.indexOf('LIMIT'));
    expect(params.wave_access_rating_edit_type).toBe(
      ProfileActivityLogType.RATING_EDIT
    );
  });

  it('leaves queries for other log types unchanged', async () => {
    const { sql, params } = await search({
      profile_id: 'profile-1',
      type: [ProfileActivityLogType.PROFILE_CREATED]
    });

    expect(sql).not.toContain('(case');
    expect(params).not.toHaveProperty('wave_access_drop_log_types');
  });
});

describe('ProfileActivityLogsDb.searchLogs shared viewer groups', () => {
  beforeEach(() => resetViewerGroupsCteSupport());

  const allTypes = Object.values(ProfileActivityLogType);
  const manyGroups = Array.from(
    { length: 400 },
    (_, i) => `group-name-for-a-wave-${i}-AbCdEfGhJkLmNoPqRsTu`
  );

  it('inlines the viewer groups once, in a shared table, when collations match', async () => {
    const { sql, params } = await searchWith(executorFor('match'), {
      profile_id: 'profile-1',
      viewer_eligible_group_ids: manyGroups,
      type: allTypes
    });

    expect(sql.match(/pa_viewer_groups as \(/g)).toHaveLength(1);
    expect(sql.match(/json_table\(/g)).toHaveLength(1);
    expect(sql).toContain(`collate ${DB_TEXT_COLLATION}`);
    expect(sql).not.toContain(':wave_access_group_ids');
    expect(params).not.toHaveProperty('wave_access_group_ids');
    expect(JSON.parse(params.pa_viewer_groups_json as string)).toEqual(
      manyGroups
    );
    // Every branch still checks access, now against the shared table.
    expect(sql.match(/\(case/g)!.length).toBeGreaterThan(3);
    const references = sql.match(/ id from pa_viewer_groups\)/g)!.length;
    expect(references).toBe(sql.match(/\(case/g)!.length * 4);
    // Every reference reads one shared materialization, never a per-row EXISTS.
    expect(
      sql.match(
        /select \/\*\+ NO_MERGE\(pa_viewer_groups\) SUBQUERY\(MATERIALIZATION\) \*\/ id from pa_viewer_groups\)/g
      )
    ).toHaveLength(references);
  });

  it('shrinks the statement from megabytes to about one list', async () => {
    const request = {
      profile_id: 'profile-1',
      viewer_eligible_group_ids: manyGroups,
      type: allTypes
    };
    const inline = await searchWith(executorFor('mismatch'), request);
    resetViewerGroupsCteSupport();
    const shared = await searchWith(executorFor('match'), request);

    const inlineBytes = Buffer.byteLength(format(inline.sql, inline.params));
    const sharedBytes = Buffer.byteLength(format(shared.sql, shared.params));
    const listBytes = Buffer.byteLength(
      mysql.escape(JSON.stringify(manyGroups))
    );
    expect(inlineBytes).toBeGreaterThan(1_000_000);
    expect(sharedBytes - listBytes).toBeLessThan(inlineBytes / 20);
  });

  it('keeps the inlined list when the compared columns use another collation', async () => {
    const { sql, params } = await searchWith(executorFor('mismatch'), {
      profile_id: 'profile-1'
    });
    expect(sql).not.toContain('pa_viewer_groups');
    expect(params.wave_access_group_ids).toEqual(['group-1']);
  });

  it('keeps the inlined list and retries the check later if metadata is unreadable', async () => {
    const failing = executorFor('error');
    const first = await searchWith(failing, { profile_id: 'profile-1' });
    expect(first.sql).not.toContain('pa_viewer_groups');

    const recovered = executorFor('match');
    const second = await searchWith(recovered, { profile_id: 'profile-1' });
    expect(second.sql).toContain('pa_viewer_groups as (');
  });

  it('checks the collation once per container', async () => {
    const executor = executorFor('match');
    await searchWith(executor, { profile_id: 'profile-1' });
    await searchWith(executor, { profile_id: 'profile-1' });
    const checks = executor.execute.mock.calls.filter(([sql]) =>
      sql.includes('information_schema.columns')
    );
    expect(checks).toHaveLength(1);
  });

  it('does not touch the query for anonymous viewers', async () => {
    const executor = executorFor('match');
    const { sql } = await searchWith(executor, {
      profile_id: 'profile-1',
      viewer_eligible_group_ids: []
    });
    expect(sql).not.toContain('pa_viewer_groups');
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
});
