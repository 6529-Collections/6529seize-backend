import { UserGroupsService } from './user-groups.service';
import { ProfileDirectMessagePolicy } from '@/entities/IProfilePreferences';
import { ForbiddenException } from '@/exceptions';
import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { ApiGroupFull } from '@/api/generated/models/ApiGroupFull';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { RequestContext } from '@/request.context';
import { ConnectionWrapper } from '@/sql-executor';
import { DirectMessageRecipientPreference } from '@/profile-preferences/profile-preferences.db';

const creator = {
  id: 'creator-profile',
  handle: 'creator',
  primary_wallet: '0xcreator'
} as unknown as ApiIdentity;
const context: RequestContext = {};

type UserGroupsDbDependency = ConstructorParameters<
  typeof UserGroupsService
>[0];
type AbusivenessDependency = ConstructorParameters<typeof UserGroupsService>[1];
type MetricsDependency = ConstructorParameters<typeof UserGroupsService>[2];
type PreferencesDependency = ConstructorParameters<typeof UserGroupsService>[3];

function createService({
  existingGroup = null,
  recipients = []
}: {
  existingGroup?: Pick<UserGroupEntity, 'id'> | null;
  recipients?: DirectMessageRecipientPreference[];
} = {}) {
  const userGroupsDb = {
    findDirectMessageGroup: jest
      .fn()
      .mockResolvedValue(existingGroup as unknown as UserGroupEntity | null)
  };
  const profilePreferences = {
    getDirectMessageRecipients: jest.fn().mockResolvedValue(recipients),
    getDirectMessageRecipientsForAdmission: jest
      .fn()
      .mockResolvedValue(recipients)
  };
  const service = new UserGroupsService(
    userGroupsDb as unknown as UserGroupsDbDependency,
    {} as AbusivenessDependency,
    {} as MetricsDependency,
    profilePreferences as unknown as PreferencesDependency
  );
  return { service, userGroupsDb, profilePreferences };
}

describe('direct message profile preferences', () => {
  it('returns an existing exact conversation without applying new admission preferences', async () => {
    const existingGroup = { id: 'existing-group' };
    const { service, profilePreferences } = createService({ existingGroup });
    jest
      .spyOn(
        service as unknown as {
          mapForApi: () => Promise<Array<{ id: string }>>;
        },
        'mapForApi'
      )
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

      const result = service.findOrCreateDirectMessageGroup(
        creator,
        ['0xrecipient'],
        context
      );
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);
      await expect(result).rejects.toThrow(expectedMessage);
    }
  );

  it.each([
    [ProfileDirectMessagePolicy.EVERYONE, false],
    [ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW, true]
  ])(
    'creates a new conversation when a recipient policy is %s',
    async (directMessagePolicy, followsCreator) => {
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
      const save = jest
        .spyOn(service, 'save')
        .mockResolvedValue({ id: 'new-group' } as unknown as ApiGroupFull);

      await expect(
        service.findOrCreateDirectMessageGroup(
          creator,
          ['0xrecipient'],
          context
        )
      ).resolves.toEqual({ id: 'new-group' });

      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ is_direct_message: true }),
        creator.id,
        context,
        true,
        expect.any(Function)
      );
    }
  );

  it('rechecks recipient policies inside the group-creation transaction', async () => {
    const allowedRecipient = {
      profile_id: 'recipient-profile',
      primary_address: '0xrecipient',
      handle: 'recipient',
      direct_message_policy: ProfileDirectMessagePolicy.EVERYONE,
      follows_creator: false
    };
    const blockedRecipient = {
      ...allowedRecipient,
      direct_message_policy: ProfileDirectMessagePolicy.NOBODY
    };
    const { service, profilePreferences } = createService({
      recipients: [allowedRecipient]
    });
    profilePreferences.getDirectMessageRecipientsForAdmission.mockResolvedValue(
      [blockedRecipient]
    );
    const transactionConnection: ConnectionWrapper<unknown> = {
      connection: { id: 'transaction' }
    };
    jest
      .spyOn(service, 'save')
      .mockImplementation(
        async (_group, _createdBy, _ctx, _visible, validate) => {
          await validate!(transactionConnection);
          return { id: 'new-group' } as unknown as ApiGroupFull;
        }
      );

    await expect(
      service.findOrCreateDirectMessageGroup(creator, ['0xrecipient'], context)
    ).rejects.toThrow("don't accept new direct messages");

    expect(
      profilePreferences.getDirectMessageRecipientsForAdmission
    ).toHaveBeenCalledWith(['0xrecipient'], creator.id, transactionConnection);
  });

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
