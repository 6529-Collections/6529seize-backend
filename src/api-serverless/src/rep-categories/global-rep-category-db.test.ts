import { PageSortDirection } from '@/api/page-request';
import { GlobalRepCategoryDb } from '@/api/rep-categories/global-rep-category.db';
import { IDENTITIES_TABLE, RATINGS_TABLE, WAVES_TABLE } from '@/constants';
import { RateMatter } from '@/entities/IRating';
import { RequestContext } from '@/request.context';
import { SqlExecutor } from '@/sql-executor';

type SqlExecutorMock = Pick<SqlExecutor, 'execute' | 'oneOrNull'>;

function createDb() {
  const execute = jest.fn().mockResolvedValue([]);
  const oneOrNull = jest.fn().mockResolvedValue(null);
  const service = new GlobalRepCategoryDb(() =>
    createSqlExecutorMock({ execute, oneOrNull })
  );

  return { service, execute, oneOrNull };
}

function createSqlExecutorMock(executor: SqlExecutorMock): SqlExecutor {
  return executor as unknown as SqlExecutor;
}

describe('GlobalRepCategoryDb', () => {
  it('aggregates signed current REP stats for one category', async () => {
    const { service, oneOrNull } = createDb();
    oneOrNull.mockResolvedValueOnce({
      total_rep: '-7',
      pair_count: '3',
      giver_count: '2',
      recipient_count: '2'
    });

    await expect(
      service.getOverviewStats(
        { category: "Dev extraordinaire (A), can't miss" },
        {}
      )
    ).resolves.toEqual({
      total_rep: '-7',
      pair_count: '3',
      giver_count: '2',
      recipient_count: '2'
    });

    expect(oneOrNull).toHaveBeenCalledWith(
      expect.stringContaining(`from ${RATINGS_TABLE} r`),
      {
        category: "Dev extraordinaire (A), can't miss",
        matter: RateMatter.REP
      },
      { wrappedConnection: undefined }
    );
    const [sql] = oneOrNull.mock.calls[0];
    expect(sql).toContain('coalesce(sum(r.rating), 0) as total_rep');
    expect(sql).toContain('count(*) as pair_count');
    expect(sql).toContain('and r.rating <> 0');
  });

  it('returns a stable ratings page ordered by absolute rep impact', async () => {
    const { service, execute } = createDb();
    execute.mockResolvedValueOnce([
      {
        giver_profile_id: 'giver-1',
        recipient_profile_id: 'recipient-1',
        rep: 10,
        last_modified: '2026-06-01T00:00:00.000Z',
        category: 'Dev extraordinaire'
      },
      {
        giver_profile_id: 'giver-2',
        recipient_profile_id: 'recipient-2',
        rep: -5,
        last_modified: '2026-06-02T00:00:00.000Z',
        category: 'Dev extraordinaire'
      },
      {
        giver_profile_id: 'giver-3',
        recipient_profile_id: 'recipient-3',
        rep: 1,
        last_modified: '2026-06-03T00:00:00.000Z',
        category: 'Dev extraordinaire'
      }
    ]);

    const result = await service.getRatingsPage(
      {
        category: 'Dev extraordinaire',
        page: 2,
        page_size: 2,
        order: PageSortDirection.DESC,
        order_by: 'rep',
        search: null
      },
      {}
    );

    expect(result).toEqual({
      page: 2,
      next: true,
      data: [
        {
          giver_profile_id: 'giver-1',
          recipient_profile_id: 'recipient-1',
          rep: 10,
          last_modified: '2026-06-01T00:00:00.000Z',
          category: 'Dev extraordinaire'
        },
        {
          giver_profile_id: 'giver-2',
          recipient_profile_id: 'recipient-2',
          rep: -5,
          last_modified: '2026-06-02T00:00:00.000Z',
          category: 'Dev extraordinaire'
        }
      ]
    });
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain('order by abs(r.rating) desc');
    expect(sql).toContain('r.rating desc');
    expect(sql).toContain(
      'r.last_modified desc, r.rater_profile_id asc, r.matter_target_id asc'
    );
    expect(params).toMatchObject({
      category: 'Dev extraordinaire',
      matter: RateMatter.REP,
      offset: 2,
      limitPlusOne: 3
    });
  });

  it('searches and sorts recipient rankings with deterministic pagination', async () => {
    const { service, execute } = createDb();
    execute.mockResolvedValueOnce([
      {
        profile_id: 'recipient-1',
        total_rep: '25',
        rater_count: '2',
        last_modified: '2026-06-03T00:00:00.000Z'
      }
    ]);

    await service.getRecipientsPage(
      {
        category: 'Dev extraordinaire',
        page: 1,
        page_size: 50,
        order: PageSortDirection.ASC,
        order_by: 'profile',
        search: 'alice'
      },
      {}
    );

    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain('r.matter_target_id as profile_id');
    expect(sql).toContain('count(distinct r.rater_profile_id) as rater_count');
    expect(sql).toContain(`from ${IDENTITIES_TABLE} searched_identity`);
    expect(sql).toContain("like :searchLike escape '\\\\'");
    expect(sql).toContain('order by coalesce(');
    expect(sql).toContain('asc, gp.profile_id asc');
    expect(params).toMatchObject({
      category: 'Dev extraordinaire',
      searchLike: '%alice%',
      offset: 0,
      limitPlusOne: 51
    });
  });

  it('escapes LIKE wildcards in search terms', async () => {
    const { service, execute } = createDb();

    await service.getRatingsPage(
      {
        category: 'Dev extraordinaire',
        page: 1,
        page_size: 50,
        order: PageSortDirection.DESC,
        order_by: 'last_modified',
        search: '50%_alice\\'
      },
      {}
    );

    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain("like :searchLike escape '\\\\'");
    expect(params).toMatchObject({
      searchLike: '%50\\%\\_alice\\\\%'
    });
  });

  it('builds suggested categories from profile and wave REP totals with request context', async () => {
    const { service, execute } = createDb();
    const timer = {
      start: jest.fn(),
      stop: jest.fn()
    };
    const connection = {};
    const ctx = { timer, connection } as unknown as RequestContext;

    await service.getSuggestedCategories(
      { limit: 12, groupIdsUserIsEligibleFor: ['group-1'] },
      ctx
    );

    const [sql, params, options] = execute.mock.calls[0];
    expect(sql).toContain(`left join ${WAVES_TABLE} w`);
    expect(sql).toContain(`left join ${WAVES_TABLE} pw`);
    expect(sql).toContain(
      'sum(case when r.matter = :profileMatter then r.rating else 0 end) as profile_rep'
    );
    expect(sql).toContain(
      'sum(case when r.matter = :waveMatter then r.rating else 0 end) as wave_rep'
    );
    expect(sql).toContain('where r.matter in (:profileMatter, :waveMatter)');
    expect(sql).toContain('r.matter = :profileMatter');
    expect(sql).toContain('r.matter = :waveMatter');
    expect(sql).toContain('w.id is not null');
    expect(sql).toContain(
      'w.visibility_group_id in (:groupIdsUserIsEligibleFor)'
    );
    expect(sql).toContain(
      'pw.visibility_group_id in (:groupIdsUserIsEligibleFor)'
    );
    expect(params).toMatchObject({
      limit: 12,
      profileMatter: RateMatter.REP,
      waveMatter: RateMatter.WAVE_REP,
      groupIdsUserIsEligibleFor: ['group-1']
    });
    expect(options).toEqual({ wrappedConnection: connection });
    expect(timer.start).toHaveBeenCalledWith(
      'GlobalRepCategoryDb->getSuggestedCategories'
    );
    expect(timer.stop).toHaveBeenCalledWith(
      'GlobalRepCategoryDb->getSuggestedCategories'
    );
  });

  it('sorts wave REP analytics by absolute impact and respects visibility groups', async () => {
    const { service, execute } = createDb();

    await service.getWavesPage(
      {
        category: 'Dev extraordinaire',
        page: 1,
        page_size: 25,
        order: PageSortDirection.DESC,
        order_by: 'rep',
        groupIdsUserIsEligibleFor: ['group-1']
      },
      {}
    );

    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain(`join ${WAVES_TABLE} w on w.id = r.matter_target_id`);
    expect(sql).toContain(
      `left join ${WAVES_TABLE} pw on pw.id = w.parent_wave_id`
    );
    expect(sql).toContain('coalesce(w.is_direct_message, 0)');
    expect(sql).toContain(
      'w.visibility_group_id in (:groupIdsUserIsEligibleFor)'
    );
    expect(sql).toContain(
      'pw.visibility_group_id in (:groupIdsUserIsEligibleFor)'
    );
    expect(sql).toContain('pw.parent_wave_id is null');
    expect(sql).toContain('order by abs(gw.total_rep) desc');
    expect(sql).toContain('gw.total_rep desc');
    expect(params).toMatchObject({
      category: 'Dev extraordinaire',
      matter: RateMatter.WAVE_REP,
      groupIdsUserIsEligibleFor: ['group-1']
    });
  });

  it('loads embedded top wave contributors with one grouped window query', async () => {
    const { service, execute } = createDb();

    await service.getTopWaveContributorsByWaveIds(
      {
        category: 'Dev extraordinaire',
        waveIds: ['wave-1', 'wave-2'],
        topContributorsLimit: 3,
        groupIdsUserIsEligibleFor: ['group-1']
      },
      {}
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const [sql, params] = execute.mock.calls[0];
    expect(sql).toContain('with grouped_contributors as');
    expect(sql).toContain('sum(r.rating) as contribution');
    expect(sql).toContain('coalesce(w.is_direct_message, 0)');
    expect(sql).toContain('r.matter_target_id in (:waveIds)');
    expect(sql).toContain('row_number() over');
    expect(sql).toContain('partition by gc.wave_id');
    expect(sql).toContain('where rc.wave_rank <= :topContributorsLimit');
    expect(sql).not.toContain('r.rating as contribution');
    expect(params).toMatchObject({
      category: 'Dev extraordinaire',
      waveIds: ['wave-1', 'wave-2'],
      topContributorsLimit: 3,
      matter: RateMatter.WAVE_REP,
      groupIdsUserIsEligibleFor: ['group-1']
    });
  });
});
