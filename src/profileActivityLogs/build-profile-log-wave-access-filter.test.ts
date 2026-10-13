import fc from 'fast-check';
import { ProfileActivityLogType } from '@/entities/IProfileActivityLog';
import { RateMatter } from '@/entities/IRating';
import { SqlExecutor } from '@/sql-executor';
import {
  buildProfileLogWaveAccessFilter,
  ProfileActivityLogsDb,
  ProfileLogSearchParams
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

describe('ProfileActivityLogsDb.searchLogs wave access', () => {
  function search(params: Partial<ProfileLogSearchParams>) {
    const executor = {
      execute: jest.fn().mockResolvedValue([])
    } as unknown as jest.Mocked<SqlExecutor>;
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
      .then(() => ({
        sql: executor.execute.mock.calls[0][0],
        params: executor.execute.mock.calls[0][1] as Record<string, unknown>
      }));
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
