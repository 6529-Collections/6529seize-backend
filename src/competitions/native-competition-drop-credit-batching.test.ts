import { CompetitionCreditService } from './competition-credit.service';
import { CompetitionExecutionRouter } from './competition-execution.router';
import { NativeCompetitionRuntimeRepository } from './native-competition-runtime.repository';
import { NativeCompetitionRuntimeService } from './native-competition-runtime.service';
import { WaveCreditScope, WaveCreditType } from '@/entities/IWave';
import { anIdentity } from '@/tests/fixtures/identity.fixture';

/**
 * DROP-scope credit reconciliation reads budgets and votes in a few paged
 * statements. Against the one-voter-at-a-time reads it replaced, it must make
 * the same writes in the same order.
 */

type Vote = { entryId: string; value: number };

const competition = {
  id: 'competition',
  wave_id: 'wave',
  voting: {
    group_id: null,
    credit_type: WaveCreditType.TDH,
    credit_scope: WaveCreditScope.DROP,
    credit_category: null,
    credit_creditor: null,
    credit_nfts: [],
    signature_required: false,
    starts_at: null,
    ends_at: null,
    max_votes_per_identity_to_entry: null,
    forbid_negative_votes: false
  }
};

/** Voter ids as stored; reads compare them case-insensitively (collation). */
const STORED_VOTES: Record<string, Vote[]> = {
  // Over budget on one entry.
  'voter-a': [
    { entryId: 'e1', value: -120 },
    { entryId: 'e2', value: 80 }
  ],
  // No available credit at all.
  'voter-b': [
    { entryId: 'e1', value: 30 },
    { entryId: 'e2', value: -40 }
  ],
  // Fits.
  'voter-c': [{ entryId: 'e1', value: 9 }]
};
const STORED_IDENTITIES: Record<string, { tdh: number; xtdh: number }> = {
  'voter-a': { tdh: 50, xtdh: 0 },
  'voter-c': { tdh: 100, xtdh: 0 }
};
const REP: Record<string, number> = { 'voter-a': 50, 'voter-c': 100 };
// 'VOTER-B' matches the stored 'voter-b' only under the collation.
const ACTIVE_VOTERS = ['voter-a', 'VOTER-B', 'voter-c'];

function setUp(batched: boolean, activeVoters = ACTIVE_VOTERS) {
  const writes: ['replace' | 'history', Record<string, unknown>][] = [];
  const reads = { perVoterVotes: 0, pagedVotes: 0, identityLookups: 0 };
  const matching = (voter: string) => voter.toLowerCase();
  const db = {
    execute: jest.fn(async (sql: string, params: Record<string, unknown>) => {
      if (sql.includes('v.voter_profile_id in (:voterProfileIds)')) {
        reads.pagedVotes++;
        const wanted = new Set(
          (params.voterProfileIds as string[]).map(matching)
        );
        return Object.entries(STORED_VOTES)
          .filter(([voter]) => wanted.has(voter))
          .flatMap(([voter, votes]) =>
            votes.map((vote) => ({ voterProfileId: voter, ...vote }))
          );
      }
      throw new Error(`Unexpected statement: ${sql}`);
    })
  };
  const repository = new NativeCompetitionRuntimeRepository(() => db as never);
  jest
    .spyOn(repository, 'listActiveVoters')
    .mockResolvedValue([...activeVoters]);
  jest
    .spyOn(repository, 'getVoterActiveVotes')
    .mockImplementation(async (_competition, voter) => {
      reads.perVoterVotes++;
      return (STORED_VOTES[matching(voter)] ?? []).map((vote) => ({
        ...vote
      }));
    });
  jest
    .spyOn(repository, 'replaceVoteForReconciliation')
    .mockImplementation(async (mutation) => {
      writes.push(['replace', { ...mutation }]);
    });
  jest
    .spyOn(repository, 'recordVoteChange')
    .mockImplementation(async (change) => {
      writes.push(['history', { ...change }]);
    });
  if (!batched)
    jest.spyOn(repository, 'getVotersActiveVotes').mockResolvedValue(new Map());

  const identities = {
    getIdentityByProfileId: jest.fn(async (id: string) => {
      reads.identityLookups++;
      const stored = STORED_IDENTITIES[matching(id)];
      return stored ? anIdentity(stored) : null;
    }),
    // Exact keys, as returned rows name them: 'VOTER-B' finds no row.
    getIdentitiesByIds: jest.fn(async (ids: string[]) =>
      ids
        .filter((id) => STORED_IDENTITIES[id])
        .map((profile_id) => ({
          ...anIdentity(STORED_IDENTITIES[profile_id]),
          profile_id
        }))
    ),
    getSingleNftVotingCreditsByProfileId: jest.fn()
  };
  const credits = new CompetitionCreditService(
    {
      getSpending: jest.fn(async () => {
        throw new Error('DROP budgets without an entry read no spending');
      }),
      getNamespaceSpendings: jest.fn()
    },
    identities,
    {
      getRepRating: jest.fn(
        async ({ target_profile_id }) => REP[matching(target_profile_id)] ?? 0
      )
    }
  );
  const service = new NativeCompetitionRuntimeService(
    repository,
    batched
      ? credits
      : {
          getBudget: credits.getBudget.bind(credits),
          getWaveBudgets: credits.getWaveBudgets.bind(credits),
          getDropBudgets: async () => new Map()
        },
    new CompetitionExecutionRouter()
  );
  const reconcile = (credit_type: WaveCreditType) =>
    (
      service as unknown as {
        reconcileCompetitionCredit(
          competition: unknown,
          now: number,
          ctx: unknown
        ): Promise<void>;
      }
    ).reconcileCompetitionCredit(
      { ...competition, voting: { ...competition.voting, credit_type } },
      500,
      { connection: {} }
    );
  return { reconcile, writes, reads, identities };
}

