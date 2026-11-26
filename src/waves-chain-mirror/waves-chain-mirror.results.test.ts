import {
  aBoardRow,
  aChainDecision,
  aChainDecisionState,
  aChainEntry,
  aChainResult,
  aChainVote,
  aCompetition,
  applyWritesInMemory,
  aTargetEntry,
  aTargetState,
  chainId,
  someLookups,
  uuid
} from '@/tests/fixtures/waves-chain-mirror.fixture';
import {
  awardRowId,
  chainExecutionKey,
  lifecycleEventId,
  resultDecisionId
} from './waves-chain-mirror.ids';
import { planDecision, planWrites } from './waves-chain-mirror.plan';
import {
  ChainDecisionState,
  TargetCompetition,
  TargetCompetitionState
} from './waves-chain-mirror.types';

const D = chainId('d1');
const C = uuid(1);
const E = (n: number) => chainId(`e${n}`);
const DROP = (n: number) => uuid(10 + n);
const ROW = (n: number) => uuid(20 + n);
const V1 = chainId('b1');
const V2 = chainId('b2');
const T1 = 1_764_000_000_000;
const T2 = T1 + 86_400_000;
const NOW = 1_765_000_000_000;
const DECISION = resultDecisionId(C, T1);

const outcomes = [
  {
    type: 'NIC',
    description: 'NIC',
    credit: 'NIC',
    amount: 1000,
    distribution: [{ amount: 60, description: 'first' }, { amount: 40 }]
  },
  { type: 'MANUAL', description: 'A prize' }
];

function chain(parts: Partial<ChainDecisionState> = {}, status = 'published') {
  return aChainDecisionState(
    aChainDecision({
      decisionId: D,
      legacyId: C,
      status,
      nextResultTime: T2,
      data: { counted: true }
    }),
    {
      entries: [
        aChainEntry({
          entryId: E(1),
          decisionId: D,
          legacyId: DROP(1),
          status: 'winner',
          total: '90'
        }),
        aChainEntry({
          entryId: E(2),
          decisionId: D,
          legacyId: DROP(2),
          status: 'winner',
          total: '40'
        }),
        aChainEntry({
          entryId: E(3),
          decisionId: D,
          legacyId: DROP(3),
          status: 'active',
          total: '5'
        })
      ],
      votes: [aChainVote(E(1), V1, 50), aChainVote(E(3), V2, 5)],
      board: status === 'published' ? [aBoardRow(E(3), 1, 5, 5)] : null,
      results: [
        aChainResult({
          resultTime: T1,
          data: {
            settledHeight: 20,
            winners: [
              { entryId: E(1), rank: 1, score: '88' },
              { entryId: E(2), rank: 2, score: '40' }
            ]
          }
        })
      ],
      ...parts
    }
  );
}

function target(
  competition: Partial<TargetCompetition> = {},
  parts: Partial<TargetCompetitionState> = {}
): TargetCompetitionState {
  return aTargetState(
    aCompetition({
      id: C,
      outcomeConfig: outcomes,
      decisionConfig: { next_decision_time: T1, time_lock_ms: null },
      ...competition
    }),
    {
      entries: [1, 2, 3].map((n) =>
        aTargetEntry({ id: ROW(n), dropId: DROP(n) })
      ),
      board: [1, 2, 3].map((n) => ({
        entryId: ROW(n),
        dropId: DROP(n),
        rating: 1,
        realTimeRating: 1,
        rank: n,
        submittedAt: 1,
        updatedAt: 1,
        orderingTime: 1,
        decisionRating: 1,
        overThresholdSince: null,
        publishedAt: null
      })),
      ...parts
    }
  );
}

const lookups = (now = NOW) =>
  someLookups({
    now,
    network: 'net-1',
    profiles: { [V1]: 'p1', [V2]: 'p2', [chainId('b3')]: 'p3' },
    resultFinalTimes: { [T1]: T1 + 30_000 },
    // V3's vote on the runner-up was released after the result.
    releasedVotes: { [E(2)]: { [chainId('b3')]: '40' } }
  });

