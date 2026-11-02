import { E2eeServiceDeps } from '@/api/e2ee/e2ee-context';
import { E2eeDevicesService } from '@/api/e2ee/e2ee-devices.service';
import { E2eeGroupsService } from '@/api/e2ee/e2ee-groups.service';
import { DirectMessageAdmissionService } from '@/api/direct-messages/direct-message-admission.service';
import { ProfileDirectMessagePolicy } from '@/entities/IProfilePreferences';
import { UserGroupEntity } from '@/entities/IUserGroup';
import { E2eeApiException } from '@/e2ee/e2ee-errors';
import { DirectMessageRecipientPreference } from '@/profile-preferences/profile-preferences.db';

const CALLER = 'caller-profile';

function recipient(
  profileId: string,
  overrides: Partial<DirectMessageRecipientPreference> = {}
): DirectMessageRecipientPreference {
  return {
    profile_id: profileId,
    primary_address: `0x${profileId}`,
    handle: profileId,
    direct_message_policy: ProfileDirectMessagePolicy.EVERYONE,
    direct_message_group_id: null,
    direct_message_allow_people_i_follow: true,
    follows_creator: false,
    recipient_blocked_creator: false,
    creator_blocked_recipient: false,
    ...overrides
  };
}

const PEOPLE = {
  member: recipient('member', {
    direct_message_policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
    direct_message_group_id: 'chosen-group'
  }),
  outsider: recipient('outsider', {
    direct_message_policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
    direct_message_group_id: 'other-group'
  }),
  followed: recipient('followed', {
    direct_message_policy: ProfileDirectMessagePolicy.GROUP_MEMBERS,
    direct_message_group_id: 'other-group',
    follows_creator: true
  }),
  blockedMe: recipient('refuser', { recipient_blocked_creator: true }),
  iBlocked: recipient('i-blocked', { creator_blocked_recipient: true }),
  open: recipient('open')
};

type Person = keyof typeof PEOPLE;

function createDeps(activeDevices: Record<string, number> = {}) {
  const getDirectMessageRecipientsByProfileIds = jest.fn(
    async (ids: string[]) =>
      Object.values(PEOPLE).filter((person) => ids.includes(person.profile_id))
  );
  const admission = new DirectMessageAdmissionService({
    preferences: { getDirectMessageRecipientsByProfileIds },
    groups: {
      getByIds: async (ids: string[]) =>
        ['chosen-group', 'other-group']
          .filter((id) => ids.includes(id))
          .map(
            (id) =>
              ({
                id,
                name: id,
                is_private: true,
                is_direct_message: false
              }) as UserGroupEntity
          ),
      // The caller belongs to "chosen-group" only.
      getGroupsUserIsEligibleForByIds: async (_profileId, ids) =>
        ids.filter((id) => id === 'chosen-group')
    },
    groupNames: async () => ({})
  });
  const evaluate = jest.spyOn(admission, 'evaluate');
  const db = {
    hitRateCounters: jest.fn(
      async (keys: Array<{ key: string }>) =>
        new Map(keys.map(({ key }) => [key, 1]))
    ),
    getActiveDeviceCounts: jest.fn(
      async (ids: readonly string[]) =>
        new Map(
          ids
            .filter((id) => (activeDevices[id] ?? 1) > 0)
            .map((id) => [id, activeDevices[id] ?? 1])
        )
    )
  };
  const deps = {
    db,
    now: () => Date.UTC(2026, 9, 31),
    random: () => 1,
    admission
  } as unknown as E2eeServiceDeps;
  return { deps, evaluate, getDirectMessageRecipientsByProfileIds };
}

async function eligibilityOf(
  people: Person[],
  activeDevices: Record<string, number> = {}
) {
  const { deps } = createDeps(activeDevices);
  const response = await new E2eeDevicesService(deps).checkEligibility(CALLER, {
    profile_ids: people.map((person) => PEOPLE[person].profile_id)
  });
  return Object.fromEntries(
    response.results.map((result) => [
      result.profile_id,
      { status: result.status, reason: result.reason ?? null }
    ])
  );
}

