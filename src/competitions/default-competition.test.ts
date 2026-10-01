import {
  normalizeDefaultCompetition,
  selectDefaultCompetition,
  DefaultCompetitionRecord
} from '@/competitions/default-competition';
import {
  CompetitionLifecycle as Lifecycle,
  CompetitionStorageMode as Storage,
  CompetitionType as Type
} from '@/entities/ICompetition';
import { aWave } from '@/tests/fixtures/wave.fixture';
import * as fc from 'fast-check';
import { WaveType } from '@/entities/IWave';

const wave = aWave({
  type: WaveType.RANK,
  participation_period_start: 100,
  voting_period_start: 200,
  participation_period_end: 200,
  voting_period_end: 300,
  next_decision_time: null
});
function record(
  id: string,
  overrides: Partial<DefaultCompetitionRecord> = {}
): DefaultCompetitionRecord {
  return {
    id,
    storage_mode: Storage.NATIVE,
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
      const input = normalizeDefaultCompetition(item, wave, now);
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
      normalizeDefaultCompetition(upcoming('future', 1000), wave, 500)?.phase
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
  it('ignores an archived lifecycle copied onto a still-running legacy mapping', () => {
    expect(
      normalizeDefaultCompetition(
        record('legacy', {
          storage_mode: Storage.LEGACY_ADAPTER,
          lifecycle: Lifecycle.ARCHIVED
        }),
        wave,
        250
      )?.phase
    ).toBe('active');
  });
  it('treats null starts as unbounded, never as creation time', () => {
    expect(
      normalizeDefaultCompetition(
        record('open', { participation_starts_at: null }),
        wave,
        50
      )?.phase
    ).toBe('active');
    expect(
      select([
        record('dated'),
        record('unbounded', { participation_starts_at: null })
      ]).competition_id
    ).toBe('unbounded');
  });
  it.each([Storage.NATIVE, Storage.LEGACY_ADAPTER])(
    'keeps a null end open (%s)',
    (storage_mode) => {
      const openWave = { ...wave, voting_period_end: null };
      expect(
        normalizeDefaultCompetition(
          record('open', { storage_mode, voting_ends_at: null }),
          openWave,
          500
        )?.phase
      ).toBe('active');
    }
  );
  it.each([Type.RANK, Type.APPROVE])(
    'reads current legacy dates, ignoring stale mapping lifecycle (%s)',
    (type) => {
      expect(
        normalizeDefaultCompetition(
          record('legacy', {
            storage_mode: Storage.LEGACY_ADAPTER,
            type,
            lifecycle: Lifecycle.ENDED,
            ended_at: 1
          }),
          { ...wave, next_decision_time: 400 },
          500
        )?.phase
      ).toBe('active');
    }
  );
  it('keeps native Approve deciding after vote close until runtime completion', () => {
    expect(
      normalizeDefaultCompetition(
        record('approve', { type: Type.APPROVE }),
        wave,
        500
      )?.phase
    ).toBe('active');
    expect(
      normalizeDefaultCompetition(ended('approve', 450), wave, 500)
    ).toMatchObject({ phase: 'completed', end: 450 });
  });
  it('keeps legacy Approve deciding until its winner quota is exhausted', () => {
    const approve = {
      ...wave,
      type: 'APPROVE' as typeof wave.type,
      max_winners: 2
    };
    const legacy = record('legacy', {
      storage_mode: Storage.LEGACY_ADAPTER,
      type: Type.APPROVE
    });
    expect(
      normalizeDefaultCompetition(legacy, approve, 500, 400, 1)?.phase
    ).toBe('active');
    expect(
      normalizeDefaultCompetition(legacy, approve, 500, 450, 2)
    ).toMatchObject({ phase: 'completed', end: 450 });
    expect(
      normalizeDefaultCompetition(
        legacy,
        { ...approve, max_winners: null },
        500,
        450,
        200
      )?.phase
    ).toBe('active');
  });

  it('uses half-open legacy and inclusive native end boundaries', () => {
    const native = record('native');
    const legacy = record('legacy', { storage_mode: Storage.LEGACY_ADAPTER });
    expect(normalizeDefaultCompetition(native, wave, 300)?.phase).toBe(
      'active'
    );
    expect(normalizeDefaultCompetition(native, wave, 301)?.phase).toBe(
      'completed'
    );
    expect(normalizeDefaultCompetition(legacy, wave, 300)?.phase).toBe(
      'completed'
    );
    expect(select([native], 250).next_refresh_at).toBe(301);
  });
  it('uses later legacy decisions as historical end and excludes archived unfinished history', () => {
    expect(
      normalizeDefaultCompetition(
        record('legacy', { storage_mode: Storage.LEGACY_ADAPTER }),
        wave,
        500,
        450
      )
    ).toMatchObject({ phase: 'completed', end: 450 });
    expect(
      normalizeDefaultCompetition(
        record('archived', {
          lifecycle: Lifecycle.ARCHIVED,
          type: Type.APPROVE
        }),
        wave,
        500
      )
    ).toBeNull();
  });
  it('refreshes at the upcoming start and honors runtime terminal lifecycle over open periods or pending decisions', () => {
    expect(select([upcoming('next', 500)], 250).next_refresh_at).toBe(500);
    expect(
      normalizeDefaultCompetition(
        record('ended', {
          lifecycle: Lifecycle.ENDED,
          ended_at: 240,
          voting_ends_at: null,
          decision_config: { next_decision_time: 999 }
        }),
        wave,
        250
      )?.phase
    ).toBe('completed');
  });
});
