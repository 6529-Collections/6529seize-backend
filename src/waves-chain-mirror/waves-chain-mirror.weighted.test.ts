import {
  aBoardRow,
  aChainDecision,
  aChainDecisionState,
  aChainEntry,
  aChainResult,
  aCompetition,
  aTargetEntry,
  aTargetState,
  chainId,
  someLookups,
  uuid
} from '@/tests/fixtures/waves-chain-mirror.fixture';
import { resultDecisionId } from './waves-chain-mirror.ids';
import { planDecision } from './waves-chain-mirror.plan';
import { TargetScorePoint } from './waves-chain-mirror.types';

const D = chainId('d1');
const C = uuid(1);
const E1 = chainId('e1');
const DROP1 = uuid(11);
const ROW_1 = uuid(21);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_765_000_000_000;

const point = (
  fields: Partial<TargetScorePoint> & { value: number; occurredAt: number }
): TargetScorePoint => ({
  kind: 'AGGREGATE',
  entryId: ROW_1,
  voterProfileId: '',
  sequence: fields.occurredAt,
  ...fields
});

describe('mirror plan: weighted ratings as the runtime computes them', () => {
  it("projects a time-locked board's decision rating to the next result", () => {
    // Voted to 1000 an hour ago under a 24-hour lock; the result is in an
    // hour: the chain's score now is 41, the rating at the result 83.
    const chain = aChainDecisionState(
      aChainDecision({
        decisionId: D,
        legacyId: C,
        nextResultTime: NOW + HOUR,
        data: { counted: true }
      }),
      {
        entries: [
          aChainEntry({
            entryId: E1,
            decisionId: D,
            legacyId: DROP1,
            total: '1000'
          })
        ],
        board: [aBoardRow(E1, 1, 41, 1000)]
      }
    );
    const target = aTargetState(
      aCompetition({ id: C, decisionConfig: { time_lock_ms: DAY } }),
      {
        entries: [aTargetEntry({ id: ROW_1, dropId: DROP1 })],
        scoreHistory: [point({ value: 1000, occurredAt: NOW - HOUR })]
      }
    );
    const p = planDecision({
      chain,
      target,
      lookups: someLookups({ now: NOW })
    });
    expect(p.writes.board.upsert[0]).toMatchObject({
      rating: 41,
      realTimeRating: 1000,
      decisionRating: Math.floor((1000 * 2 * HOUR) / DAY)
    });
  });

  it("writes a new result's winner votes weighted over the lock, so they add up to its rating", () => {
    const T = NOW;
    const chain = aChainDecisionState(
      aChainDecision({ decisionId: D, legacyId: C, data: { counted: true } }),
      {
        entries: [
          aChainEntry({
            entryId: E1,
            decisionId: D,
            legacyId: DROP1,
            status: 'winner'
          })
        ],
        board: [],
        results: [
          aChainResult({
            resultTime: T,
            data: { winners: [{ entryId: E1, rank: 1, score: '62' }] }
          })
        ]
      }
    );
    const target = aTargetState(
      aCompetition({ id: C, decisionConfig: { time_lock_ms: DAY } }),
      {
        entries: [aTargetEntry({ id: ROW_1, dropId: DROP1 })],
        scoreHistory: [
          point({
            kind: 'VOTER',
            voterProfileId: 'p1',
            value: 100,
            occurredAt: T - 12 * HOUR
          }),
          point({
            kind: 'VOTER',
            voterProfileId: 'p2',
            value: 50,
            occurredAt: T - 6 * HOUR
          }),
          // A vote taken back before the result counts for its time.
          point({
            kind: 'VOTER',
            voterProfileId: 'p3',
            value: 48,
            occurredAt: T - DAY
          }),
          point({
            kind: 'VOTER',
            voterProfileId: 'p3',
            value: 0,
            occurredAt: T - 12 * HOUR
          })
        ]
      }
    );
    const p = planDecision({
      chain,
      target,
      lookups: someLookups({ now: NOW, resultFinalTimes: { [T]: T + 1 } })
    });
    const decisionId = resultDecisionId(C, T);
    expect(p.writes.results.winnerVotes).toEqual([
      { decisionId, entryId: ROW_1, voterProfileId: 'p1', value: 50 },
      { decisionId, entryId: ROW_1, voterProfileId: 'p2', value: 12 },
      { decisionId, entryId: ROW_1, voterProfileId: 'p3', value: 24 }
    ]);
  });

  it('gives a voter with no series in the history (unmapped when voting) the vote it had when it won', () => {
    const T = NOW;
    const [B1, B2, B3] = [chainId('b1'), chainId('b2'), chainId('b3')];
    const chain = aChainDecisionState(
      aChainDecision({ decisionId: D, legacyId: C, data: { counted: true } }),
      {
        entries: [
          aChainEntry({
            entryId: E1,
            decisionId: D,
            legacyId: DROP1,
            status: 'winner'
          })
        ],
        votes: [
          { entryId: E1, voter: B1, value: '10', updatedHeight: 5 },
          // Voted while unmapped: an AGGREGATE point only, no VOTER series.
          { entryId: E1, voter: B2, value: '10', updatedHeight: 6 },
          // Voted just before the result: a series, weighted to nothing.
          { entryId: E1, voter: B3, value: '7', updatedHeight: 7 }
        ],
        board: [],
        results: [
          aChainResult({
            resultTime: T,
            data: { winners: [{ entryId: E1, rank: 1, score: '20' }] }
          })
        ]
      }
    );
    const target = aTargetState(
      aCompetition({ id: C, decisionConfig: { time_lock_ms: DAY } }),
      {
        entries: [aTargetEntry({ id: ROW_1, dropId: DROP1 })],
        scoreHistory: [
          point({
            kind: 'VOTER',
            voterProfileId: 'p1',
            value: 10,
            occurredAt: T - 2 * DAY
          }),
          point({ value: 10, occurredAt: T - 2 * DAY }),
          point({ value: 20, occurredAt: T - 2 * DAY + 1 }),
          point({
            kind: 'VOTER',
            voterProfileId: 'p3',
            value: 7,
            occurredAt: T
          })
        ]
      }
    );
    const p = planDecision({
      chain,
      target,
      lookups: someLookups({
        now: NOW,
        resultFinalTimes: { [T]: T + 1 },
        profiles: { [B1]: 'p1', [B2]: 'p2', [B3]: 'p3' }
      })
    });
    const decisionId = resultDecisionId(C, T);
    // p1 from its series, p2 from the chain: they add up to the rating.
    expect(p.writes.results.winnerVotes).toEqual([
      { decisionId, entryId: ROW_1, voterProfileId: 'p1', value: 10 },
      { decisionId, entryId: ROW_1, voterProfileId: 'p2', value: 10 }
    ]);
  });
});
