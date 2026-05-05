import { DirectMessageWaveDisplayService } from './direct-message-wave-display.service';

function makeProfile(id: string, handle: string, pfp: string | null) {
  return {
    id,
    handle,
    pfp
  };
}

describe('DirectMessageWaveDisplayService', () => {
  it('returns display contributors for direct-message waves', async () => {
    const userGroupsService = {
      getByIds: jest.fn().mockResolvedValue([
        {
          id: 'group-1',
          is_direct_message: true,
          profile_group_id: 'profile-group-1'
        }
      ]),
      findUserGroupsIdentityGroupProfileIds: jest.fn().mockResolvedValue({
        'profile-group-1': ['viewer-1', 'bob-1', 'alice-1']
      })
    };
    const identityFetcher = {
      getOverviewsByIds: jest.fn().mockResolvedValue({
        'viewer-1': makeProfile('viewer-1', 'viewer', 'viewer.png'),
        'bob-1': makeProfile('bob-1', 'bob', null),
        'alice-1': makeProfile('alice-1', 'alice', 'alice.png')
      })
    };
    const service = new DirectMessageWaveDisplayService(
      userGroupsService as any,
      identityFetcher as any
    );

    const result = await service.resolveWaveDisplayByWaveIdForContext({
      waveEntities: [
        {
          id: 'wave-1',
          is_direct_message: true,
          visibility_group_id: 'group-1',
          participation_group_id: 'group-1',
          chat_group_id: 'group-1',
          admin_group_id: 'group-1',
          voting_group_id: null
        }
      ],
      contextProfileId: 'viewer-1'
    });

    expect(result).toEqual({
      'wave-1': {
        name: 'alice, bob',
        picture: null,
        contributors: [
          {
            handle: 'alice',
            pfp: 'alice.png'
          },
          {
            handle: 'bob',
            pfp: null
          },
          {
            handle: 'viewer',
            pfp: 'viewer.png'
          }
        ]
      }
    });
  });
});
