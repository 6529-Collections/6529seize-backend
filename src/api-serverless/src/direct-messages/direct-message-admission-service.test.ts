import { CustomApiCompliantException } from '@/exceptions';
import { ProfileDirectMessagePolicy } from '@/entities/IProfilePreferences';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { DirectMessageRecipientPreference } from '@/profile-preferences/profile-preferences.db';
import {
  DIRECT_MESSAGE_GROUP_MEMBERSHIP_CACHE_TTL_MS,
  DirectMessageAdmissionService
} from './direct-message-admission.service';

const SENDER = 'sender-profile';

function recipient(
  overrides: Partial<DirectMessageRecipientPreference> = {}
): DirectMessageRecipientPreference {
  return {
    profile_id: 'recipient-profile',
    primary_address: '0xrecipient',
    handle: 'recipient',
    direct_message_policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
    direct_message_group_id: 'group-1',
    direct_message_allow_people_i_follow: true,
    follows_creator: false,
    recipient_blocked_creator: false,
    creator_blocked_recipient: false,
    ...overrides
  };
}

function group(overrides: Partial<UserGroupEntity> = {}): UserGroupEntity {
  return {
    id: 'group-1',
    name: 'Meme holders',
    is_private: false,
    is_direct_message: false,
    visible: true,
    ...overrides
  } as UserGroupEntity;
}

function createService({
  groups = [group()],
  eligible = [] as string[],
  recipients = [recipient()]
}: {
  groups?: UserGroupEntity[];
  eligible?: string[];
  recipients?: DirectMessageRecipientPreference[];
} = {}) {
  let now = 1_000_000;
  const deps = {
    preferences: {
      getDirectMessageRecipientsByProfileIds: jest
        .fn()
        .mockResolvedValue(recipients)
    },
    groups: {
      getByIds: jest.fn(async (ids: string[]) =>
        groups.filter((it) => ids.includes(it.id))
      ),
      getGroupsUserIsEligibleForByIds: jest.fn(
        async (_profileId: string | null, ids: readonly string[]) =>
          eligible.filter((id) => ids.includes(id))
      )
    },
    groupNames: jest.fn(async (input: UserGroupEntity[]) =>
      Object.fromEntries(input.map((it) => [it.id, `moderated ${it.name}`]))
    ),
    now: () => now
  };
  const service = new DirectMessageAdmissionService(deps);
  return {
    service,
    deps,
    advance: (ms: number) => {
      now += ms;
    }
  };
}

async function refusalOf(promise: Promise<void>) {
  try {
    await promise;
  } catch (error) {
    return error as CustomApiCompliantException;
  }
  throw new Error('expected a refusal');
}

