import { UserGroupsService } from './user-groups.service';
import { ProfileDirectMessagePolicy } from '@/entities/IProfilePreferences';
import { ForbiddenException } from '@/exceptions';

const creator = {
  id: 'creator-profile',
  handle: 'creator',
  primary_wallet: '0xcreator'
} as any;
const context = {} as any;

function createService({
  existingGroup = null,
  recipients = []
}: {
  existingGroup?: any;
  recipients?: any[];
} = {}) {
  const userGroupsDb = {
    findDirectMessageGroup: jest.fn().mockResolvedValue(existingGroup)
  };
  const profilePreferences = {
    getDirectMessageRecipients: jest.fn().mockResolvedValue(recipients)
  };
  const service = new UserGroupsService(
    userGroupsDb as any,
    {} as any,
    {} as any,
    profilePreferences as any
  );
  return { service, userGroupsDb, profilePreferences };
}

describe('direct message profile preferences', () => {
  it('returns an existing exact conversation without applying new admission preferences', async () => {
    const existingGroup = { id: 'existing-group' };
    const { service, profilePreferences } = createService({ existingGroup });
    jest
      .spyOn(service as any, 'mapForApi')
      .mockResolvedValue([{ id: 'existing-group' }]);

    await expect(
      service.findOrCreateDirectMessageGroup(creator, ['0xrecipient'], context)
    ).resolves.toEqual({ id: 'existing-group' });

    expect(
      profilePreferences.getDirectMessageRecipients
    ).not.toHaveBeenCalled();
  });

  it.each([
    [
      ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW,
      false,
      'only accept messages from people they follow'
    ],
    [
      ProfileDirectMessagePolicy.NOBODY,
      true,
      "don't accept new direct messages"
    ]
  ])(
    'rejects a new conversation when a recipient policy is %s',
    async (directMessagePolicy, followsCreator, expectedMessage) => {
      const { service } = createService({
        recipients: [
          {
            profile_id: 'recipient-profile',
            primary_address: '0xrecipient',
            handle: 'recipient',
            direct_message_policy: directMessagePolicy,
            follows_creator: followsCreator
          }
        ]
      });

      await expect(
        service.findOrCreateDirectMessageGroup(
          creator,
          ['0xrecipient'],
          context
        )
      ).rejects.toEqual(
        expect.objectContaining<Partial<ForbiddenException>>({
          message: expect.stringContaining(expectedMessage)
        })
      );
    }
  );

  it('applies the admission policy to every recipient of a new group DM', async () => {
    const { service } = createService({
      recipients: [
        {
          profile_id: 'allowed-profile',
          primary_address: '0xallowed',
          handle: 'allowed',
          direct_message_policy: ProfileDirectMessagePolicy.EVERYONE,
          follows_creator: false
        },
        {
          profile_id: 'blocked-profile',
          primary_address: '0xblocked',
          handle: 'blocked',
          direct_message_policy: ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW,
          follows_creator: false
        }
      ]
    });

    await expect(
      service.findOrCreateDirectMessageGroup(
        creator,
        ['0xallowed', '0xblocked'],
        context
      )
    ).rejects.toThrow('@blocked');
  });
});
