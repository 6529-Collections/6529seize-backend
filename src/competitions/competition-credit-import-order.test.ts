import type { CompetitionCreditService } from './competition-credit.service';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { WaveCreditScope, WaveCreditType } from '@/entities/IWave';
import { anIdentity } from '@/tests/fixtures/identity.fixture';

const competition: Parameters<CompetitionCreditService['getBudget']>[0] = {
  id: 'competition-a',
  wave_id: 'wave-a',
  voting: {
    group_id: null,
    credit_type: WaveCreditType.REP,
    credit_scope: WaveCreditScope.WAVE,
    credit_category: 'Builder',
    credit_creditor: '00000000-0000-4000-8000-000000000099',
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

describe('CompetitionCreditService singleton import order', () => {
  it.each(['ratings', 'identities'] as const)(
    'calculates REP and TDH budgets when %s initializes first',
    async (firstModule) => {
      await jest.isolateModulesAsync(async () => {
        if (firstModule === 'ratings') await import('@/rates/ratings.db');
        else await import('@/identities/identities.db');
        const { ratingsDb } = await import('@/rates/ratings.db');
        const { identitiesDb } = await import('@/identities/identities.db');
        const { competitionCreditRepository } =
          await import('./competition-credit.repository');
        const { competitionCreditService } =
          await import('./competition-credit.service');
        const rating = jest
          .spyOn(ratingsDb, 'getRepRating')
          .mockResolvedValue(67);
        const identity = jest
          .spyOn(identitiesDb, 'getIdentityByProfileId')
          .mockResolvedValue(anIdentity({ tdh: 100.9, xtdh: 0 }));
        const spending = jest
          .spyOn(competitionCreditRepository, 'getSpending')
          .mockResolvedValue({
            namespace_spent: 50,
            entry_spent: 20,
            current_vote: -20
          });
        const ctx = {};
        try {
          const repBudget = await competitionCreditService.getBudget(
            competition,
            'voter-profile',
            entry,
            ctx
          );
          expect(repBudget).toMatchObject({
            credit_type: WaveCreditType.REP,
            available: 67,
            spent: 50,
            remaining: 17,
            current_vote: -20,
            min_vote: -37,
            max_vote: 37
          });
          expect(rating).toHaveBeenCalledWith(
            {
              target_profile_id: 'voter-profile',
              rater_profile_id: competition.voting.credit_creditor,
              category: 'Builder'
            },
            ctx
          );
          expect(identity).not.toHaveBeenCalled();
          expect(spending).toHaveBeenCalledWith(
            competition,
            'voter-profile',
            entry,
            ctx
          );
          expect(() =>
            competitionCreditService.assertVoteFits(repBudget, 37)
          ).not.toThrow();
          expect(() =>
            competitionCreditService.assertVoteFits(repBudget, 38)
          ).toThrow('Vote exceeds available credit');

          expect(
            await competitionCreditService.getBudget(
              {
                ...competition,
                voting: {
                  ...competition.voting,
                  credit_type: WaveCreditType.TDH
                }
              },
              'voter-profile',
              entry,
              ctx
            )
          ).toMatchObject({
            credit_type: WaveCreditType.TDH,
            available: 100,
            spent: 50,
            remaining: 50,
            min_vote: -70,
            max_vote: 70
          });
          expect(identity).toHaveBeenCalledWith('voter-profile', undefined);
          expect(rating).toHaveBeenCalledTimes(1);
        } finally {
          spending.mockRestore();
          identity.mockRestore();
          rating.mockRestore();
        }
      });
    }
  );
});
