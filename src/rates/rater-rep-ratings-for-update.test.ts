import * as fc from 'fast-check';
import { RateMatter } from '@/entities/IRating';
import { RatingsDb } from './ratings.db';

function createExecutor() {
  return {
    execute: jest.fn().mockResolvedValue([]),
    executeNativeQueriesInTransaction: jest.fn(),
    getAffectedRows: jest.fn()
  };
}

const CONNECTION = { connection: 'tx' };

describe('RatingsDb.getRaterRepRatingsForUpdate', () => {
  it('does nothing without pairs', async () => {
    const executor = createExecutor();
    const repo = new RatingsDb(() => executor as never);

    await expect(
      repo.getRaterRepRatingsForUpdate(
        { rater_profile_id: 'rater', pairs: [] },
        { connection: CONNECTION }
      )
    ).resolves.toEqual([]);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('creates and then locks exactly the rater rows of the requested pairs, in key order, in the transaction', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(
          fc.record({
            matter_target_id: fc.constantFrom('t1', 't2', 't3'),
            matter_category: fc.constantFrom('Art', 'Code', 'Memes')
          }),
          {
            minLength: 1,
            selector: (pair) =>
              `${pair.matter_target_id}|${pair.matter_category}`
          }
        ),
        async (pairs) => {
          const executor = createExecutor();
          const repo = new RatingsDb(() => executor as never);

          await repo.getRaterRepRatingsForUpdate(
            { rater_profile_id: 'rater', pairs },
            { connection: CONNECTION }
          );

          expect(executor.execute).toHaveBeenCalledTimes(2);
          const [[insertSql, params, insertOptions], [selectSql, , options]] =
            executor.execute.mock.calls;
          expect(insertSql).toContain('on duplicate key update');
          expect(selectSql).toMatch(
            /where \(rater_profile_id, matter_target_id, matter, matter_category\)\s+in \(/
          );
          expect(selectSql).toMatch(/for update\s*$/);
          expect(insertOptions).toEqual({ wrappedConnection: CONNECTION });
          expect(options).toEqual({ wrappedConnection: CONNECTION });
          expect(params.rater_profile_id).toBe('rater');
          expect(params.matter).toBe(RateMatter.REP);
          const locked = pairs.map((_, i) => [
            params[`target${i}`],
            params[`category${i}`]
          ]);
          const expected = pairs
            .map((pair) => [pair.matter_target_id, pair.matter_category])
            .sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1));
          expect(locked).toEqual(expected);
          // Every tuple names the rater, so no other rater's row is read.
          expect(selectSql.match(/:rater_profile_id/g)).toHaveLength(
            pairs.length
          );
        }
      )
    );
  });
});

describe('RatingsDb.lockRaterCreditOnMatter', () => {
  it('upserts the rater and matter row on the transaction connection', async () => {
    const executor = createExecutor();
    const repo = new RatingsDb(() => executor as never);

    await repo.lockRaterCreditOnMatter(
      { rater_profile_id: 'rater', matter: RateMatter.CIC },
      CONNECTION
    );

    expect(executor.execute).toHaveBeenCalledWith(
      expect.stringMatching(
        /insert into rating_credit_locks[\s\S]*on duplicate key update matter = matter/
      ),
      { rater_profile_id: 'rater', matter: RateMatter.CIC },
      { wrappedConnection: CONNECTION }
    );
  });
});