describe('E2EE eligibility uses the shared DM admission', () => {
  it('admits a group member and refuses a non-member', async () => {
    expect(await eligibilityOf(['member', 'outsider'])).toEqual({
      member: { status: 'OK', reason: null },
      outsider: { status: 'POLICY', reason: 'DM_RECIPIENT_GROUP_MEMBERS_ONLY' }
    });
  });

  it('admits a non-member the target follows (follow bypass)', async () => {
    expect(await eligibilityOf(['followed'])).toEqual({
      followed: { status: 'OK', reason: null }
    });
  });

  it('reports a target block as POLICY, never BLOCKED', async () => {
    expect(await eligibilityOf(['blockedMe'])).toEqual({
      refuser: { status: 'POLICY', reason: 'DM_RECIPIENT_NOT_ACCEPTING' }
    });
  });

  it('reports BLOCKED for the caller own block', async () => {
    expect(await eligibilityOf(['iBlocked'])).toEqual({
      'i-blocked': { status: 'BLOCKED', reason: 'DM_SENDER_BLOCKED_RECIPIENT' }
    });
  });

  it('keeps the device count for admitted targets', async () => {
    expect(await eligibilityOf(['open'], { open: 0 })).toEqual({
      open: { status: 'NO_DEVICES', reason: null }
    });
  });

  it('makes a target block indistinguishable from a closed inbox', async () => {
    const { deps } = createDeps();
    const response = await new E2eeDevicesService(deps).checkEligibility(
      CALLER,
      { profile_ids: ['refuser'] }
    );
    expect(response.results).toEqual([
      {
        profile_id: 'refuser',
        status: 'POLICY',
        active_devices: 1,
        reason: 'DM_RECIPIENT_NOT_ACCEPTING'
      }
    ]);
    expect(JSON.stringify(response)).not.toMatch(/BLOCKED|SENDER_BLOCKED/);
  });
});

describe('E2EE roster additions use the shared DM admission', () => {
  const connection = { connection: { id: 'roster-tx' } };

  function assertPolicy(deps: E2eeServiceDeps, profileIds: string[]) {
    return (
      new E2eeGroupsService(deps) as unknown as {
        assertPolicyForNewProfiles: (
          caller: string,
          ids: string[],
          conn: unknown
        ) => Promise<void>;
      }
    ).assertPolicyForNewProfiles(CALLER, profileIds, connection);
  }

  async function errorFrom(promise: Promise<void>) {
    try {
      await promise;
    } catch (error) {
      return error as E2eeApiException;
    }
    throw new Error('expected a refusal');
  }

  it('evaluates in the roster transaction with recipient rows locked', async () => {
    const { deps, evaluate, getDirectMessageRecipientsByProfileIds } =
      createDeps();

    await expect(
      assertPolicy(deps, ['member', 'followed', 'open'])
    ).resolves.toBeUndefined();

    expect(evaluate).toHaveBeenCalledWith(
      CALLER,
      ['member', 'followed', 'open'],
      { connection, lockForUpdate: true }
    );
    expect(getDirectMessageRecipientsByProfileIds).toHaveBeenCalledWith(
      ['member', 'followed', 'open'],
      CALLER,
      connection,
      true
    );
  });

  it('refuses a non-member with E2EE_POLICY and the admission reason', async () => {
    const { deps } = createDeps();
    const error = await errorFrom(assertPolicy(deps, ['outsider']));
    expect(error.code).toBe('E2EE_POLICY');
    expect(error.details).toEqual({
      reason: 'DM_RECIPIENT_GROUP_MEMBERS_ONLY'
    });
  });

  it('does not disclose a target block', async () => {
    const { deps } = createDeps();
    const error = await errorFrom(assertPolicy(deps, ['refuser']));
    expect(error.code).toBe('E2EE_POLICY');
    expect(error.details).toEqual({ reason: 'DM_RECIPIENT_NOT_ACCEPTING' });
    expect(error.message).not.toMatch(/block/i);
  });

  it('reports the caller own block as E2EE_BLOCKED', async () => {
    const { deps } = createDeps();
    const error = await errorFrom(assertPolicy(deps, ['i-blocked']));
    expect(error.code).toBe('E2EE_BLOCKED');
    expect(error.message).toContain('You have blocked');
    expect(error.details).toEqual({ reason: 'DM_SENDER_BLOCKED_RECIPIENT' });
  });

  it('skips admission when nobody is new to the roster', async () => {
    const { deps, evaluate } = createDeps();
    await assertPolicy(deps, []);
    expect(evaluate).not.toHaveBeenCalled();
  });
});
