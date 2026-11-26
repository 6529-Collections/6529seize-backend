import {
  aBoardRow,
  aChainDecision,
  aChainDecisionState,
  aChainEntry,
  aChainVote,
  aCompetition,
  applyWritesInMemory,
  aTargetEntry,
  aTargetState,
  chainId,
  someLookups,
  uuid
} from '@/tests/fixtures/waves-chain-mirror.fixture';
import { voteRowId } from './waves-chain-mirror.ids';
import { planDecision, planWrites } from './waves-chain-mirror.plan';
import {
  ChainDecisionState,
  TargetCompetitionState,
  TargetVote
} from './waves-chain-mirror.types';

const D = chainId('d1');
const C = uuid(1);
const E1 = chainId('e1');
const E2 = chainId('e2');
const E3 = chainId('e3');
const V1 = chainId('b1');
const V2 = chainId('b2');
const V3 = chainId('b3');
const DROP1 = uuid(11);
const DROP2 = uuid(12);
const DROP3 = uuid(13);
const ROW_1 = uuid(21);
const ROW_2 = uuid(22);
const ROW_3 = uuid(23);
const NOW = 1_765_000_000_000;

const profiles = { [V1]: 'p1', [V2]: 'p2' };

function chain(parts: Partial<ChainDecisionState> = {}): ChainDecisionState {
  return aChainDecisionState(aChainDecision({ decisionId: D, legacyId: C }), {
    entries: [
      aChainEntry({ entryId: E1, decisionId: D, legacyId: DROP1, total: '30' }),
      aChainEntry({ entryId: E2, decisionId: D, legacyId: DROP2, total: '0' })
    ],
    ...parts
  });
}

function target(
  parts: Partial<TargetCompetitionState> = {},
  competition = aCompetition({ id: C })
): TargetCompetitionState {
  return aTargetState(competition, {
    entries: [
      aTargetEntry({ id: ROW_1, dropId: DROP1, submittedAt: 100 }),
      aTargetEntry({ id: ROW_2, dropId: DROP2, submittedAt: 200 }),
      // An entry 6529.io has that the chain doesn't.
      aTargetEntry({ id: ROW_3, dropId: DROP3, submittedAt: 300 })
    ],
    ...parts
  });
}

const aVote = (fields: Partial<TargetVote> & { id: string }): TargetVote => ({
  entryId: ROW_1,
  voterProfileId: 'p1',
  value: 10,
  creditSpent: 10,
  createdAt: 1,
  updatedAt: 1,
  ...fields
});

function plan(c: ChainDecisionState, t: TargetCompetitionState, lookups = {}) {
  return planDecision({
    chain: c,
    target: t,
    lookups: someLookups({
      profiles,
      now: NOW,
      blockTimes: { 10: 5_000, 11: 6_000 },
      ...lookups
    })
  });
}

