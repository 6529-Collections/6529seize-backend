import { PageSortDirection } from '@/api/page-request';
import { IDENTITIES_TABLE, RATINGS_TABLE } from '@/constants';
import { RateMatter } from '@/entities/IRating';
import { GlobalRepCategoryDb } from './global-rep-category.db';

function createDb() {
  const execute = jest.fn().mockResolvedValue([]);
  const oneOrNull = jest.fn().mockResolvedValue(null);
  const service = new GlobalRepCategoryDb(
    () =>
      ({
        execute,
        oneOrNull
      }) as any
  );

  return { service, execute, oneOrNull };
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

  it('returns a stable ratings page ordered by signed rep', async () => {
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
    expect(sql).toContain('order by r.rating desc');
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
    expect(sql).toContain('order by coalesce(');
    expect(sql).toContain('asc, gp.profile_id asc');
    expect(params).toMatchObject({
      category: 'Dev extraordinaire',
      searchLike: '%alice%',
      offset: 0,
      limitPlusOne: 51
    });
  });
});
