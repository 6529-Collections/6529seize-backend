import { userGroupsService } from '@/api/community-members/user-groups.service';
import {
  isLegacyCompetitionGetFacadeScope,
  legacyCompetitionGetSql,
  withLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import { DROP_MEDIA_TABLE } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { DropsDb } from './drops.db';

type Statement = {
  sql: string;
  params: Record<string, any>;
  options: unknown;
  facade: boolean;
};

/**
 * Records each statement as the API executor would run it (the facade
 * rewrite applied in the scope active at execution time). Statements that
 * select serial numbers answer with `serialNos`; others with `rows`.
 */
function repoRecording(serialNos: number[], rows: unknown[] = []) {
  const statements: Statement[] = [];
  const execute = jest.fn(
    async (sql: string, params: Record<string, any>, options?: unknown) => {
      statements.push({
        sql: legacyCompetitionGetSql(sql),
        params,
        options,
        facade: isLegacyCompetitionGetFacadeScope()
      });
      return /select d\.serial_no\s/.test(sql)
        ? serialNos.map((serial_no) => ({ serial_no }))
        : rows;
    }
  );
  const repo = new DropsDb(() => ({ execute }) as any);
  return { repo, statements };
}

const unfiltered = {
  amount: 20,
  serial_no_less_than: null,
  group_ids_user_is_eligible_for: [] as string[],
  group_id: null,
  wave_id: null,
  curation_id: null,
  curation_name: null,
  author_id: null,
  include_replies: false,
  drop_type: null,
  ids: null,
  serial_nos: null,
  contains_media: false
};

describe('DropsDb.findLatestDrops', () => {
  let groupSql: jest.SpyInstance;

  beforeEach(() => {
    groupSql = jest
      .spyOn(userGroupsService, 'getSqlAndParamsByGroupId')
      .mockResolvedValue({
        sql: 'with user_groups_view as (select * from identities)',
        params: {}
      });
  });

  afterEach(() => {
    groupSql.mockRestore();
  });

  it('reads serial numbers from the base tables, then the rows in the GET scope', async () => {
    const rows = [{ serial_no: 9 }, { serial_no: 7 }];
    const { repo, statements } = repoRecording([9, 7], rows);

    const result = await withLegacyCompetitionGetFacade(() =>
      repo.findLatestDrops(
        {
          ...unfiltered,
          serial_no_less_than: 10,
          group_ids_user_is_eligible_for: ['g1', 'g2']
        },
        {}
      )
    );

    expect(result).toBe(rows);
    expect(groupSql).not.toHaveBeenCalled();
    expect(statements).toHaveLength(2);
    const [ids, full] = statements;

    expect(ids.facade).toBe(false);
    expect(ids.sql).not.toContain('legacy_get_');
    expect(ids.sql).toMatch(/from drops d force index \(PRIMARY\)/);
    expect(ids.sql).toContain('d.serial_no < :serialNoLessThan');
    expect(ids.sql).toContain('and d.reply_to_drop_id is null');
    expect(ids.sql).toContain(
      'exists (\n             select 1 from identities i where i.profile_id = d.author_id'
    );
    expect(ids.sql).toContain('from waves w');
    expect(ids.sql).toContain('w.id = d.wave_id');
    expect(ids.sql).toContain(
      'w.visibility_group_id in (:groupsUserIsEligibleFor)'
    );
    expect(ids.sql).toContain(
      'access_parent.visibility_group_id in (:groupsUserIsEligibleFor)'
    );
    expect(ids.sql).not.toContain('is_direct_message');
    expect(ids.sql).not.toContain(DROP_MEDIA_TABLE);
    expect(ids.sql).toMatch(/order by d\.serial_no desc\s+limit :amount$/);
    expect(ids.params).toEqual({
      serialNoLessThan: 10,
      amount: 20,
      groupsUserIsEligibleFor: ['g1', 'g2']
    });

    expect(full.facade).toBe(true);
    expect(full.sql).toMatch(/from `legacy_get_drops` d/);
    expect(full.sql).toContain('where d.serial_no in (:serialNos)');
    expect(full.sql).toMatch(/order by d\.serial_no desc$/);
    expect(full.params).toEqual({ serialNos: [9, 7] });
  });

  it('keeps replies, media and the public-only scope as the single query does', async () => {
    const { repo, statements } = repoRecording([3]);

    await repo.findLatestDrops(
      {
        ...unfiltered,
        group_ids_user_is_eligible_for: ['g1'],
        include_replies: true,
        contains_media: true,
        public_only: true
      },
      {}
    );

    const [ids] = statements;
    expect(ids.sql).not.toContain('reply_to_drop_id');
    expect(ids.sql).toContain(
      `exists (select 1 from ${DROP_MEDIA_TABLE} dm where dm.drop_id = d.id)`
    );
    expect(ids.sql).toContain(
      'and coalesce(w.is_direct_message, false) = false'
    );
    // Public-only ignores the viewer's groups.
    expect(ids.sql).toContain('w.visibility_group_id is null');
    expect(ids.sql).not.toContain('in (:groupsUserIsEligibleFor)');
    expect(ids.params.serialNoLessThan).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('limits a viewer without groups to public waves', async () => {
    const { repo, statements } = repoRecording([3]);

    await repo.findLatestDrops(unfiltered, {});

    expect(statements[0].sql).toContain('w.visibility_group_id is null');
    expect(statements[0].sql).not.toContain('in (:groupsUserIsEligibleFor)');
  });

  it('treats empty id and serial lists as no filter', async () => {
    const { repo, statements } = repoRecording([3]);

    await repo.findLatestDrops({ ...unfiltered, ids: [], serial_nos: [] }, {});

    expect(groupSql).not.toHaveBeenCalled();
    expect(statements[0].sql).toContain('force index (PRIMARY)');
  });

  it('reads no rows when no serial number matches', async () => {
    const { repo, statements } = repoRecording([]);

    await expect(repo.findLatestDrops(unfiltered, {})).resolves.toEqual([]);
    expect(statements).toHaveLength(1);
  });

  it.each([
    ['wave_id', { wave_id: 'wave-1' }],
    ['group_id', { group_id: 'group-1' }],
    ['curation_id', { curation_id: 'curation-1' }],
    ['curation_name', { curation_name: 'Art' }],
    ['author_id', { author_id: 'author-1' }],
    ['drop_type', { drop_type: DropType.PARTICIPATORY }],
    ['ids', { ids: ['drop-1'] }],
    ['serial_nos', { serial_nos: [5] }]
  ])('keeps the single query when filtered by %s', async (_name, filter) => {
    const { repo, statements } = repoRecording([3]);

    await repo.findLatestDrops({ ...unfiltered, ...filter }, {});

    expect(groupSql).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('select d.* from drops d');
    expect(statements[0].sql).toContain(
      'join user_groups_view cm on cm.profile_id = d.author_id'
    );
    expect(statements[0].sql).not.toContain('force index');
  });
});

describe('DropsDb.findVisibleLightDropIds', () => {
  it('keeps its primary key hint inside the GET scope by reading base tables', async () => {
    const { repo, statements } = repoRecording([]);
    const connection = { connection: {} } as any;

    await withLegacyCompetitionGetFacade(() =>
      repo.findVisibleLightDropIds(
        {
          limit: 10,
          older_first: false,
          min_serial_no: null,
          max_serial_no: null,
          group_ids_user_is_eligible_for: ['g1']
        },
        { connection }
      )
    );

    expect(statements).toHaveLength(1);
    const [ids] = statements;
    expect(ids.facade).toBe(false);
    expect(ids.sql).toContain('from drops d FORCE INDEX (PRIMARY)');
    expect(ids.sql).toContain('from waves w');
    expect(ids.sql).not.toContain('legacy_get_');
    expect(ids.sql).toContain(
      'w.visibility_group_id in (:groupsUserIsEligibleFor)'
    );
    expect(ids.options).toEqual({ wrappedConnection: connection });
  });
});

describe('DropsDb.findVisibleDrops', () => {
  const latest = {
    limit: 21,
    offset: 40,
    parent_drop_id: null,
    serial_nos: null,
    ids: null,
    group_ids_user_is_eligible_for: ['g1']
  };

  it('reads the latest root serial numbers from the base tables, then the rows in the GET scope', async () => {
    const rows = [{ serial_no: 9 }];
    const { repo, statements } = repoRecording([9], rows);
    const connection = { connection: {} } as any;

    const result = await withLegacyCompetitionGetFacade(() =>
      repo.findVisibleDrops(latest, { connection })
    );

    expect(result).toBe(rows);
    expect(statements).toHaveLength(2);
    const [ids, full] = statements;
    expect(ids.facade).toBe(false);
    expect(ids.sql).not.toContain('legacy_get_');
    expect(ids.sql).toContain('from drops d force index (PRIMARY)');
    expect(ids.sql).toContain('where d.reply_to_drop_id is null');
    expect(ids.sql).toContain('from waves w');
    expect(ids.sql).toContain(
      'w.visibility_group_id in (:groupsUserIsEligibleFor)'
    );
    expect(ids.sql).toContain('limit :limit offset :offset');
    expect(ids.params).toEqual({
      limit: 21,
      offset: 40,
      groupsUserIsEligibleFor: ['g1']
    });
    expect(ids.options).toEqual({ wrappedConnection: connection });

    expect(full.facade).toBe(true);
    expect(full.sql).toMatch(/from `legacy_get_drops` d/);
    expect(full.params).toEqual({ serialNos: [9] });
    expect(full.options).toEqual({ wrappedConnection: connection });
  });

  it.each([
    ['parent_drop_id', { parent_drop_id: 'parent-1' }],
    ['serial_nos', { serial_nos: [1] }],
    ['ids', { ids: ['drop-1'] }]
  ])('keeps the single query when filtered by %s', async (_name, filter) => {
    const { repo, statements } = repoRecording([9]);

    await repo.findVisibleDrops({ ...latest, ...filter }, {});

    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain('select d.*');
    expect(statements[0].sql).not.toContain('force index');
    expect(statements[0].sql).not.toContain('reply_to_drop_id');
  });
});
