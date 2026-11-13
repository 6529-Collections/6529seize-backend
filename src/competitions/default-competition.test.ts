import {
  normalizeDefaultCompetition,
  selectDefaultCompetition,
  DefaultCompetitionRecord
} from '@/competitions/default-competition';
import {
  CompetitionLifecycle as Lifecycle,
  CompetitionType as Type
} from '@/entities/ICompetition';
import * as fc from 'fast-check';

function record(
  id: string,
  overrides: Partial<DefaultCompetitionRecord> = {}
): DefaultCompetitionRecord {
  return {
    id,
    type: Type.RANK,
    lifecycle: Lifecycle.PUBLISHED,
    published_at: 1,
    ended_at: null,
    cancelled_at: null,
    participation_starts_at: 100,
    voting_starts_at: 200,
    participation_ends_at: 200,
    voting_ends_at: 300,
    decision_config: { next_decision_time: null },
    ...overrides
  };
}
function select(records: DefaultCompetitionRecord[], now = 250) {
  return selectDefaultCompetition(
    records.flatMap((item) => {
      const input = normalizeDefaultCompetition(item, now);
      return input ? [input] : [];
    }),
    now
  );
}
const ended = (id: string, end: number, archived = false) =>
  record(id, {
    lifecycle: archived ? Lifecycle.ARCHIVED : Lifecycle.ENDED,
    ended_at: end
  });
const upcoming = (id: string, start: number) =>
  record(id, {
    participation_starts_at: start,
    voting_starts_at: start + 1,
    participation_ends_at: start + 100,
    voting_ends_at: start + 200
  });

describe('default competition policy', () => {
  it('returns a chat hub for zero competitions, drafts, archived never-published drafts and cancellation-only records', () => {
    expect(select([]).competition_id).toBeNull();
    expect(
      select([
        record('draft', { lifecycle: Lifecycle.DRAFT }),
        record('archived-draft', {
          lifecycle: Lifecycle.ARCHIVED,
          published_at: null
        }),
        record('cancelled', {
          lifecycle: Lifecycle.CANCELLED,
          cancelled_at: 999
        })
      ]).competition_id
    ).toBeNull();
  });
  it.each([
    record('one'),
    upcoming('one', 900),
    ended('one', 10),
    ended('one', 10, true)
  ])('selects the only eligible record (%s)', (item) =>
    expect(select([item]).competition_id).toBe('one')
  );
  it('prefers active over upcoming and archived/ended history', () => {
    expect(
      select([
        ended('history', 240),
        ended('archived', 249, true),
        upcoming('soon', 300),
        record('active')
      ]).competition_id
    ).toBe('active');
  });
  it('orders active by competition start, with ID ties independent of creation or collection order', () => {
    expect(
      select([record('new'), record('old', { participation_starts_at: 50 })])
        .competition_id
    ).toBe('old');
    expect(select([record('b'), record('a')]).competition_id).toBe('a');
  });
  it('includes overdue or paused decisions, but does not activate an upcoming paused competition', () => {
    expect(
      select(
        [
          record('old', { decision_config: { next_decision_time: 200 } }),
          upcoming('future', 1000)
        ],
        500
      ).competition_id
    ).toBe('old');
    expect(
      normalizeDefaultCompetition(upcoming('future', 1000), 500)?.phase
    ).toBe('upcoming');
  });
  it('prefers soonest upcoming over completed history', () => {
    expect(
      select([
        ended('last', 249),
        upcoming('later', 900),
        upcoming('soon', 500)
      ]).competition_id
    ).toBe('soon');
  });
  it('uses latest end including archived history, independent of archive time and cancellations', () => {
    expect(
      select(
        [
          ended('first', 10),
          ended('last', 20, true),
          record('cancelled', {
            lifecycle: Lifecycle.CANCELLED,
            cancelled_at: 999
          })
        ],
        500
      ).competition_id
    ).toBe('last');
    expect(select([ended('b', 20), ended('a', 20, true)]).competition_id).toBe(
      'a'
    );
  });
  it('considers a winner beyond any first collection page', () => {
    const records = Array.from({ length: 130 }, (_, index) =>
      upcoming(String(index), 900 + index)
    );
    records.push(record('winner'));
    expect(select(records).competition_id).toBe('winner');
  });
  it('is permutation invariant', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1 }),
        (starts) => {
          const records = starts.map((start, index) =>
            upcoming(String(index), start)
          );
          expect(select(records).competition_id).toBe(
            select([...records].reverse()).competition_id
          );
        }
      )
    );
  });
});

describe('default timing normalization', () => {
  it.each(['{broken', 'null', 'false', '{}', '{"next_decision_time":"bad"}'])(
    'excludes an invalid native decision config without breaking other candidates (%s)',
    (decision_config) => {
      expect(
        select([record('bad', { decision_config }), record('valid')])
          .competition_id
      ).toBe('valid');
      expect(
        select([record('bad', { decision_config })]).competition_id
      ).toBeNull();
    }
  );

  it('treats null starts as unbounded and null ends as open', () => {
    expect(
      normalizeDefaultCompetition(
        record('open', { participation_starts_at: null }),
        50
      )?.phase
    ).toBe('active');
    expect(
      select([
        record('dated'),
        record('unbounded', { participation_starts_at: null })
      ]).competition_id
    ).toBe('unbounded');
    expect(
      normalizeDefaultCompetition(record('open', { voting_ends_at: null }), 500)
        ?.phase
    ).toBe('active');
  });
  it('keeps Approve deciding after vote close until runtime completion', () => {
    expect(
      normalizeDefaultCompetition(
        record('approve', { type: Type.APPROVE }),
        500
      )?.phase
    ).toBe('active');
    expect(
      normalizeDefaultCompetition(ended('approve', 450), 500)
    ).toMatchObject({ phase: 'completed', end: 450 });
  });
  it('uses inclusive native end boundaries', () => {
    expect(normalizeDefaultCompetition(record('native'), 300)?.phase).toBe(
      'active'
    );
    expect(normalizeDefaultCompetition(record('native'), 301)?.phase).toBe(
      'completed'
    );
    expect(select([record('native')], 250).next_refresh_at).toBe(301);
  });
  it('excludes unfinished archived competitions and honors runtime completion over open/pending periods', () => {
    expect(
      normalizeDefaultCompetition(
        record('archived', {
          lifecycle: Lifecycle.ARCHIVED,
          type: Type.APPROVE
        }),
        500
      )
    ).toBeNull();
    expect(select([upcoming('next', 500)], 250).next_refresh_at).toBe(500);
    expect(
      normalizeDefaultCompetition(
        record('ended', {
          lifecycle: Lifecycle.ENDED,
          ended_at: 240,
          voting_ends_at: null,
          decision_config: { next_decision_time: 999 }
        }),
        250
      )?.phase
    ).toBe('completed');
  });
});