describe('DROP credit reconciliation with batched reads', () => {
  it.each([WaveCreditType.TDH, WaveCreditType.TDH_PLUS_XTDH])(
    'makes the same %s writes in the same order as one voter at a time',
    async (credit_type) => {
      const sequential = setUp(false);
      await sequential.reconcile(credit_type);
      const batched = setUp(true);
      await batched.reconcile(credit_type);

      expect(batched.writes).toEqual(sequential.writes);
      // A reduction (voter-a) and a voter without credit (voter-b) both wrote.
      expect(
        batched.writes
          .filter(([kind]) => kind === 'replace')
          .map(([, mutation]) => [
            mutation.voterProfileId,
            mutation.entryId,
            Number(mutation.value) || 0
          ])
      ).toEqual([
        ['voter-a', 'e1', -50],
        ['voter-a', 'e2', 50],
        ['VOTER-B', 'e1', 0],
        ['VOTER-B', 'e2', 0]
      ]);
      // Sequential: a budget and a votes read per voter. Batched: one page of
      // votes, then the collation mismatch reads that page voter by voter;
      // only 'VOTER-B' needs its own identity read.
      expect(sequential.reads.perVoterVotes).toBe(3);
      expect(sequential.reads.identityLookups).toBe(3);
      expect(batched.reads.pagedVotes).toBe(1);
      expect(batched.reads.perVoterVotes).toBe(3);
      expect(batched.reads.identityLookups).toBe(1);
      expect(batched.identities.getIdentitiesByIds).toHaveBeenCalledTimes(1);
    }
  );

  it('reads budgets and votes in one statement each when no id differs by collation', async () => {
    const voters = ['voter-a', 'voter-b', 'voter-c'];
    const sequential = setUp(false, voters);
    await sequential.reconcile(WaveCreditType.TDH);
    const batched = setUp(true, voters);
    await batched.reconcile(WaveCreditType.TDH);

    expect(batched.writes).toEqual(sequential.writes);
    expect(batched.reads).toEqual({
      perVoterVotes: 0,
      pagedVotes: 1,
      // voter-b has no identity row: like the WAVE batch, a missing row is
      // read once more on its own rather than assumed to be zero.
      identityLookups: 1
    });
    expect(batched.identities.getIdentitiesByIds).toHaveBeenCalledTimes(1);
  });

  it('keeps the single-profile source for REP credit and the same writes', async () => {
    const sequential = setUp(false);
    await sequential.reconcile(WaveCreditType.REP);
    const batched = setUp(true);
    await batched.reconcile(WaveCreditType.REP);

    expect(batched.writes).toEqual(sequential.writes);
    expect(batched.writes.length).toBeGreaterThan(0);
    expect(batched.identities.getIdentitiesByIds).not.toHaveBeenCalled();
  });
});
