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
import { planDecision, planWrites } from './waves-chain-mirror.plan';
import { TargetCompetitionState } from './waves-chain-mirror.types';

const D = chainId('d1');
const C = uuid(1);
const E = (n: number) => chainId(`e${n}`);
const DROP = (n: number) => uuid(10 + n);
const ROW = (n: number) => uuid(20 + n);
const V1 = chainId('b1');
const NOW = 1_765_000_000_000;

const chain = aChainDecisionState(
  aChainDecision({ decisionId: D, legacyId: C }),
  {
    entries: [
      aChainEntry({
        entryId: E(1),
        decisionId: D,
        legacyId: DROP(1),
        status: 'withdrawn'
      }),
      aChainEntry({
        entryId: E(2),
        decisionId: D,
        legacyId: DROP(2),
        status: 'disqualified'
      }),
      aChainEntry({
        entryId: E(3),
        decisionId: D,
        legacyId: DROP(3),
        status: 'active'
      }),
      aChainEntry({
        entryId: E(4),
        decisionId: D,
        legacyId: DROP(4),
        status: 'withdrawn'
      }),
      aChainEntry({
        entryId: E(5),
        decisionId: D,
        legacyId: DROP(5),
        status: 'withdrawn'
      }),
      // Removed here before: no row, nothing waits.
      aChainEntry({
        entryId: E(6),
        decisionId: D,
        legacyId: DROP(6),
        status: 'withdrawn'
      })
    ],
    // A vote the chain hasn't released yet from the withdrawn entry.
    votes: [aChainVote(E(1), V1, 5)],
    board: [aBoardRow(E(3), 1, 0, 0)]
  }
);

function target(): TargetCompetitionState {
  return aTargetState(aCompetition({ id: C }), {
    entries: [
      aTargetEntry({ id: ROW(1), dropId: DROP(1) }),
      aTargetEntry({ id: ROW(2), dropId: DROP(2) }),
      // 6529.io holds it released, the chain active: left, counted.
      aTargetEntry({
        id: ROW(3),
        dropId: DROP(3),
        status: 'WITHDRAWN',
        withdrawnAt: 7
      }),
      // An anonymous decision kept it as WITHDRAWN when it was removed.
      aTargetEntry({
        id: ROW(4),
        dropId: DROP(4),
        status: 'WITHDRAWN',
        withdrawnAt: 8
      }),
      // A winner here, withdrawn on the chain: left, counted.
      aTargetEntry({ id: ROW(5), dropId: DROP(5), status: 'WINNER' })
    ],
    votes: [
      {
        id: 'vote-on-withdrawn',
        entryId: ROW(1),
        voterProfileId: 'p1',
        value: 5,
        creditSpent: 5,
        createdAt: 1,
        updatedAt: 1
      }
    ],
    board: [ROW(1), ROW(2)].map((entryId, i) => ({
      entryId,
      dropId: DROP(i + 1),
      rating: 1,
      realTimeRating: 1,
      rank: i + 1,
      submittedAt: 1,
      updatedAt: 1,
      orderingTime: 1,
      decisionRating: 1,
      overThresholdSince: null,
      publishedAt: null
    }))
  });
}

const lookups = (now = NOW) => someLookups({ now, profiles: { [V1]: 'p1' } });

describe('mirror plan: entries the chain withdrew or disqualified', () => {
  it("removes them as 6529.io's own delete does, and plans nothing else for them", () => {
    const p = planDecision({ chain, target: target(), lookups: lookups() });
    expect(p.writes.entryRemovals).toEqual([
      { id: ROW(1), dropId: DROP(1), status: 'WITHDRAWN' },
      { id: ROW(2), dropId: DROP(2), status: 'DISQUALIFIED' }
    ]);
    expect(p.changes.competition_entries).toEqual({
      insert: 0,
      update: 0,
      delete: 2
    });
    // The delete takes their votes, board and runtime rows with them.
    expect(p.writes.votes).toEqual({ upsert: [], remove: [] });
    expect(p.writes.board.remove).toEqual([]);
    expect(p.writes.runtime.upsert.map((r) => r.entryId)).toEqual([ROW(3)]);
    expect(p.waiting).toEqual({ entry_status_conflict: 2 });
  });

  it('writes nothing the second time', () => {
    const first = planDecision({ chain, target: target(), lookups: lookups() });
    const after = applyWritesInMemory(target(), first.writes);
    expect(after.entries.map((e) => e.id)).toEqual([ROW(3), ROW(4), ROW(5)]);
    const second = planDecision({
      chain,
      target: after,
      lookups: lookups(NOW + 1)
    });
    expect(planWrites(second)).toBe(0);
  });
});