describe('mirror plan: votes', () => {
  it("writes the chain's votes under derived ids, sized as the runtime sizes them", () => {
    const p = plan(
      chain({
        votes: [aChainVote(E1, V1, '-25', 10), aChainVote(E2, V2, 7, 11)]
      }),
      target()
    );
    expect(p.writes.votes.upsert).toEqual([
      {
        id: voteRowId(C, ROW_1, 'p1'),
        entryId: ROW_1,
        voterProfileId: 'p1',
        value: -25,
        creditSpent: 25,
        createdAt: 5_000,
        updatedAt: 5_000
      },
      {
        id: voteRowId(C, ROW_2, 'p2'),
        entryId: ROW_2,
        voterProfileId: 'p2',
        value: 7,
        creditSpent: 7,
        createdAt: 6_000,
        updatedAt: 6_000
      }
    ]);
    expect(p.changes.competition_votes).toEqual({
      insert: 2,
      update: 0,
      delete: 0
    });
  });

  it("changes a vote in place, keeping 6529.io's id and creation time, and leaves an equal one", () => {
    const p = plan(
      chain({
        votes: [aChainVote(E1, V1, 40, 99), aChainVote(E2, V2, 7, 11)]
      }),
      target({
        votes: [
          aVote({ id: 'kept-id', value: 10, createdAt: 3 }),
          aVote({
            id: 'same',
            entryId: ROW_2,
            voterProfileId: 'p2',
            value: 7,
            creditSpent: 7
          })
        ]
      })
    );
    expect(p.writes.votes.upsert).toEqual([
      {
        id: 'kept-id',
        entryId: ROW_1,
        voterProfileId: 'p1',
        value: 40,
        creditSpent: 40,
        createdAt: 3,
        // No block time known for height 99: its row's stamp stays.
        updatedAt: 1
      }
    ]);
  });

  it('deletes rows the chain does not have, but not of unmapped voters or entries off the chain', () => {
    const t = target({
      votes: [
        aVote({ id: 'gone', voterProfileId: 'p1' }),
        aVote({ id: 'zero', voterProfileId: 'p2', value: 0, creditSpent: 0 }),
        aVote({ id: 'maybe-unmapped', voterProfileId: 'p9' }),
        aVote({ id: 'off-chain', entryId: ROW_3, voterProfileId: 'p1' })
      ]
    });
    const mapped = plan(chain({ votes: [] }), t);
    expect(mapped.writes.votes.remove.sort()).toEqual([
      'gone',
      'maybe-unmapped',
      'zero'
    ]);
    expect(mapped.waiting).toMatchObject({ vote_kept_entry_not_on_chain: 1 });

    // A chain voter without a profile: rows of profiles without a principal
    // may be that voter's, so they stay until it is mapped.
    const unmapped = plan(chain({ votes: [aChainVote(E1, V3, 5)] }), t);
    expect(unmapped.writes.votes.remove.sort()).toEqual(['gone', 'zero']);
    expect(unmapped.waiting).toMatchObject({
      vote_voter_unmapped: 1,
      vote_kept_profile_unmapped: 1
    });
  });

  it('keeps the votes on an entry no longer ACTIVE when the chain releases them', () => {
    const p = plan(
      chain({
        entries: [
          aChainEntry({
            entryId: E1,
            decisionId: D,
            legacyId: DROP1,
            status: 'winner'
          }),
          aChainEntry({ entryId: E2, decisionId: D, legacyId: DROP2 })
        ],
        votes: []
      }),
      target({
        votes: [
          aVote({ id: 'winner-vote', entryId: ROW_1 }),
          aVote({ id: 'active-vote', entryId: ROW_2 })
        ]
      })
    );
    expect(p.writes.votes.remove).toEqual(['active-vote']);
  });

  it('keeps the votes the chain released when the decision ended, its entries still active', () => {
    const ended = aChainDecisionState(
      aChainDecision({ decisionId: D, legacyId: C, status: 'ended' }),
      {
        entries: [aChainEntry({ entryId: E1, decisionId: D, legacyId: DROP1 })],
        votes: [],
        board: null
      }
    );
    const p = plan(ended, target({ votes: [aVote({ id: 'released' })] }));
    expect(p.writes.votes.remove).toEqual([]);
  });

  it('waits with a new vote whose block has no known time', () => {
    const p = plan(chain({ votes: [aChainVote(E1, V1, 5, 77)] }), target());
    expect(p.writes.votes.upsert).toEqual([]);
    expect(p.waiting).toMatchObject({ vote_without_time: 1 });
  });

  it('waits for entries 6529.io has no row of, and for amounts that do not fit', () => {
    const p = plan(
      chain({
        entries: [
          aChainEntry({ entryId: E1, decisionId: D, legacyId: DROP1 }),
          aChainEntry({ entryId: E3, decisionId: D, legacyId: null })
        ],
        votes: [aChainVote(E3, V1, 5), aChainVote(E1, V2, '9007199254740993')]
      }),
      target()
    );
    expect(p.writes.votes.upsert).toEqual([]);
    expect(p.waiting).toMatchObject({
      entry_without_row: 1,
      vote_entry_without_row: 1,
      vote_out_of_range: 1
    });
  });
});

