import { MEMES_CONTRACT } from '@/constants';
import { mock } from 'ts-jest-mocker';
import { DropType } from '@/entities/IDrop';
import { WaveCreditScope, WaveCreditType, WaveType } from '@/entities/IWave';
import { IdentitiesDb } from '@/identities/identities.db';
import { RatingsDb } from '@/rates/ratings.db';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { UserGroupsService } from '../community-members/user-groups.service';
import { WavesApiDb } from '../waves/waves.api.db';
import { DropVotingDb } from './drop-voting.db';
import { DropVotingService } from './drop-voting.service';

describe('DropVotingService', () => {
  let votingDb: DropVotingDb;
  let identitiesDb: IdentitiesDb;
  let wavesDb: WavesApiDb;
  let ratingsDb: RatingsDb;
  let userGroupsService: UserGroupsService;
  let service: DropVotingService;

  beforeEach(() => {
    votingDb = mock();
    identitiesDb = mock();
    wavesDb = mock();
    ratingsDb = mock();
    userGroupsService = mock();

    service = new DropVotingService(
      votingDb,
      identitiesDb,
      wavesDb,
      ratingsDb,
      userGroupsService
    );

    (
      userGroupsService.getGroupsUserIsEligibleFor as jest.Mock
    ).mockResolvedValue([]);
    (wavesDb.findWavesByIds as jest.Mock).mockResolvedValue([
      aWave(
        {
          type: WaveType.RANK,
          max_votes_per_identity_to_drop: 3
        },
        {
          id: 'wave-1',
          name: 'Wave 1',
          serial_no: 1
        }
      )
    ]);
    (wavesDb.findWaveVotingCreditNftsByWaveIds as jest.Mock).mockResolvedValue(
      {}
    );
    (votingDb.getVotersActiveVoteForDrops as jest.Mock).mockResolvedValue({
      'drop-1': 2
    });
    (votingDb.getVotersTotalLockedCreditInWaves as jest.Mock).mockResolvedValue(
      {
        'wave-1': 2
      }
    );
    (identitiesDb.getIdentityByProfileId as jest.Mock).mockResolvedValue({
      tdh: 10,
      xtdh: 0
    });
  });

  it('clamps voting range by max_votes_per_identity_to_drop', async () => {
    const result = await service.findCreditLeftForVotingForDrops('profile-1', [
      {
        id: 'drop-1',
        wave_id: 'wave-1',
        drop_type: DropType.PARTICIPATORY
      } as any
    ]);

    expect(result).toEqual({
      'drop-1': {
        min: -3,
        current: 2,
        max: 3
      }
    });
  });

  it.each([
    [false, 12, 5],
    [true, 7, 5]
  ])(
    "counts the help bot's credits in an all-category REP wave only before switch-on (on chain: %s)",
    async (onChain, allCategories, creditCategory) => {
      const original = process.env.FEATURE_IDENTITY_ON_CHAIN;
      if (onChain) process.env.FEATURE_IDENTITY_ON_CHAIN = 'true';
      else delete process.env.FEATURE_IDENTITY_ON_CHAIN;
      try {
        const repWave = (id: string, category: string | null) =>
          aWave(
            {
              type: WaveType.RANK,
              max_votes_per_identity_to_drop: null,
              voting_credit_type: WaveCreditType.REP,
              voting_credit_category: category,
              voting_credit_creditor: null
            },
            { id, name: id, serial_no: 1 }
          );
        // Two different restrictions among the REP waves: every REP rating
        // is read, and each wave picks its own in memory.
        (wavesDb.findWavesByIds as jest.Mock).mockResolvedValue([
          repWave('wave-all', null),
          repWave('wave-credits', 'Help6529 Credits'),
          repWave('wave-kind', 'Kind')
        ]);
        (votingDb.getVotersActiveVoteForDrops as jest.Mock).mockResolvedValue({
          'drop-all': 0,
          'drop-credits': 0,
          'drop-kind': 0
        });
        (
          votingDb.getVotersTotalLockedCreditInWaves as jest.Mock
        ).mockResolvedValue({
          'wave-all': 0,
          'wave-credits': 0,
          'wave-kind': 0
        });
        (ratingsDb.getAllProfilesRepRatings as jest.Mock).mockResolvedValue([
          {
            rater_profile_id: 'help-bot',
            matter: 'REP',
            matter_category: 'Help6529 Credits',
            rating: 5
          },
          {
            rater_profile_id: 'someone',
            matter: 'REP',
            matter_category: 'Kind',
            rating: 7
          }
        ]);

        const result = await service.findCreditLeftForVotingForDrops(
          'profile-1',
          [
            {
              id: 'drop-all',
              wave_id: 'wave-all',
              drop_type: DropType.PARTICIPATORY
            } as any,
            {
              id: 'drop-credits',
              wave_id: 'wave-credits',
              drop_type: DropType.PARTICIPATORY
            } as any,
            {
              id: 'drop-kind',
              wave_id: 'wave-kind',
              drop_type: DropType.PARTICIPATORY
            } as any
          ]
        );

        expect(result['drop-all'].max).toBe(allCategories);
        expect(result['drop-credits'].max).toBe(creditCategory);
        expect(result['drop-kind'].max).toBe(7);
        expect(ratingsDb.getAllProfilesRepRatings).toHaveBeenCalledWith(
          'profile-1',
          {},
          undefined
        );
      } finally {
        if (original === undefined)
          delete process.env.FEATURE_IDENTITY_ON_CHAIN;
        else process.env.FEATURE_IDENTITY_ON_CHAIN = original;
      }
    }
  );

  it('uses combined CARD_SET_TDH credit when configured on the wave', async () => {
    (wavesDb.findWavesByIds as jest.Mock).mockResolvedValue([
      aWave(
        {
          type: WaveType.RANK,
          max_votes_per_identity_to_drop: null,
          voting_credit_type: WaveCreditType.CARD_SET_TDH
        },
        {
          id: 'wave-1',
          name: 'Wave 1',
          serial_no: 1
        }
      )
    ]);
    (votingDb.getVotersActiveVoteForDrops as jest.Mock).mockResolvedValue({
      'drop-1': 1
    });
    (votingDb.getVotersTotalLockedCreditInWaves as jest.Mock).mockResolvedValue(
      {
        'wave-1': 1
      }
    );
    (wavesDb.findWaveVotingCreditNftsByWaveIds as jest.Mock).mockResolvedValue({
      'wave-1': [
        {
          contract: MEMES_CONTRACT.toLowerCase(),
          tokenId: 1
        },
        {
          contract: MEMES_CONTRACT.toLowerCase(),
          tokenId: 2
        }
      ]
    });
    (
      identitiesDb.getSingleNftVotingCreditsByProfileId as jest.Mock
    ).mockResolvedValue({
      [`${MEMES_CONTRACT.toLowerCase()}:1`]: 4,
      [`${MEMES_CONTRACT.toLowerCase()}:2`]: 2
    });

    const result = await service.findCreditLeftForVotingForDrops('profile-1', [
      {
        id: 'drop-1',
        wave_id: 'wave-1',
        drop_type: DropType.PARTICIPATORY
      } as any
    ]);

    expect(result).toEqual({
      'drop-1': {
        min: -6,
        current: 1,
        max: 6
      }
    });
    expect(identitiesDb.getIdentityByProfileId).not.toHaveBeenCalled();
  });

  it('uses per-drop credit spent when credit scope is DROP', async () => {
    (wavesDb.findWavesByIds as jest.Mock).mockResolvedValue([
      aWave(
        {
          type: WaveType.RANK,
          max_votes_per_identity_to_drop: null,
          voting_credit_scope: WaveCreditScope.DROP
        },
        {
          id: 'wave-1',
          name: 'Wave 1',
          serial_no: 1
        }
      )
    ]);
    (votingDb.getVotersActiveVoteForDrops as jest.Mock).mockResolvedValue({
      'drop-1': 2
    });
    (votingDb.getVotersTotalLockedCreditInWaves as jest.Mock).mockResolvedValue(
      {
        'wave-1': 9
      }
    );

    const result = await service.findCreditLeftForVotingForDrops('profile-1', [
      {
        id: 'drop-1',
        wave_id: 'wave-1',
        drop_type: DropType.PARTICIPATORY
      } as any
    ]);

    expect(result).toEqual({
      'drop-1': {
        min: -10,
        current: 2,
        max: 10
      }
    });
  });
});