describe('DirectMessageAdmissionService', () => {
  it('admits a member of the recipient group using the eligibility rules', async () => {
    const { service, deps } = createService({ eligible: ['group-1'] });

    await expect(
      service.canStartDirectMessage(SENDER, 'recipient-profile')
    ).resolves.toEqual({
      allowed: true,
      recipientProfileId: 'recipient-profile'
    });

    expect(deps.groups.getGroupsUserIsEligibleForByIds).toHaveBeenCalledWith(
      SENDER,
      ['group-1'],
      undefined
    );
    expect(deps.groupNames).not.toHaveBeenCalled();
  });

  it('refuses a non-member and names only a public group', async () => {
    const { service } = createService();

    const error = await refusalOf(
      service.assertCanStartDirectMessage(SENDER, ['recipient-profile'])
    );

    expect(error.getStatusCode()).toBe(403);
    expect(error.code).toBe('DM_RECIPIENT_GROUP_MEMBERS_ONLY');
    expect(error.details).toEqual({
      handle: 'recipient',
      group_id: 'group-1',
      group_name: 'moderated Meme holders'
    });
  });

  it('does not reveal a private group', async () => {
    const { service, deps } = createService({
      groups: [group({ is_private: true })]
    });

    const error = await refusalOf(
      service.assertCanStartDirectMessage(SENDER, ['recipient-profile'])
    );

    expect(error.details).toEqual({ handle: 'recipient' });
    expect(deps.groupNames).not.toHaveBeenCalled();
  });

  it('admits a followed non-member unless the follow bypass is off', async () => {
    const followed = recipient({ follows_creator: true });
    const bypassOn = createService({ recipients: [followed] });
    await expect(
      bypassOn.service.canStartDirectMessage(SENDER, 'recipient-profile')
    ).resolves.toMatchObject({ allowed: true });

    const bypassOff = createService({
      recipients: [
        recipient({
          follows_creator: true,
          direct_message_allow_people_i_follow: false
        })
      ]
    });
    await expect(
      bypassOff.service.canStartDirectMessage(SENDER, 'recipient-profile')
    ).resolves.toMatchObject({ allowed: false });
  });

  it.each([
    ['missing', [] as UserGroupEntity[]],
    ['a direct-message group', [group({ is_direct_message: true })]]
  ])(
    'fails closed to people-I-follow when the group is %s',
    async (_name, groups) => {
      const { service, deps } = createService({
        groups,
        eligible: ['group-1']
      });

      const error = await refusalOf(
        service.assertCanStartDirectMessage(SENDER, ['recipient-profile'])
      );

      expect(error.code).toBe('DM_RECIPIENT_PEOPLE_I_FOLLOW_ONLY');
      expect(
        deps.groups.getGroupsUserIsEligibleForByIds
      ).not.toHaveBeenCalled();
    }
  );

  it('skips group work when a block already decides', async () => {
    const { service, deps } = createService({
      recipients: [recipient({ recipient_blocked_creator: true })],
      eligible: ['group-1']
    });

    const error = await refusalOf(
      service.assertCanStartDirectMessage(SENDER, ['recipient-profile'])
    );

    expect(error.code).toBe('DM_RECIPIENT_NOT_ACCEPTING');
    expect(error.details).toEqual({ handle: 'recipient' });
    expect(deps.groups.getByIds).not.toHaveBeenCalled();
  });

  it('refuses unknown recipient ids (fail closed)', async () => {
    const { service } = createService({ recipients: [] });

    await expect(service.evaluate(SENDER, ['ghost-profile'])).resolves.toEqual(
      new Map([
        [
          'ghost-profile',
          expect.objectContaining({ allowed: false, reason: 'NOT_ACCEPTING' })
        ]
      ])
    );
  });

  it('passes the caller transaction and lock through to the facts query', async () => {
    const { service, deps } = createService({ eligible: ['group-1'] });
    const connection = { connection: { id: 'tx' } };

    await service.evaluate(SENDER, ['recipient-profile', 'recipient-profile'], {
      connection,
      lockForUpdate: true
    });

    expect(
      deps.preferences.getDirectMessageRecipientsByProfileIds
    ).toHaveBeenCalledWith(['recipient-profile'], SENDER, connection, true);
    expect(deps.groups.getByIds).toHaveBeenCalledWith(['group-1'], {
      connection
    });
  });

  it('reuses group membership briefly, then re-evaluates', async () => {
    const { service, deps, advance } = createService({ eligible: ['group-1'] });

    await service.canStartDirectMessage(SENDER, 'recipient-profile');
    await service.canStartDirectMessage(SENDER, 'recipient-profile');
    expect(deps.groups.getGroupsUserIsEligibleForByIds).toHaveBeenCalledTimes(
      1
    );

    advance(DIRECT_MESSAGE_GROUP_MEMBERSHIP_CACHE_TTL_MS + 1);
    await service.canStartDirectMessage(SENDER, 'recipient-profile');
    expect(deps.groups.getGroupsUserIsEligibleForByIds).toHaveBeenCalledTimes(
      2
    );
  });

  it('never reuses a cached membership inside a creation transaction', async () => {
    const eligible = ['group-1'];
    const { service, deps } = createService({ eligible });
    const connection = { connection: { id: 'tx' } };

    // A probe outside the transaction caches "member".
    await expect(
      service.canStartDirectMessage(SENDER, 'recipient-profile')
    ).resolves.toMatchObject({ allowed: true });

    // The sender then drops out of the group before the conversation starts.
    eligible.length = 0;
    const error = await refusalOf(
      service.assertRecipientsAdmitted(SENDER, [recipient()], { connection })
    );

    expect(error.code).toBe('DM_RECIPIENT_GROUP_MEMBERS_ONLY');
    expect(deps.groups.getGroupsUserIsEligibleForByIds).toHaveBeenCalledTimes(
      2
    );
  });

  it('keeps the membership cache bounded by evicting the oldest entries', async () => {
    const groups = Array.from({ length: 3 }, (_, index) =>
      group({ id: `group-${index}` })
    );
    const { service, deps } = createService({ groups, eligible: [] });
    const cache = (
      service as unknown as { membershipCache: Map<string, unknown> }
    ).membershipCache;

    for (let index = 0; index < 5_001; index++) {
      await service.evaluateRecipients(`sender-${index}`, [
        recipient({ direct_message_group_id: 'group-0' })
      ]);
    }

    expect(cache.size).toBe(5_000);
    expect(cache.has('sender-0\u0000group-0')).toBe(false);
    expect(cache.has('sender-5000\u0000group-0')).toBe(true);
    expect(deps.groups.getGroupsUserIsEligibleForByIds).toHaveBeenCalledTimes(
      5_001
    );
  });

  it('reports the first refused recipient of a group conversation', async () => {
    const { service } = createService({
      recipients: [
        recipient({
          profile_id: 'open-profile',
          handle: 'open',
          direct_message_policy: ProfileDirectMessagePolicy.EVERYONE
        }),
        recipient({
          profile_id: 'closed-profile',
          handle: 'closed',
          direct_message_policy: ProfileDirectMessagePolicy.NOBODY
        })
      ]
    });

    const error = await refusalOf(
      service.assertCanStartDirectMessage(SENDER, [
        'open-profile',
        'closed-profile'
      ])
    );

    expect(error.code).toBe('DM_RECIPIENT_NOT_ACCEPTING');
    expect(error.details).toEqual({ handle: 'closed' });
  });

  it('reports whether a saved group can back the group policy', async () => {
    const { service } = createService({
      groups: [group(), group({ id: 'dm-group', is_direct_message: true })]
    });

    await expect(service.isGroupUsable('group-1')).resolves.toBe(true);
    await expect(service.isGroupUsable('dm-group')).resolves.toBe(false);
    await expect(service.isGroupUsable('hidden-group')).resolves.toBe(false);
    await expect(service.isGroupUsable(null)).resolves.toBe(false);
  });
});
