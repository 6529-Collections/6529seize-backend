import { RateMatter } from '@/entities/IRating';
import { RatingsDb } from './ratings.db';

function createExecutor() {
  return {
    execute: jest.fn().mockResolvedValue([]),
    executeNativeQueriesInTransaction: jest.fn(),
    getAffectedRows: jest.fn()
  };
}

describe('RatingsDb over-rate cleanup queries', () => {
  it('tallies every REP, CIC and WAVE_REP rating with no rater or category exemption', async () => {
    const executor = createExecutor();
    const repo = new RatingsDb(() => executor as never);

    await repo.getOverRateMatters();

    expect(executor.execute).toHaveBeenCalledTimes(1);
    const [sql, params] = executor.execute.mock.calls[0];
    expect(sql).toContain("where r.matter in ('REP', 'CIC', 'WAVE_REP')");
    expect(sql).not.toContain('matter_category');
    expect(sql).not.toContain('handle');
    expect(params).toBeUndefined();
  });

  it('gives a rater without an identity no credit, so its ratings are reduced', async () => {
    const executor = createExecutor();
    const repo = new RatingsDb(() => executor as never);

    await repo.getOverRateMatters();

    const [sql] = executor.execute.mock.calls[0];
    expect(sql).toContain('coalesce(i.tdh + i.xtdh, 0) as rater_credit');
    expect(sql).toContain(
      'where floor(coalesce(i.tdh + i.xtdh, 0)) < abs(rt.tally)'
    );
  });

  it("selects all of the rater's ratings on the matter to reduce", async () => {
    const executor = createExecutor();
    const repo = new RatingsDb(() => executor as never);
    const connection = { connection: {} };

    await repo.getRatingsOnMatter(
      {
        rater_profile_id: 'rater-profile',
        matter: RateMatter.REP
      },
      connection
    );

    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringContaining(
        'where rater_profile_id = :rater_profile_id and matter = :matter'
      ),
      {
        rater_profile_id: 'rater-profile',
        matter: RateMatter.REP
      },
      { wrappedConnection: connection }
    );
    expect(executor.execute.mock.calls[0][0]).not.toContain('matter_category');
  });
});
