import { AuthenticationContext } from '@/auth-context';
import { ActivityEventTargetType } from '@/entities/IActivityEvent';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { NotFoundException } from '@/exceptions';
import { IdentitySubscriptionsApiService } from './identity-subscriptions.api.service';

const MEMBER = 'member-profile';
const PROXY = 'proxy-profile';

function proxyContext(actions: ProfileProxyActionType[]) {
  return new AuthenticationContext({
    authenticatedWallet: '0xproxy',
    authenticatedProfileId: PROXY,
    roleProfileId: MEMBER,
    activeProxyActions: actions.map((type, index) => ({
      id: `action-${index}`,
      type,
      credit_amount: null,
      credit_spent: null
    }))
  });
}

function createService({
  waves = {},
  drops = {},
  hiddenDropIds = []
}: {
  waves?: Record<string, Record<string, unknown>>;
  drops?: Record<string, Record<string, unknown>>;
  hiddenDropIds?: string[];
} = {}) {
  const identitySubscriptionsDb = {
    findSubscriberIdsAndActionsForTarget: jest
      .fn()
      .mockResolvedValue({ 'subscriber-1': ['DROP_CREATED'] }),
    countDistinctSubscriberIdsForTarget: jest.fn().mockResolvedValue(1),
    findTargetIdsAndActionsForTarget: jest.fn().mockResolvedValue({}),
    countTargetIdsAndActionsForTarget: jest.fn().mockResolvedValue(0)
  };
  const identityFetcher = {
    getOverviewsByIds: jest
      .fn()
      .mockResolvedValue({ 'subscriber-1': { id: 'subscriber-1', level: 1 } })
  };
  const userGroupsService = {
    getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue(['private-group'])
  };
  const wavesApiDb = {
    findWaveById: jest.fn(async (id: string) => waves[id] ?? null)
  };
  const dropsDb = {
    findDropById: jest.fn(async (id: string) => drops[id] ?? null)
  };
  const competitionAnonymity = {
    hiddenDropIds: jest.fn().mockResolvedValue(new Set(hiddenDropIds))
  };
  const service = new IdentitySubscriptionsApiService(
    identitySubscriptionsDb as any,
    { findWavesByIdsOrThrow: jest.fn().mockResolvedValue({}) } as any,
    { findDropsByIdsOrThrow: jest.fn().mockResolvedValue({}) } as any,
    identityFetcher as any,
    userGroupsService as any,
    wavesApiDb as any,
    dropsDb as any,
    competitionAnonymity as any
  );
  return {
    service,
    identitySubscriptionsDb,
    userGroupsService,
    competitionAnonymity
  };
}

const publicWave = { id: 'public-wave', visibility_group_id: null };
const privateWave = {
  id: 'private-wave',
  visibility_group_id: 'private-group'
};

function incoming(targetType: ActivityEventTargetType, targetId: string) {
  return {
    target_type: targetType,
    target_id: targetId,
    page: 1,
    page_size: 10
  };
}

