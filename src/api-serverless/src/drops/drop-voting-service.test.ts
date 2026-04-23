import { mock } from 'ts-jest-mocker';
import { DropType } from '@/entities/IDrop';
import { WaveType } from '@/entities/IWave';
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
});