describe('mirror plan: entry runtime', () => {
  it("writes each entry's total and last increase, keeping 6529.io's time when the chain has none", () => {
    const p = plan(
      chain({
        entries: [
          aChainEntry({
            entryId: E1,
            decisionId: D,
            legacyId: DROP1,
            total: '30',
            data: { lastIncrease: { time: 4_000, height: 9, index: 0 } }
          }),
          aChainEntry({
            entryId: E2,
            decisionId: D,
            legacyId: DROP2,
            total: '0'
          })
        ]
      }),
      target({
        runtime: [
          {
            entryId: ROW_2,
            realTimeRating: 3,
            lastIncreasedAt: 2_000,
            overThresholdSince: 1_500,
            updatedAt: 1
          }
        ]
      })
    );
    expect(p.writes.runtime.upsert).toEqual([
      {
        entryId: ROW_1,
        realTimeRating: 30,
        lastIncreasedAt: 4_000,
        overThresholdSince: null,
        updatedAt: NOW
      },
      {
        entryId: ROW_2,
        realTimeRating: 0,
        lastIncreasedAt: 2_000,
        overThresholdSince: 1_500,
        updatedAt: NOW
      }
    ]);
    expect(p.changes.competition_entry_runtime).toEqual({
      insert: 1,
      update: 1,
      delete: 0
    });
  });
});

describe('mirror plan: leaderboard', () => {
  const board = [
    aBoardRow(E2, 1, 50, 70, { lastIncrease: { time: 9_000 } }),
    aBoardRow(E1, 2, 20, 30)
  ];

  it("writes the chain's board while the decision is published", () => {
    const p = plan(
      chain({ board }),
      target({
        board: [
          {
            entryId: ROW_3,
            dropId: DROP3,
            rating: 1,
            realTimeRating: 1,
            rank: 3,
            submittedAt: 300,
            updatedAt: 1,
            orderingTime: 300,
            decisionRating: 1,
            overThresholdSince: null,
            publishedAt: null
          },
          {
            entryId: uuid(99),
            dropId: uuid(98),
            rating: 1,
            realTimeRating: 1,
            rank: 1,
            submittedAt: 1,
            updatedAt: 1,
            orderingTime: 1,
            decisionRating: 1,
            overThresholdSince: null,
            publishedAt: 5
          }
        ]
      })
    );
    expect(p.writes.board.upsert).toEqual([
      {
        entryId: ROW_2,
        dropId: DROP2,
        rating: 50,
        realTimeRating: 70,
        rank: 1,
        submittedAt: 200,
        orderingTime: 9_000,
        decisionRating: 50,
        overThresholdSince: null,
        publishedAt: null,
        updatedAt: NOW
      },
      {
        entryId: ROW_1,
        dropId: DROP1,
        rating: 20,
        realTimeRating: 30,
        rank: 2,
        submittedAt: 100,
        orderingTime: 100,
        decisionRating: 20,
        overThresholdSince: null,
        publishedAt: null,
        updatedAt: NOW
      }
    ]);
    // The entry off the board goes; a published row whose entry is gone
    // stays, as the runtime keeps it.
    expect(p.writes.board.remove).toEqual([ROW_3]);
  });

  it('publishes the rows of a time-locked board', () => {
    const p = plan(
      chain({ board }),
      target(
        {},
        aCompetition({ id: C, decisionConfig: { time_lock_ms: 3_600_000 } })
      )
    );
    expect(p.writes.board.upsert.map((r) => r.publishedAt)).toEqual([NOW, NOW]);
  });

  it('keeps the last board once the decision is no longer published', () => {
    const p = plan(chain({ board: null }), target());
    expect(p.writes.board).toEqual({ upsert: [], remove: [] });
  });
});

describe('mirror plan: votes and boards, twice', () => {
  it('writes nothing the second time', () => {
    for (const timeLock of [null, 3_600_000]) {
      const c = chain({
        votes: [aChainVote(E1, V1, 12, 10), aChainVote(E2, V2, -3, 11)],
        board: [aBoardRow(E1, 1, 12, 12), aBoardRow(E2, 2, -3, -3)]
      });
      let t = target(
        {
          votes: [aVote({ id: 'old', entryId: ROW_2, voterProfileId: 'p1' })]
        },
        aCompetition({ id: C, decisionConfig: { time_lock_ms: timeLock } })
      );
      const first = plan(c, t);
      expect(planWrites(first)).toBeGreaterThan(0);
      t = applyWritesInMemory(t, first.writes);
      const second = plan(c, t, { now: NOW + 60_000 });
      expect(second.changes).toEqual({});
      expect(planWrites(second)).toBe(0);
    }
  });
});
