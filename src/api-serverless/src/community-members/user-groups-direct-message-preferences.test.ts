import { UserGroupsService } from './user-groups.service';
import { ProfileDirectMessagePolicy } from '@/entities/IProfilePreferences';
import { CustomApiCompliantException } from '@/exceptions';
import { ApiIdentity } from '@/api/generated/models/ApiIdentity';
import { ApiGroupFull } from '@/api/generated/models/ApiGroupFull';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { RequestContext } from '@/request.context';
import { ConnectionWrapper } from '@/sql-executor';
import { DirectMessageRecipientPreference } from '@/profile-preferences/profile-preferences.db';
import { DirectMessageAdmissionService } from '../direct-messages/direct-message-admission.service';

const creator = {
  id: 'creator-profile',
  handle: 'creator',
  primary_wallet: '0xcreator'
} as unknown as ApiIdentity;
const context: RequestContext = {};
const transactionConnection: ConnectionWrapper<unknown> = {
  connection: { id: 'transaction' }
};

type UserGroupsDbDependency = ConstructorParameters<
  typeof UserGroupsService
>[0];
type AbusivenessDependency = ConstructorParameters<typeof UserGroupsService>[1];
type MetricsDependency = ConstructorParameters<typeof UserGroupsService>[2];
type PreferencesDependency = ConstructorParameters<typeof UserGroupsService>[3];

function recipientRow(
  overrides: Partial<DirectMessageRecipientPreference> = {}
): DirectMessageRecipientPreference {
  return {
    profile_id: 'recipient-profile',
    primary_address: '0xrecipient',
    handle: 'recipient',
    direct_message_policy: ProfileDirectMessagePolicy.EVERYONE,
    direct_message_group_id: null,
    direct_message_allow_people_i_follow: true,
    follows_creator: false,
    recipient_blocked_creator: false,
    creator_blocked_recipient: false,
    ...overrides
  };
}

function groupPolicyRecipient(
  overrides: Partial<DirectMessageRecipientPreference> = {}
): DirectMessageRecipientPreference {
  return recipientRow({
    direct_message_policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
    direct_message_group_id: 'chosen-group',
    ...overrides
  });
}

