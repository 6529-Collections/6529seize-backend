import {
  aChainDecision,
  aChainDecisionState,
  aChainEntry,
  aCompetition,
  anEvent,
  aTargetEntry,
  aTargetState,
  chainId,
  someLookups,
  uuid
} from '@/tests/fixtures/waves-chain-mirror.fixture';
import { VoteEvent } from './waves-chain-mirror.history';
import { planDecision } from './waves-chain-mirror.plan';
import { voteEventOf } from './waves-chain-mirror.service';

const D = chainId('d1');
const C = uuid(1);
const E1 = chainId('e1');
const V1 = chainId('b1');
const V2 = chainId('b2');
const DROP1 = uuid(11);
const ROW_1 = uuid(21);

const vote = (fields: Partial<VoteEvent>): VoteEvent => ({
  height: 50,
  seq: 0,
  blockTime: 5_000,
  origin: 'OPERATION',
  entryId: E1,
  voter: V1,
  oldValue: '0',
  newValue: '10',
  entryTotalAfter: '10',
  ...fields
});

describe('mirror plan: vote history from the event log', () => {
  const chain = aChainDecisionState(
    aChainDecision({ decisionId: D, legacyId: C }),
    {
      entries: [aChainEntry({ entryId: E1, decisionId: D, legacyId: DROP1 })]
    }
  );
  const target = aTargetState(aCompetition({ id: C }), {
    entries: [aTargetEntry({ id: ROW_1, dropId: DROP1, submitterId: 'author' })]
  });

  it("writes each vote change as the runtime's history, with its origin", () => {
    const p = planDecision({
      chain,
      target,
      lookups: someLookups({
        profiles: { [V1]: 'p1' },
        voteEvents: [
          vote({}),
          vote({
            height: 51,
            seq: 2,
            blockTime: 6_000,
            origin: 'SCAN',
            oldValue: '10',
            newValue: '4',
            entryTotalAfter: '4'
          }),
          // A release returns credit; 6529.io keeps the vote: no history.
          vote({ height: 52, origin: 'RELEASE', newValue: '0' }),
          // An unmapped voter: the entry's total point alone. A value that
          // doesn't fit waits.
          vote({ height: 53, voter: V2 }),
          vote({ height: 54, newValue: '9007199254740993' })
        ]
      })
    });
    expect(p.writes.history).toEqual([
      {
        height: 50,
        seq: 0,
        entryRowId: ROW_1,
        dropId: DROP1,
        submitterId: 'author',
        voterProfileId: 'p1',
        value: 10,
        previous: 0,
        aggregate: 10,
        occurredAt: 5_000,
        reason: null
      },
      {
        height: 51,
        seq: 2,
        entryRowId: ROW_1,
        dropId: DROP1,
        submitterId: 'author',
        voterProfileId: 'p1',
        value: 4,
        previous: 10,
        aggregate: 4,
        occurredAt: 6_000,
        reason: 'chain_scan'
      },
      {
        height: 53,
        seq: 0,
        entryRowId: ROW_1,
        dropId: DROP1,
        submitterId: 'author',
        voterProfileId: null,
        value: 10,
        previous: 0,
        aggregate: 10,
        occurredAt: 5_000,
        reason: null
      }
    ]);
    expect(p.waiting).toMatchObject({
      history_voter_unmapped: 1,
      history_out_of_range: 1
    });
  });

  it("reads a VOTE event of the log into the history's terms", () => {
    expect(
      voteEventOf(
        anEvent(70, 3, {
          kind: 'VOTE',
          origin: 'AMBIGUOUS',
          entryId: E1,
          actor: V1,
          data: { oldValue: null, newValue: '0', entryTotalAfter: '7' }
        })
      )
    ).toEqual({
      height: 70,
      seq: 3,
      blockTime: 1_764_000_070_000,
      origin: 'AMBIGUOUS',
      entryId: E1,
      voter: V1,
      oldValue: null,
      newValue: '0',
      entryTotalAfter: '7'
    });
    expect(voteEventOf(anEvent(70, 0, { kind: 'ENTRY_CREATED' }))).toBeNull();
  });
});
