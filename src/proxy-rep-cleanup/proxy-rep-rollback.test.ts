import fc from 'fast-check';
import { subtractCase, summarizeRatingDeltas } from './proxy-rep-rollback';

describe('proxy REP rollback deltas', () => {
  it('sums each target and counts its non-zero ratings', () => {
    expect(
      summarizeRatingDeltas([
        { matter_target_id: 'b', rating: 3 },
        { matter_target_id: 'a', rating: '0' },
        { matter_target_id: 'b', rating: -1 },
        { matter_target_id: 'a', rating: 2 }
      ])
    ).toEqual([
      { profile_id: 'a', rep: 2, nonzero: 1 },
      { profile_id: 'b', rep: 2, nonzero: 2 }
    ]);
  });

  it('preserves the total for any input', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            matter_target_id: fc.constantFrom('x', 'y', 'z'),
            rating: fc.integer({ min: -1000, max: 1000 })
          })
        ),
        (rows) => {
          const deltas = summarizeRatingDeltas(rows);
          expect(deltas.reduce((sum, d) => sum + d.rep, 0)).toBe(
            rows.reduce((sum, row) => sum + row.rating, 0)
          );
          expect(deltas.reduce((sum, d) => sum + d.nonzero, 0)).toBe(
            rows.filter((row) => row.rating !== 0).length
          );
        }
      )
    );
  });

  it('builds a parameterised CASE subtraction', () => {
    expect(
      subtractCase(
        'level_raw',
        [
          { profile_id: 'a', rep: 2, nonzero: 1 },
          { profile_id: 'b', rep: 5, nonzero: 3 }
        ],
        (delta) => delta.rep
      )
    ).toEqual({
      sql: '`level_raw` = `level_raw` - CASE profile_id WHEN ? THEN ? WHEN ? THEN ? ELSE 0 END',
      params: ['a', 2, 'b', 5]
    });
  });
});