function createService({
  existingGroup = null,
  recipients = [],
  visibleGroups = [],
  eligibleGroupIds = []
}: {
  existingGroup?: Pick<UserGroupEntity, 'id'> | null;
  recipients?: DirectMessageRecipientPreference[];
  visibleGroups?: Array<Partial<UserGroupEntity> & { id: string }>;
  eligibleGroupIds?: string[];
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
  const groupDirectory = {
    getByIds: jest.fn(async (ids: string[]) =>
      visibleGroups
        .filter((group) => ids.includes(group.id))
        .map(
          (group) =>
            ({
              is_private: false,
              is_direct_message: false,
              name: group.id,
              ...group
            }) as UserGroupEntity
        )
    ),
    getGroupsUserIsEligibleForByIds: jest.fn(
      async (_profileId: string | null, ids: readonly string[]) =>
        eligibleGroupIds.filter((id) => ids.includes(id))
    )
  };
  const admission = new DirectMessageAdmissionService({
    preferences: { getDirectMessageRecipientsByProfileIds: jest.fn() },
    groups: groupDirectory,
    groupNames: async (groups) =>
      Object.fromEntries(groups.map((group) => [group.id, group.name]))
  });
  const service = new UserGroupsService(
    userGroupsDb as unknown as UserGroupsDbDependency,
    {} as AbusivenessDependency,
    {} as MetricsDependency,
    profilePreferences as unknown as PreferencesDependency,
    admission
  );
  return { service, userGroupsDb, profilePreferences, groupDirectory };
}

function mockTransactionalSave(
  service: UserGroupsService,
  onPreparedName?: (preparedName: string) => void
) {
  return jest
    .spyOn(service, 'save')
    .mockImplementation(
      async (_group, _createdBy, _ctx, _visible, prepareName) => {
        const preparedName = await prepareName!(transactionConnection);
        onPreparedName?.(preparedName);
        return { id: 'new-group' } as unknown as ApiGroupFull;
      }
    );
}

function mockExistingConversation(service: UserGroupsService) {
  jest
    .spyOn(
      service as unknown as {
        mapForApi: () => Promise<Array<{ id: string }>>;
      },
      'mapForApi'
    )
    .mockResolvedValue([{ id: 'existing-group' }]);
}

async function expectRefusal(
  result: Promise<unknown>,
  code: string,
  expectedMessage?: string
): Promise<CustomApiCompliantException> {
  const error = await result.then(
    () => {
      throw new Error('expected the conversation to be refused');
    },
    (err: unknown) => err as CustomApiCompliantException
  );
  expect(error).toBeInstanceOf(CustomApiCompliantException);
  expect(error.getStatusCode()).toBe(403);
  expect(error.code).toBe(code);
  if (expectedMessage) {
    expect(error.message).toContain(expectedMessage);
  }
  return error;
}

function startConversation(
  service: UserGroupsService,
  addresses: string[] = ['0xrecipient']
) {
  return service.findOrCreateDirectMessageGroup(creator, addresses, context);
}

describe('direct message profile preferences', () => {
  it('returns an existing exact conversation without applying new admission preferences', async () => {
    const { service, profilePreferences } = createService({
      existingGroup: { id: 'existing-group' }
    });
    mockExistingConversation(service);

    await expect(startConversation(service)).resolves.toEqual({
      id: 'existing-group'
    });

    expect(
      profilePreferences.getDirectMessageRecipients
    ).not.toHaveBeenCalled();
  });

  it('keeps an existing conversation available after a block', async () => {
    const { service, profilePreferences } = createService({
      existingGroup: { id: 'existing-group' },
      recipients: [recipientRow({ recipient_blocked_creator: true })]
    });
    mockExistingConversation(service);

    await expect(startConversation(service)).resolves.toEqual({
      id: 'existing-group'
    });
    expect(
      profilePreferences.getDirectMessageRecipientsForAdmission
    ).not.toHaveBeenCalled();
  });

  it.each([
    [
      ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW,
      false,
      'DM_RECIPIENT_PEOPLE_I_FOLLOW_ONLY',
      'only accept messages from people they follow'
    ],
    [
      ProfileDirectMessagePolicy.NOBODY,
      true,
      'DM_RECIPIENT_NOT_ACCEPTING',
      "don't accept new direct messages"
    ]
  ])(
    'rejects a new conversation when a recipient policy is %s',
    async (directMessagePolicy, followsCreator, code, expectedMessage) => {
      const { service } = createService({
        recipients: [
          recipientRow({
            direct_message_policy: directMessagePolicy,
            follows_creator: followsCreator
          })
        ]
      });
      mockTransactionalSave(service);

      await expectRefusal(startConversation(service), code, expectedMessage);
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
          recipientRow({
            direct_message_policy: directMessagePolicy,
            follows_creator: followsCreator
          })
        ]
      });
      const save = jest
        .spyOn(service, 'save')
        .mockResolvedValue({ id: 'new-group' } as unknown as ApiGroupFull);

      await expect(startConversation(service)).resolves.toEqual({
        id: 'new-group'
      });

      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({ is_direct_message: true }),
        creator.id,
        context,
        true,
        expect.any(Function)
      );
    }
  );

  it('admits a member of the group the recipient chose', async () => {
    const { service, groupDirectory } = createService({
      recipients: [groupPolicyRecipient()],
      visibleGroups: [{ id: 'chosen-group' }],
      eligibleGroupIds: ['chosen-group']
    });
    mockTransactionalSave(service);

    await expect(startConversation(service)).resolves.toEqual({
      id: 'new-group'
    });
    expect(groupDirectory.getGroupsUserIsEligibleForByIds).toHaveBeenCalledWith(
      creator.id,
      ['chosen-group'],
      undefined
    );
  });

  it('refuses a non-member without naming a private group', async () => {
    const { service } = createService({
      recipients: [groupPolicyRecipient()],
      visibleGroups: [{ id: 'chosen-group', is_private: true }]
    });
    mockTransactionalSave(service);

    const error = await expectRefusal(
      startConversation(service),
      'DM_RECIPIENT_GROUP_MEMBERS_ONLY',
      'members of a group they chose'
    );
    expect(error.details).toEqual({ handle: 'recipient' });
  });

  it('names a public group to a non-member', async () => {
    const { service } = createService({
      recipients: [groupPolicyRecipient()],
      visibleGroups: [{ id: 'chosen-group', name: 'Meme holders' }]
    });
    mockTransactionalSave(service);

    const error = await expectRefusal(
      startConversation(service),
      'DM_RECIPIENT_GROUP_MEMBERS_ONLY'
    );
    expect(error.details).toEqual({
      handle: 'recipient',
      group_id: 'chosen-group',
      group_name: 'Meme holders'
    });
  });

  it('admits a non-member the recipient follows when the bypass is on', async () => {
    const { service } = createService({
      recipients: [groupPolicyRecipient({ follows_creator: true })],
      visibleGroups: [{ id: 'chosen-group' }]
    });
    mockTransactionalSave(service);

    await expect(startConversation(service)).resolves.toEqual({
      id: 'new-group'
    });
  });

  it('refuses a followed non-member when the bypass is off', async () => {
    const { service } = createService({
      recipients: [
        groupPolicyRecipient({
          follows_creator: true,
          direct_message_allow_people_i_follow: false
        })
      ],
      visibleGroups: [{ id: 'chosen-group' }]
    });
    mockTransactionalSave(service);

    await expectRefusal(
      startConversation(service),
      'DM_RECIPIENT_GROUP_MEMBERS_ONLY'
    );
  });

  it('fails closed to people-I-follow when the chosen group is gone', async () => {
    const { service } = createService({
      recipients: [groupPolicyRecipient()],
      eligibleGroupIds: ['chosen-group']
    });
    mockTransactionalSave(service);

    await expectRefusal(
      startConversation(service),
      'DM_RECIPIENT_PEOPLE_I_FOLLOW_ONLY',
      'only accept messages from people they follow'
    );
  });

  it.each([
    ProfileDirectMessagePolicy.EVERYONE,
    ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW,
    ProfileDirectMessagePolicy.GROUP_MEMBERS
  ])(
    'never lets a profile the recipient blocked start a DM under %s',
    async (directMessagePolicy) => {
      const { service } = createService({
        recipients: [
          groupPolicyRecipient({
            direct_message_policy: directMessagePolicy,
            follows_creator: true,
            recipient_blocked_creator: true
          })
        ],
        visibleGroups: [{ id: 'chosen-group' }],
        eligibleGroupIds: ['chosen-group']
      });
      mockTransactionalSave(service);

      const error = await expectRefusal(
        startConversation(service),
        'DM_RECIPIENT_NOT_ACCEPTING',
        "don't accept new direct messages"
      );
      expect(error.message).not.toMatch(/block/i);
      expect(error.details).toEqual({ handle: 'recipient' });
    }
  );

  it('tells the creator when they blocked the recipient', async () => {
    const { service } = createService({
      recipients: [recipientRow({ creator_blocked_recipient: true })]
    });
    mockTransactionalSave(service);

    await expectRefusal(
      startConversation(service),
      'DM_SENDER_BLOCKED_RECIPIENT',
      'you have blocked them'
    );
  });

  it('rechecks recipient policies inside the group-creation transaction', async () => {
    const allowedRecipient = recipientRow();
    const blockedRecipient = recipientRow({
      direct_message_policy: ProfileDirectMessagePolicy.NOBODY
    });
    const { service, profilePreferences } = createService({
      recipients: [allowedRecipient]
    });
    profilePreferences.getDirectMessageRecipientsForAdmission.mockResolvedValue(
      [blockedRecipient]
    );
    mockTransactionalSave(service);

    await expect(startConversation(service)).rejects.toThrow(
      "don't accept new direct messages"
    );

    expect(
      profilePreferences.getDirectMessageRecipientsForAdmission
    ).toHaveBeenCalledWith(['0xrecipient'], creator.id, transactionConnection);
  });

  it('rejects addresses without a recipient profile', async () => {
    const { service } = createService({ recipients: [] });
    mockTransactionalSave(service);

    await expect(startConversation(service)).rejects.toThrow(
      'Invalid identity addresses.'
    );
  });

  it('builds the group name from recipients locked for admission', async () => {
    const { service, profilePreferences } = createService({
      recipients: [recipientRow({ handle: 'locked-recipient' })]
    });
    let preparedName: string | undefined;
    mockTransactionalSave(service, (name) => {
      preparedName = name;
    });

    await startConversation(service);

    expect(preparedName).toBe('DM - creator / locked-recipient');
    expect(
      profilePreferences.getDirectMessageRecipients
    ).not.toHaveBeenCalled();
  });

  it('applies the admission policy to every recipient of a new group DM', async () => {
    const { service } = createService({
      recipients: [
        recipientRow({
          profile_id: 'allowed-profile',
          primary_address: '0xallowed',
          handle: 'allowed'
        }),
        recipientRow({
          profile_id: 'blocked-profile',
          primary_address: '0xblocked',
          handle: 'blocked',
          direct_message_policy: ProfileDirectMessagePolicy.PEOPLE_I_FOLLOW
        })
      ]
    });
    mockTransactionalSave(service);

    await expect(
      startConversation(service, ['0xallowed', '0xblocked'])
    ).rejects.toThrow('@blocked');
  });
});