describe('mirror plan: results', () => {
  it('writes a decided result as the runtime writes one', () => {
    const p = planDecision({
      chain: chain(),
      target: target({ capabilities: ['MAIN_STAGE'] }),
      lookups: lookups()
    });
    const r = p.writes.results;
    expect(r.decisions).toEqual([
      {
        id: DECISION,
        scheduledAt: T1,
        decidedAt: T1 + 30_000,
        status: 'COMPLETED',
        executionKey: chainExecutionKey('net-1', D, T1),
        createdAt: T1 + 30_000
      }
    ]);
    expect(r.winners).toEqual([
      {
        decisionId: DECISION,
        entryId: ROW(1),
        rank: 1,
        finalRating: 88,
        createdAt: T1 + 30_000
      },
      {
        decisionId: DECISION,
        entryId: ROW(2),
        rank: 2,
        finalRating: 40,
        createdAt: T1 + 30_000
      }
    ]);
    expect(r.winnerEntries).toEqual([
      { id: ROW(1), rank: 1, wonAt: T1, decisionId: DECISION },
      { id: ROW(2), rank: 2, wonAt: T1, decisionId: DECISION }
    ]);
    expect(r.winnerVotes).toEqual([
      {
        decisionId: DECISION,
        entryId: ROW(1),
        voterProfileId: 'p1',
        value: 50
      },
      { decisionId: DECISION, entryId: ROW(2), voterProfileId: 'p3', value: 40 }
    ]);
    expect(
      r.awards.map((a) => [a.entryId, a.outcomePosition, a.award.amount, a.id])
    ).toEqual([
      [ROW(1), 0, 600, awardRowId(DECISION, ROW(1), 0)],
      [ROW(1), 1, null, awardRowId(DECISION, ROW(1), 1)],
      [ROW(2), 0, 400, awardRowId(DECISION, ROW(2), 0)]
    ]);
    // Their board rows go; the active entry's row is the board's own.
    expect(p.writes.board.remove.sort()).toEqual([ROW(1), ROW(2)].sort());
    expect(p.changes.competition_leaderboard_entries.delete).toBe(2);
    expect(r.mainStageMints).toEqual([DROP(1)]);
    // The next result time moves on; nothing goes to the outbox.
    expect(r.competition).toEqual({
      lifecycle: null,
      lifecycleFrom: 'PUBLISHED',
      nextDecisionTime: T2,
      at: NOW
    });
    expect(Object.keys(p.changes)).not.toContain('competition_outbox');
  });

  it('writes a skipped result as cancelled, with no winners', () => {
    const p = planDecision({
      chain: chain({
        results: [aChainResult({ resultTime: T1, status: 'skipped' })]
      }),
      target: target(),
      lookups: lookups()
    });
    expect(p.writes.results.decisions.map((d) => d.status)).toEqual([
      'CANCELLED'
    ]);
    expect(p.writes.results.winners).toEqual([]);
    expect(p.writes.results.mainStageMints).toEqual([]);
  });

  it("leaves 6529.io's own result for the same time, imported results and results not final", () => {
    const own = planDecision({
      chain: chain(),
      target: target(
        {},
        {
          decisions: [
            {
              id: DECISION,
              scheduledAt: T1,
              decidedAt: T1,
              status: 'COMPLETED',
              executionKey: `native:${C}:${T1}`,
              createdAt: T1
            }
          ]
        }
      ),
      lookups: lookups()
    });
    expect(own.writes.results.decisions).toEqual([]);
    expect(own.writes.results.winners).toEqual([]);
    expect(own.waiting).toMatchObject({ result_held_by_6529io: 1 });

    const others = planDecision({
      chain: chain({
        results: [
          aChainResult({ resultTime: T1, origin: 'legacy' }),
          aChainResult({ resultTime: T2, stage: 'scoring', status: 'counting' })
        ]
      }),
      target: target(),
      lookups: lookups()
    });
    expect(others.writes.results.decisions).toEqual([]);
  });

  it('waits for winners 6529.io has no entry of, and for unmapped voters', () => {
    const p = planDecision({
      chain: chain({
        entries: [
          aChainEntry({
            entryId: E(1),
            decisionId: D,
            legacyId: null,
            status: 'winner'
          }),
          aChainEntry({
            entryId: E(2),
            decisionId: D,
            legacyId: DROP(2),
            status: 'winner'
          })
        ],
        votes: [aChainVote(E(2), chainId('b9'), 3)]
      }),
      target: target(),
      lookups: lookups()
    });
    expect(p.writes.results.winners.map((w) => w.entryId)).toEqual([ROW(2)]);
    expect(p.waiting).toMatchObject({
      winner_entry_without_row: 1,
      winner_vote_voter_unmapped: 1
    });
  });

  it('moves the lifecycle forward only, with a lifecycle event', () => {
    const ended = planDecision({
      chain: chain({}, 'ended'),
      target: target(),
      lookups: lookups()
    });
    expect(ended.writes.results.competition).toEqual({
      lifecycle: 'ENDED',
      lifecycleFrom: 'PUBLISHED',
      nextDecisionTime: null,
      at: NOW
    });
    expect(ended.writes.results.lifecycleEvents).toEqual([
      {
        id: lifecycleEventId(C, 'ENDED'),
        previous: 'PUBLISHED',
        lifecycle: 'ENDED',
        at: NOW
      }
    ]);
    const behind = planDecision({
      chain: chain({}, 'published'),
      target: target({
        lifecycle: 'ARCHIVED',
        decisionConfig: { next_decision_time: T2 }
      }),
      lookups: lookups()
    });
    expect(behind.writes.results.competition).toBeNull();
    expect(behind.waiting).toMatchObject({ lifecycle_conflict: 1 });
  });

  it("queues the claim the index skipped once a chain-made winner's drop is written", () => {
    const made = chain({
      entries: [
        aChainEntry({
          entryId: E(1),
          decisionId: D,
          legacyId: null,
          origin: 'native',
          status: 'winner',
          total: '90',
          data: { manifestHash: '0xABC', createdMs: 1 }
        }),
        aChainEntry({
          entryId: E(2),
          decisionId: D,
          legacyId: DROP(2),
          status: 'winner'
        })
      ]
    });
    const skipped = [
      { network: 'net-1', occurrence: 4, height: 40, entryId: E(1) }
    ];
    const withDrop = target(
      { capabilities: ['MAIN_STAGE'] },
      {
        entries: [
          // The chain-made winner's drop, written by the mirror before.
          aTargetEntry({ id: ROW(1), dropId: E(1) }),
          aTargetEntry({ id: ROW(2), dropId: DROP(2) })
        ]
      }
    );
    const p = planDecision({
      chain: made,
      target: withDrop,
      lookups: someLookups({ now: NOW, skippedClaimBuilds: skipped })
    });
    expect(p.writes.results.claimBuilds).toEqual([
      {
        network: 'net-1',
        decisionId: D,
        occurrence: 4,
        dropId: E(1),
        message: {
          drop_id: E(1),
          chain: {
            decision_id: D,
            occurrence: 4,
            entry_id: E(1),
            height: 40,
            manifest_hash: '0xabc'
          }
        }
      }
    ]);
    expect(p.changes.chain_claim_builds).toEqual({
      insert: 0,
      update: 1,
      delete: 0
    });

    // Without the drop yet: it waits.
    const waiting = planDecision({
      chain: made,
      target: target({ capabilities: ['MAIN_STAGE'] }, { entries: [] }),
      lookups: someLookups({ now: NOW, skippedClaimBuilds: skipped })
    });
    expect(waiting.writes.results.claimBuilds).toEqual([]);
    expect(waiting.waiting).toMatchObject({ claim_build_without_drop: 1 });
  });

  it("freezes the Main Stage winner's collaborations whenever the winner is written, not only with its result", () => {
    // The result was written before the winner's entry had a row.
    const decisionRow = {
      id: DECISION,
      scheduledAt: T1,
      decidedAt: T1 + 30_000,
      status: 'COMPLETED',
      executionKey: chainExecutionKey('net-1', D, T1),
      createdAt: T1 + 30_000
    };
    const p = planDecision({
      chain: chain(),
      target: target(
        { capabilities: ['MAIN_STAGE'] },
        { decisions: [decisionRow] }
      ),
      lookups: lookups()
    });
    expect(p.writes.results.decisions).toEqual([]);
    expect(p.writes.results.winnerEntries.map((w) => w.id)).toEqual([
      ROW(1),
      ROW(2)
    ]);
    expect(p.writes.results.mainStageMints).toEqual([DROP(1)]);
  });

  it('waits with a result whose final block has no known time', () => {
    const p = planDecision({
      chain: chain(),
      target: target(),
      lookups: someLookups({ now: NOW, network: 'net-1' })
    });
    expect(p.writes.results.decisions).toEqual([]);
    expect(p.writes.results.winners).toEqual([]);
    expect(p.waiting).toMatchObject({ result_without_time: 1 });
  });

  it("writes a winner's votes in a later run, once its entry has a row and its voters a profile", () => {
    // The result is written while the winner has no 6529.io row and V1 no
    // profile: no winner votes yet.
    const first = planDecision({
      chain: chain(),
      target: target({}, { entries: [], board: [] }),
      lookups: someLookups({
        now: NOW,
        network: 'net-1',
        resultFinalTimes: { [T1]: T1 + 30_000 }
      })
    });
    expect(first.writes.results.decisions).toHaveLength(1);
    expect(first.writes.results.winnerVotes).toEqual([]);
    let state = applyWritesInMemory(
      target({}, { entries: [], board: [] }),
      first.writes
    );
    // Later: the rows and the profile are there; the votes are written.
    state = {
      ...state,
      entries: [1, 2, 3].map((n) =>
        aTargetEntry({ id: ROW(n), dropId: DROP(n) })
      )
    };
    const later = planDecision({
      chain: chain(),
      target: state,
      lookups: lookups(NOW + 60_000)
    });
    expect(later.writes.results.decisions).toEqual([]);
    expect(later.writes.results.winnerVotes).toEqual([
      {
        decisionId: DECISION,
        entryId: ROW(1),
        voterProfileId: 'p1',
        value: 50
      },
      { decisionId: DECISION, entryId: ROW(2), voterProfileId: 'p3', value: 40 }
    ]);
    // Once written, never written again or changed.
    const after = applyWritesInMemory(state, later.writes);
    const again = planDecision({
      chain: chain({
        votes: [aChainVote(E(1), V1, 70), aChainVote(E(3), V2, 5)]
      }),
      target: after,
      lookups: lookups(NOW + 120_000)
    });
    expect(again.writes.results.winnerVotes).toEqual([]);
  });

  it('writes nothing the second time', () => {
    for (const status of ['published', 'ended']) {
      let t = target({ capabilities: ['MAIN_STAGE'] });
      const c = chain({}, status);
      const first = planDecision({ chain: c, target: t, lookups: lookups() });
      expect(planWrites(first)).toBeGreaterThan(0);
      t = applyWritesInMemory(t, first.writes);
      const second = planDecision({
        chain: c,
        target: t,
        lookups: lookups(NOW + 60_000)
      });
      expect(second.changes).toEqual({});
      expect(second.writes.results.mainStageMints).toEqual([]);
    }
  });
});