describe('IdentitySubscriptionsApiService.findOutgoingSubscriptionsOfType', () => {
  const params = {
    target_type: ActivityEventTargetType.WAVE,
    subscriber_id: MEMBER,
    page: 1,
    page_size: 10
  };

  it('uses the member eligibility for a direct session', async () => {
    const { service, identitySubscriptionsDb } = createService();

    await service.findOutgoingSubscriptionsOfType(
      params,
      AuthenticationContext.fromProfileId(MEMBER)
    );

    expect(
      identitySubscriptionsDb.findTargetIdsAndActionsForTarget
    ).toHaveBeenCalledWith(params, ['private-group']);
  });

  it('gives a proxy without READ_WAVE no private eligibility', async () => {
    const { service, identitySubscriptionsDb, userGroupsService } =
      createService();

    await service.findOutgoingSubscriptionsOfType(
      params,
      proxyContext([ProfileProxyActionType.CREATE_WAVE])
    );

    expect(userGroupsService.getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
    expect(
      identitySubscriptionsDb.findTargetIdsAndActionsForTarget
    ).toHaveBeenCalledWith(params, []);
    expect(
      identitySubscriptionsDb.countTargetIdsAndActionsForTarget
    ).toHaveBeenCalledWith(params, []);
  });

  it('keeps grantor eligibility for a proxy with READ_WAVE', async () => {
    const { service, identitySubscriptionsDb } = createService();

    await service.findOutgoingSubscriptionsOfType(
      params,
      proxyContext([ProfileProxyActionType.READ_WAVE])
    );

    expect(
      identitySubscriptionsDb.findTargetIdsAndActionsForTarget
    ).toHaveBeenCalledWith(params, ['private-group']);
  });
});

describe('IdentitySubscriptionsApiService.findIncomingSubscriptionsOfType', () => {
  it('lists identity followers without wave checks', async () => {
    const { service, identitySubscriptionsDb, userGroupsService } =
      createService();

    const page = await service.findIncomingSubscriptionsOfType(
      incoming(ActivityEventTargetType.IDENTITY, 'profile-x'),
      { authenticationContext: AuthenticationContext.notAuthenticated() }
    );

    expect(page.count).toBe(1);
    expect(userGroupsService.getGroupsUserIsEligibleFor).not.toHaveBeenCalled();
    expect(
      identitySubscriptionsDb.findSubscriberIdsAndActionsForTarget
    ).toHaveBeenCalledWith(expect.anything(), null);
  });

  it('lists followers of a public wave for anonymous viewers', async () => {
    const { service } = createService({
      waves: { 'public-wave': publicWave }
    });

    await expect(
      service.findIncomingSubscriptionsOfType(
        incoming(ActivityEventTargetType.WAVE, 'public-wave'),
        { authenticationContext: AuthenticationContext.notAuthenticated() }
      )
    ).resolves.toMatchObject({ count: 1 });
  });

  it.each([
    ['an anonymous viewer', AuthenticationContext.notAuthenticated()],
    ['a proxy without READ_WAVE', proxyContext([])]
  ])(
    'returns not found for a private wave to %s',
    async (_label, authenticationContext) => {
      const { service, identitySubscriptionsDb } = createService({
        waves: { 'private-wave': privateWave }
      });

      await expect(
        service.findIncomingSubscriptionsOfType(
          incoming(ActivityEventTargetType.WAVE, 'private-wave'),
          { authenticationContext }
        )
      ).rejects.toThrow(new NotFoundException('WAVE private-wave not found'));
      expect(
        identitySubscriptionsDb.findSubscriberIdsAndActionsForTarget
      ).not.toHaveBeenCalled();
    }
  );

  it('lists followers of a private wave for a member', async () => {
    const { service } = createService({
      waves: { 'private-wave': privateWave }
    });

    await expect(
      service.findIncomingSubscriptionsOfType(
        incoming(ActivityEventTargetType.WAVE, 'private-wave'),
        { authenticationContext: AuthenticationContext.fromProfileId(MEMBER) }
      )
    ).resolves.toMatchObject({ count: 1 });
  });

  it.each([
    ['a missing drop', {}],
    [
      'a drop in a private wave',
      { 'drop-1': { id: 'drop-1', wave_id: 'private-wave', author_id: 'a' } }
    ]
  ])('returns the same not-found response for %s', async (_label, drops) => {
    const { service } = createService({
      waves: { 'private-wave': privateWave },
      drops
    });

    await expect(
      service.findIncomingSubscriptionsOfType(
        incoming(ActivityEventTargetType.DROP, 'drop-1'),
        { authenticationContext: AuthenticationContext.notAuthenticated() }
      )
    ).rejects.toThrow(new NotFoundException('DROP drop-1 not found'));
  });

  it('leaves the author out of subscribers of an anonymous competition entry', async () => {
    const { service, identitySubscriptionsDb } = createService({
      waves: { 'public-wave': publicWave },
      drops: {
        'drop-1': {
          id: 'drop-1',
          wave_id: 'public-wave',
          author_id: 'author-1'
        }
      },
      hiddenDropIds: ['drop-1']
    });

    await service.findIncomingSubscriptionsOfType(
      incoming(ActivityEventTargetType.DROP, 'drop-1'),
      { authenticationContext: AuthenticationContext.notAuthenticated() }
    );

    expect(
      identitySubscriptionsDb.findSubscriberIdsAndActionsForTarget
    ).toHaveBeenCalledWith(expect.anything(), 'author-1');
    expect(
      identitySubscriptionsDb.countDistinctSubscriberIdsForTarget
    ).toHaveBeenCalledWith(expect.anything(), 'author-1');
  });

  it('keeps all subscribers of a drop that is not anonymous', async () => {
    const { service, identitySubscriptionsDb } = createService({
      waves: { 'public-wave': publicWave },
      drops: {
        'drop-1': {
          id: 'drop-1',
          wave_id: 'public-wave',
          author_id: 'author-1'
        }
      }
    });

    await service.findIncomingSubscriptionsOfType(
      incoming(ActivityEventTargetType.DROP, 'drop-1'),
      { authenticationContext: AuthenticationContext.notAuthenticated() }
    );

    expect(
      identitySubscriptionsDb.findSubscriberIdsAndActionsForTarget
    ).toHaveBeenCalledWith(expect.anything(), null);
  });
});
