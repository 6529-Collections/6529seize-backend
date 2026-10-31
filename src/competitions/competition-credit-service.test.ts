import * as fc from 'fast-check';
import {
  CompetitionCreditService,
  competitionVoteDelta
} from '@/competitions/competition-credit.service';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { WaveCreditScope, WaveCreditType } from '@/entities/IWave';
import { anIdentity } from '@/tests/fixtures/identity.fixture';

const competition: Parameters<CompetitionCreditService['getBudget']>[0] = {
  id: 'competition-a',
  wave_id: 'wave',
  voting: {
    group_id: null,
    credit_type: WaveCreditType.TDH,
    credit_scope: WaveCreditScope.WAVE,
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
const entry = {
  id: 'entry-a',
  drop_id: 'drop-a',
  status: CompetitionEntryStatus.ACTIVE
};

describe('CompetitionCreditService', () => {
  const repository = {
    getSpending: jest.fn(),
    getNamespaceSpendings: jest.fn()
  };
  const identities = {
    getIdentityByProfileId: jest.fn(),
    getIdentitiesByIds: jest.fn(),
    getSingleNftVotingCreditsByProfileId: jest.fn()
  };
  const ratings = { getRepRating: jest.fn() };
  const service = new CompetitionCreditService(repository, identities, ratings);
  const budget = (
    voting: Partial<typeof competition.voting> = {},
    selectedEntry: typeof entry | undefined = entry
  ) =>
    service.getBudget(
      { ...competition, voting: { ...competition.voting, ...voting } },
      'represented-profile',
      selectedEntry,
      {}
    );

  beforeEach(() => {
    jest.resetAllMocks();
    identities.getIdentityByProfileId.mockResolvedValue(
      anIdentity({ tdh: 100, xtdh: 12.9 })
    );
    repository.getSpending.mockResolvedValue({
      namespace_spent: 50,
      entry_spent: 20,
      current_vote: -20
    });
    ratings.getRepRating.mockResolvedValue(81);
  });

  it('offers replacement votes with competition-isolated remaining credit, including sign changes', async () => {
    const actual = await budget();
    expect(actual).toMatchObject({
      available: 100,
      spent: 50,
      remaining: 50,
      current_vote: -20,
      min_vote: -70,
      max_vote: 70
    });
    expect(() => service.assertVoteFits(actual, 70)).not.toThrow();
    expect(() => service.assertVoteFits(actual, -70)).not.toThrow();
    expect(() => service.assertVoteFits(actual, 71)).toThrow('Vote exceeds');
  });

  it('accepts safe boundary votes and preserves an exact signed change beyond the number range', async () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    identities.getIdentityByProfileId.mockResolvedValue(
      anIdentity({ tdh: maximum })
    );
    repository.getSpending.mockResolvedValue({
      namespace_spent: maximum,
      entry_spent: maximum,
      current_vote: maximum
    });
    const actual = await budget();
    expect(actual.available).toBe(maximum);
    expect(() => service.assertVoteFits(actual, 1 - maximum)).not.toThrow();
    expect(competitionVoteDelta(maximum, 1 - maximum)).toBe(
      '-18014398509481981'
    );
    expect(competitionVoteDelta(1 - maximum, maximum)).toBe(
      '18014398509481981'
    );
    expect(competitionVoteDelta(maximum, maximum)).toBe('0');
  });

  it.each([
    {
      namespace_spent: Number.MAX_SAFE_INTEGER + 1,
      entry_spent: 0,
      current_vote: 0
    },
    { namespace_spent: -1, entry_spent: 0, current_vote: 0 },
    {
      namespace_spent: 0,
      entry_spent: Number.MAX_SAFE_INTEGER + 1,
      current_vote: 0
    },
    { namespace_spent: 1, entry_spent: 2, current_vote: 2 },
    {
      namespace_spent: 0,
      entry_spent: 0,
      current_vote: Number.MIN_SAFE_INTEGER - 1
    }
  ])('fails closed for invalid persisted spending %j', async (spending) => {
    repository.getSpending.mockResolvedValue(spending);
    await expect(budget()).rejects.toThrow('spending is outside');
  });

  it('does not constrain the unused cross-entry sum for independent DROP budgets', async () => {
    repository.getSpending.mockResolvedValue({
      namespace_spent: Number.MAX_SAFE_INTEGER * 2,
      entry_spent: 20,
      current_vote: 20
    });
    expect(await budget({ credit_scope: WaveCreditScope.DROP })).toMatchObject({
      spent: 20,
      remaining: 80
    });
  });

  it('makes each DROP budget independent while declining to invent a shared remaining amount', async () => {
    expect(await budget({ credit_scope: WaveCreditScope.DROP })).toMatchObject({
      available: 100,
      spent: 20,
      remaining: 80,
      min_vote: -100,
      max_vote: 100
    });
    const unscoped = await service.getBudget(
      {
        ...competition,
        voting: { ...competition.voting, credit_scope: WaveCreditScope.DROP }
      },
      'profile',
      undefined,
      {}
    );
    expect(unscoped).toMatchObject({
      available: 100,
      spent: null,
      remaining: null,
      entry_id: null,
      current_vote: null,
      min_vote: null,
      max_vote: null
    });
    expect(() => service.assertVoteFits(unscoped, 1)).toThrow(
      'An entry is required'
    );
  });

  it('reports competition-wide WAVE credit before an entry is selected', async () => {
    expect(
      await service.getBudget(competition, 'profile', undefined, {})
    ).toMatchObject({
      available: 100,
      spent: 50,
      remaining: 50,
      entry_id: null,
      current_vote: null,
      min_vote: null,
      max_vote: null
    });
  });

  it.each([
    WaveCreditType.TDH,
    WaveCreditType.XTDH,
    WaveCreditType.TDH_PLUS_XTDH
  ])(
    'keeps batched %s wave budgets identical to single-profile budgets',
    async (credit_type) => {
      const profiles = ['positive', 'POSITIVE', 'negative', 'missing'];
      const byId = new Map([
        ['positive', anIdentity({ tdh: 100.9, xtdh: 12.9 })],
        ['negative', anIdentity({ tdh: -10, xtdh: -2 })]
      ]);
      const spent = new Map([
        ['positive', 50],
        ['missing', 7],
        ['negative', 0]
      ]);
      identities.getIdentitiesByIds.mockResolvedValue(
        Array.from(byId, ([profile_id, identity]) => ({
          ...identity,
          profile_id
        }))
      );
      repository.getNamespaceSpendings.mockResolvedValue(spent);
      identities.getIdentityByProfileId.mockImplementation(
        async (id) => byId.get(id.toLowerCase()) ?? null
      );
      repository.getSpending.mockImplementation(async (_competition, id) => ({
        namespace_spent: spent.get(id.toLowerCase()) ?? 0,
        entry_spent: 0,
        current_vote: 0
      }));
      const selected = {
        ...competition,
        voting: { ...competition.voting, credit_type }
      };
      const ctx = { connection: { connection: {} } };
      const batched = await service.getWaveBudgets(selected, profiles, ctx);
      expect(repository.getSpending).toHaveBeenCalledTimes(2);
      expect(repository.getSpending).toHaveBeenCalledWith(
        selected,
        'POSITIVE',
        undefined,
        ctx
      );
      expect(repository.getSpending).toHaveBeenCalledWith(
        selected,
        'missing',
        undefined,
        ctx
      );
      for (const profileId of profiles)
        expect(batched.get(profileId)).toEqual(
          await service.getBudget(selected, profileId, undefined, ctx)
        );
      expect(identities.getIdentitiesByIds).toHaveBeenCalledWith(
        profiles,
        ctx.connection
      );
      expect(repository.getNamespaceSpendings).toHaveBeenCalledWith(
        selected,
        profiles,
        ctx
      );
    }
  );

  it('bounds wave budget prefetches to 100 profiles and skips empty pages', async () => {
    const profiles = Array.from(
      { length: 205 },
      (_, index) => `profile-${index}`
    );
    identities.getIdentitiesByIds.mockImplementation(async (ids: string[]) =>
      ids.map((profile_id) => ({
        ...anIdentity({ tdh: 0, xtdh: 0 }),
        profile_id
      }))
    );
    repository.getNamespaceSpendings.mockImplementation(
      async (_competition, ids: string[]) => new Map(ids.map((id) => [id, 0]))
    );
    expect((await service.getWaveBudgets(competition, [], {})).size).toBe(0);
    expect(identities.getIdentitiesByIds).not.toHaveBeenCalled();
    const budgets = await service.getWaveBudgets(competition, profiles, {});
    expect(budgets.size).toBe(205);
    expect(
      identities.getIdentitiesByIds.mock.calls.map(([page]) => page.length)
    ).toEqual([100, 100, 5]);
    expect(repository.getNamespaceSpendings).toHaveBeenCalledTimes(3);
    expect(repository.getSpending).not.toHaveBeenCalled();
    expect(budgets.get('profile-204')).toMatchObject({
      available: 0,
      spent: 0,
      remaining: 0
    });
  });

  it('retains the ordinary REP budget source and rejects DROP bulk scope', async () => {
    const rep = {
      ...competition,
      voting: { ...competition.voting, credit_type: WaveCreditType.REP }
    };
    expect(
      (await service.getWaveBudgets(rep, ['profile'], {})).get('profile')
    ).toEqual(await service.getBudget(rep, 'profile', undefined, {}));
    expect(identities.getIdentitiesByIds).not.toHaveBeenCalled();
    await expect(
      service.getWaveBudgets(
        {
          ...competition,
          voting: { ...competition.voting, credit_scope: WaveCreditScope.DROP }
        },
        ['profile'],
        {}
      )
    ).rejects.toThrow('WAVE credit scope');
  });

  it('enforces the entry cap and negative-vote policy together', async () => {
    const actual = await budget({
      max_votes_per_identity_to_entry: 25,
      forbid_negative_votes: true
    });
    expect(actual).toMatchObject({ min_vote: 0, max_vote: 25 });
    expect(() => service.assertVoteFits(actual, -1)).toThrow('Vote exceeds');
    expect(() => service.assertVoteFits(actual, 26)).toThrow('Vote exceeds');
    expect(() => service.assertVoteFits(actual, 25)).not.toThrow();
  });

  it.each([
    [WaveCreditType.TDH, 100],
    [WaveCreditType.XTDH, 12],
    [WaveCreditType.TDH_PLUS_XTDH, 112]
  ])('derives whole %s credit', async (credit_type, available) => {
    expect((await budget({ credit_type })).available).toBe(available);
  });

  it('passes the represented profile and transaction through all credit reads', async () => {
    const ctx = { connection: { connection: {} } };
    await service.getBudget(competition, 'represented-profile', entry, ctx);
    expect(identities.getIdentityByProfileId).toHaveBeenCalledWith(
      'represented-profile',
      ctx.connection
    );
    expect(repository.getSpending).toHaveBeenCalledWith(
      competition,
      'represented-profile',
      entry,
      ctx
    );
    await service.getBudget(
      {
        ...competition,
        voting: {
          ...competition.voting,
          credit_type: WaveCreditType.REP,
          credit_category: 'art',
          credit_creditor: 'curator'
        }
      },
      'represented-profile',
      entry,
      ctx
    );
    expect(ratings.getRepRating).toHaveBeenCalledWith(
      {
        target_profile_id: 'represented-profile',
        category: 'art',
        rater_profile_id: 'curator'
      },
      ctx
    );
  });

  it('normalizes and deduplicates configured NFT credits without using global TDH', async () => {
    const contract = `0x${'a'.repeat(40)}`;
    identities.getSingleNftVotingCreditsByProfileId.mockResolvedValue({
      [`${contract}:1`]: 30,
      [`${contract}:2`]: 40
    });
    const actual = await budget({
      credit_type: WaveCreditType.CARD_SET_TDH,
      credit_nfts: [
        { contract, token_id: 1 },
        { contract: contract.toUpperCase().replace('0X', '0x'), token_id: 1 },
        { contract, token_id: 2 }
      ]
    });
    expect(actual.available).toBe(70);
    expect(identities.getIdentityByProfileId).not.toHaveBeenCalled();
    expect(
      identities.getSingleNftVotingCreditsByProfileId
    ).toHaveBeenCalledWith(
      'represented-profile',
      [
        { contract, tokenId: 1 },
        { contract, tokenId: 2 }
      ],
      {}
    );
    await expect(
      budget({ credit_type: WaveCreditType.CARD_SET_TDH })
    ).rejects.toThrow('requires valid');
  });

  it('handles absent identity and negative reputation without inventing spendable credit', async () => {
    identities.getIdentityByProfileId.mockResolvedValue(null);
    expect((await budget()).available).toBe(0);
    ratings.getRepRating.mockResolvedValue(-10);
    expect(await budget({ credit_type: WaveCreditType.REP })).toMatchObject({
      available: 0,
      remaining: 0
    });
  });

  it('does not offer stale voting capacity when available credit falls below spending', async () => {
    identities.getIdentityByProfileId.mockResolvedValue(
      anIdentity({ tdh: 40 })
    );
    const actual = await budget();
    expect(actual).toMatchObject({
      available: 40,
      remaining: 0,
      min_vote: -10,
      max_vote: 10
    });
    expect(() => service.assertVoteFits(actual, -11)).toThrow('Vote exceeds');
    expect(() => service.assertVoteFits(actual, 10)).not.toThrow();
    identities.getIdentityByProfileId.mockResolvedValue(
      anIdentity({ tdh: 10 })
    );
    expect(() =>
      service.assertVoteFits({ ...actual, available: 10 }, 0)
    ).toThrow('Vote exceeds');
  });

  it('keeps historical votes fixed for terminal entries', async () => {
    const actual = await service.getBudget(
      competition,
      'profile',
      { ...entry, status: CompetitionEntryStatus.WINNER },
      {}
    );
    expect(actual).toMatchObject({
      current_vote: -20,
      min_vote: -20,
      max_vote: -20
    });
  });

  it.each([NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 1.1])(
    'rejects invalid vote %s',
    async (value) => {
      const actual = await budget();
      expect(() => service.assertVoteFits(actual, value)).toThrow(
        'safe integer'
      );
    }
  );

  it('rejects unsupported policies instead of silently assigning another credit source', async () => {
    await expect(budget({ credit_type: 'CIC' })).rejects.toThrow(
      'Unsupported competition credit type'
    );
    await expect(budget({ credit_scope: 'GLOBAL' })).rejects.toThrow(
      'Unsupported competition credit scope'
    );
    identities.getIdentityByProfileId.mockResolvedValue(
      anIdentity({ tdh: Infinity })
    );
    await expect(budget()).rejects.toThrow('supported integer range');
  });

  it('never allows a capped replacement to spend more than available, for either vote sign', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: -1_000, max: 1_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        async (available, current, otherSpend) => {
          identities.getIdentityByProfileId.mockResolvedValue(
            anIdentity({ tdh: available })
          );
          repository.getSpending.mockResolvedValue({
            namespace_spent: Math.abs(current) + otherSpend,
            entry_spent: Math.abs(current),
            current_vote: current
          });
          const actual = await budget({ max_votes_per_identity_to_entry: 100 });
          if (otherSpend <= available) {
            expect(() =>
              service.assertVoteFits(actual, actual.max_vote!)
            ).not.toThrow();
            expect(otherSpend + actual.max_vote!).toBeLessThanOrEqual(
              available
            );
            expect(actual.max_vote).toBeLessThanOrEqual(100);
          } else {
            expect(() => service.assertVoteFits(actual, 0)).toThrow(
              'Vote exceeds'
            );
          }
        }
      )
    );
  });
});
