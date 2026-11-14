import fc from 'fast-check';
import {
  compareNativeRankStandings,
  nativeRankTieTime
} from './native-competition-runtime.helpers';
import {
  NativeCompetitionRuntimeRepository,
  NativeDecisionWinner,
  NativeHistoryRow,
  NativeLeaderboardRow,
  NativeRuntimeEntry
} from './native-competition-runtime.repository';
import { NativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { competitionExecutionRouter } from './competition-execution.router';
import { Competition } from './competition.types';
import { CompetitionType } from '@/entities/ICompetition';

const DECISION_TIME = 1000;
const NOW = 1500;

describe('compareNativeRankStandings', () => {
  const standing = fc.record({
    rating: fc.integer({ min: -3, max: 3 }),
    tieTime: fc.integer({ min: 0, max: 3 }),
    identity: fc.constantFrom('a', 'b', 'c', 'd')
  });

  it('orders by rating, then earlier tie time, then identity', () => {
    const sorted = [
      { rating: 10, tieTime: 200, identity: 'a' },
      { rating: 10, tieTime: 100, identity: 'z' },
      { rating: 10, tieTime: 100, identity: 'b' },
      { rating: 20, tieTime: 900, identity: 'y' }
    ].sort(compareNativeRankStandings);
    expect(sorted.map((it) => it.identity)).toEqual(['y', 'b', 'z', 'a']);
  });

  it('is a total order: zero only for equal keys, antisymmetric, transitive', () => {
    fc.assert(
      fc.property(standing, standing, standing, (a, b, c) => {
        const ab = compareNativeRankStandings(a, b);
        const sameKeys =
          a.rating === b.rating &&
          a.tieTime === b.tieTime &&
          a.identity === b.identity;
        expect(ab === 0).toBe(sameKeys);
        expect(
          Math.sign(ab) + Math.sign(compareNativeRankStandings(b, a))
        ).toBe(0);
        if (ab <= 0 && compareNativeRankStandings(b, c) <= 0)
          expect(compareNativeRankStandings(a, c)).toBeLessThanOrEqual(0);
      })
    );
  });

  it('gives every entry of a time-locked competition the same tie time', () => {
    expect(
      nativeRankTieTime({ lastIncreasedAt: 5, submittedAt: 1 }, true, 77)
    ).toBe(77);
    expect(
      nativeRankTieTime({ lastIncreasedAt: 5, submittedAt: 1 }, false, 77)
    ).toBe(5);
    expect(
      nativeRankTieTime({ lastIncreasedAt: null, submittedAt: 1 }, false, 77)
    ).toBe(1);
  });
});

type Fixture = {
  readonly entries: NativeRuntimeEntry[];
  readonly history: NativeHistoryRow[];
};

function competition(
  timeLock: number,
  legacyOrigin: boolean,
  winners: number
): Competition {
  return {
    id: 'competition',
    wave_id: 'wave',
    type: CompetitionType.RANK,
    legacy_origin: legacyOrigin,
    outcome_config: [
      {
        type: 'MANUAL',
        description: 'prize',
        distribution: Array.from({ length: winners }, () => ({ amount: 1 }))
      }
    ],
    decisions: {
      strategy: {
        first_decision_time: DECISION_TIME,
        subsequent_decisions: [],
        is_rolling: false
      },
      next_decision_time: DECISION_TIME,
      time_lock_ms: timeLock,
      max_winners: null,
      winning_min_threshold: null,
      winning_max_threshold: null,
      winning_threshold_min_duration_ms: 0
    }
  } as unknown as Competition;
}

function entry(index: number, submittedAt: number): NativeRuntimeEntry {
  // Entry IDs and drop IDs sort in opposite directions, so the identity used
  // for the tie (legacy drop ID, native entry ID) is observable.
  return {
    id: `entry-${index}`,
    competition_id: 'competition',
    drop_id: `drop-${9 - index}`,
    submitter_id: `submitter-${index}`,
    submitted_at: submittedAt,
    real_time_rating: 0,
    last_increased_at: null
  } as unknown as NativeRuntimeEntry;
}

function fixture(
  votes: readonly (readonly { at: number; total: number }[])[]
): Fixture {
  const entries = votes.map((_, index) => entry(index, index * 10));
  let sequence = 0;
  const history = votes.flatMap((points, index) =>
    [...points]
      .sort((a, b) => a.at - b.at)
      .map(
        (point): NativeHistoryRow => ({
          kind: 'AGGREGATE',
          entry_id: entries[index].id,
          voter_profile_id: '',
          value: 0,
          aggregate_value: point.total,
          occurred_at: point.at,
          sequence: ++sequence,
          order_sequence: sequence
        })
      )
  );
  return { entries, history };
}

function service(
  saved: { winners: NativeDecisionWinner[]; rows: NativeLeaderboardRow[] } = {
    winners: [],
    rows: []
  }
) {
  const repository = {
    decisionProgress: jest.fn(async () => ({ latest: null, completed: 0 })),
    saveDecision: jest.fn(
      async (params: { winners: readonly NativeDecisionWinner[] }) => {
        saved.winners.push(...params.winners);
      }
    ),
    updateSchedule: jest.fn(async () => undefined),
    enqueueEvent: jest.fn(async () => undefined),
    saveLeaderboard: jest.fn(
      async (_id: string, rows: readonly NativeLeaderboardRow[]) => {
        saved.rows = [...rows];
        return false;
      }
    )
  };
  return new NativeCompetitionRuntimeService(
    repository as unknown as NativeCompetitionRuntimeRepository,
    {} as never,
    competitionExecutionRouter
  ) as any;
}

/** Entry IDs as the leaderboard ranks them at `time`, and as decided. */
async function leaderboardAndDecision(
  subject: Competition,
  data: Fixture,
  time: number
): Promise<{ leaderboard: string[]; decided: NativeDecisionWinner[] }> {
  const saved = {
    winners: [] as NativeDecisionWinner[],
    rows: [] as NativeLeaderboardRow[]
  };
  const runtime = service(saved);
  const { rows } = runtime.leaderboardRows(
    subject,
    { entries: [...data.entries], history: data.history, pauses: [] },
    time
  ) as { rows: NativeLeaderboardRow[] };
  await runtime.processRank(
    subject,
    { entries: [...data.entries], history: data.history, pauses: [] },
    NOW,
    {}
  );
  return {
    leaderboard: rows.map((row) => row.entry.id),
    decided: saved.winners
  };
}

describe('Rank decisions follow the published leaderboard order', () => {
  it.each([true, false])(
    'awards an equal score by earliest increase, not latest change (legacy=%s)',
    async (legacyOrigin) => {
      // entry-0 last increased at 100 and settled on 20 by decreasing at 150;
      // entry-1 increased to 20 at 200, the latest change of the two.
      const data = fixture([
        [
          { at: 100, total: 25 },
          { at: 150, total: 20 }
        ],
        [{ at: 200, total: 20 }]
      ]);
      const subject = competition(0, legacyOrigin, 1);
      const { leaderboard, decided } = await leaderboardAndDecision(
        subject,
        data,
        NOW
      );
      expect(leaderboard).toEqual(['entry-0', 'entry-1']);
      expect(decided.map((it) => [it.entry_id, it.rank])).toEqual([
        ['entry-0', 1]
      ]);
    }
  );

  it('awards a plain equal score to the earlier increase, not the later one', async () => {
    const data = fixture([[{ at: 200, total: 20 }], [{ at: 100, total: 20 }]]);
    const { leaderboard, decided } = await leaderboardAndDecision(
      competition(0, false, 2),
      data,
      NOW
    );
    expect(leaderboard).toEqual(['entry-1', 'entry-0']);
    expect(decided.map((it) => [it.entry_id, it.rank])).toEqual([
      ['entry-1', 1],
      ['entry-0', 2]
    ]);
  });

  it.each([
    [true, ['entry-1', 'entry-0']],
    [false, ['entry-0', 'entry-1']]
  ])(
    'breaks a time-locked tie by identity like the leaderboard (legacy=%s)',
    async (legacyOrigin, expected) => {
      const data = fixture([
        [{ at: 100, total: 20 }],
        [{ at: 100, total: 20 }]
      ]);
      const subject = competition(500, legacyOrigin, 2);
      const { leaderboard, decided } = await leaderboardAndDecision(
        subject,
        data,
        DECISION_TIME
      );
      expect(leaderboard).toEqual(expected);
      expect(decided.map((it) => it.entry_id)).toEqual(expected);
    }
  );

  it('picks exactly the head of the leaderboard evaluated at decision time', async () => {
    const point = fc.record({
      at: fc.integer({ min: 0, max: 999 }),
      total: fc.integer({ min: -2, max: 3 })
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(point, { maxLength: 4 }), {
          minLength: 1,
          maxLength: 5
        }),
        fc.constantFrom(0, 400),
        fc.boolean(),
        fc.integer({ min: 1, max: 3 }),
        async (votes, timeLock, legacyOrigin, winners) => {
          const subject = competition(timeLock, legacyOrigin, winners);
          const evaluationTime = timeLock > 0 ? DECISION_TIME : NOW;
          const { leaderboard, decided } = await leaderboardAndDecision(
            subject,
            fixture(votes),
            evaluationTime
          );
          expect(decided.map((it) => it.entry_id)).toEqual(
            leaderboard.slice(0, winners)
          );
          expect(decided.map((it) => it.rank)).toEqual(
            decided.map((_, index) => index + 1)
          );
        }
      ),
      { numRuns: 200 }
    );
  });
});
