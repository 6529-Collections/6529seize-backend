jest.mock('@/competitions/legacy-competition-mutation', () => ({
  withLegacyPrimaryMutation: jest.fn(
    (_wave: string, _ctx: unknown, action: (owner: null) => unknown) =>
      action(null)
  ),
  readLegacyMutationSource: (action: () => unknown) => action()
}));
jest.mock('@/competitions/competition-entry-drop-hooks');
jest.mock('@/ethereum-rpc/ethereum-rpc-client', () => ({
  getEthereumRpcClient: jest.fn(() => ({ resolveName: jest.fn() }))
}));

import { AuthenticationContext } from '@/auth-context';
import { DropType } from '@/entities/IDrop';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { identityFetcher } from '@/api/identities/identity.fetcher';
import { CreateOrUpdateDropUseCase } from './create-or-update-drop.use-case';

const GRANTOR = 'grantor-profile';
const GRANTEE = 'grantee-profile';

function grant(wave_allowlist: string[] | null) {
  return {
    id: 'action-1',
    proxy_id: 'proxy-1',
    action_type: 'CREATE_DROP_TO_WAVE',
    credit_amount: null,
    credit_spent: null,
    created_at: 1,
    start_time: 1,
    end_time: null,
    accepted_at: 2,
    rejected_at: null,
    revoked_at: null,
    is_active: true,
    wave_allowlist
  };
}

function chatDropModel(overrides: Record<string, unknown> = {}) {
  return {
    drop_id: null,
    wave_id: 'wave-1',
    reply_to: null,
    title: null,
    drop_type: DropType.CHAT,
    author_identity: GRANTOR,
    author_id: GRANTOR,
    proxy_identity: GRANTEE,
    proxy_id: GRANTEE,
    parts: [{ content: 'hello', quoted_drop: null, media: [] }],
    referenced_nfts: [],
    mentioned_users: [],
    mentioned_waves: [],
    metadata: [],
    mentioned_groups: [],
    signature: null,
    is_additional_action_promised: null,
    ...overrides
  } as any;
}

function createUseCase(overrides: {
  proxyService?: any;
  dropsDb?: any;
  wavesApiDb?: any;
  userGroupsService?: any;
  identitySubscriptionsDb?: any;
  userNotifier?: any;
}) {
  return new CreateOrUpdateDropUseCase(
    overrides.dropsDb ?? ({} as any),
    {} as any,
    overrides.userGroupsService ?? ({} as any),
    overrides.wavesApiDb ?? ({} as any),
    overrides.userNotifier ?? ({} as any),
    {} as any,
    overrides.identitySubscriptionsDb ?? ({} as any),
    overrides.proxyService ?? ({} as any),
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {
      evaluate: jest.fn().mockResolvedValue(undefined),
      assertPostingAllowed: jest.fn().mockResolvedValue(undefined)
    },
    { filterBlockedNotificationRows: jest.fn(async (rows) => rows) }
  );
}

describe('CreateOrUpdateDropUseCase proxy wave allowlist (defence in depth)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function executeWith(
    activeGrant: ReturnType<typeof grant> | null,
    model = chatDropModel()
  ) {
    const proxyService = {
      findActiveProxyAction: jest.fn().mockResolvedValue(activeGrant)
    };
    const useCase = createUseCase({ proxyService });
    const write = jest
      .spyOn(useCase as any, 'createOrUpdateDrop')
      .mockResolvedValue({
        drop_id: 'new-drop',
        pending_push_notification_ids: [],
        dm_unread_recipient_ids: []
      });
    const result = useCase.execute(model, false, {
      connection: {} as any,
      prePublication: { trustedSystem: true }
    });
    return { result, write, proxyService };
  }

  it('writes when the grant covers the wave', async () => {
    const { result, write, proxyService } = executeWith(grant(['wave-1']));
    await expect(result).resolves.toEqual(
      expect.objectContaining({ drop_id: 'new-drop' })
    );
    expect(proxyService.findActiveProxyAction).toHaveBeenCalledWith({
      granted_by_profile_id: GRANTOR,
      granted_to_profile_id: GRANTEE,
      action: ProfileProxyActionType.CREATE_DROP_TO_WAVE
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('refuses a wave outside the allowlist even when the caller skipped the route check', async () => {
    const { result, write } = executeWith(
      grant(['wave-1']),
      chatDropModel({ wave_id: 'wave-2' })
    );
    await expect(result).rejects.toThrow(ForbiddenException);
    await expect(result).rejects.toThrow(
      'Proxy is not allowed to create drops in this wave'
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('refuses a reply into an unlisted wave before the reply target is examined', async () => {
    const { result, write } = executeWith(
      grant(['wave-1']),
      chatDropModel({
        wave_id: 'wave-2',
        reply_to: { drop_id: 'drop-in-wave-2', drop_part_id: 1 }
      })
    );
    await expect(result).rejects.toThrow(ForbiddenException);
    expect(write).not.toHaveBeenCalled();
  });

  it('keeps a legacy (null) grant unrestricted', async () => {
    const { result, write } = executeWith(
      grant(null),
      chatDropModel({ wave_id: 'wave-2' })
    );
    await expect(result).resolves.toEqual(
      expect.objectContaining({ drop_id: 'new-drop' })
    );
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('keeps the legacy error when the proxy has no active grant at all (revoked or expired)', async () => {
    const { result, write } = executeWith(null);
    await expect(result).rejects.toThrow(BadRequestException);
    await expect(result).rejects.toThrow(
      `Identity ${GRANTOR} hasn't allowed identity ${GRANTEE} to create drops on it's behalf`
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('also checks the wave on an edit that carries the proxy id', async () => {
    const dropsDb = {
      findDropById: jest.fn().mockResolvedValue({ drop_type: DropType.CHAT })
    };
    const proxyService = {
      findActiveProxyAction: jest.fn().mockResolvedValue(grant(['wave-1']))
    };
    const useCase = createUseCase({ proxyService, dropsDb });
    const write = jest
      .spyOn(useCase as any, 'createOrUpdateDrop')
      .mockResolvedValue({});
    await expect(
      useCase.execute(
        chatDropModel({ drop_id: 'drop-1', wave_id: 'wave-2' }),
        false,
        { connection: {} as any, prePublication: { trustedSystem: true } }
      )
    ).rejects.toThrow(ForbiddenException);
    expect(write).not.toHaveBeenCalled();
  });

  it('resolves the proxy from its identity when only that is known', async () => {
    jest
      .spyOn(identityFetcher, 'getProfileIdByIdentityKeyOrThrow')
      .mockResolvedValue(GRANTEE);
    const { result, proxyService } = executeWith(
      grant(['wave-1']),
      chatDropModel({ proxy_id: undefined, proxy_identity: 'grantee-handle' })
    );
    await expect(result).resolves.toBeDefined();
    expect(proxyService.findActiveProxyAction).toHaveBeenCalledWith(
      expect.objectContaining({ granted_to_profile_id: GRANTEE })
    );
  });

  it('does not consult the proxy service for an author writing as themselves', async () => {
    const { result, proxyService } = executeWith(
      null,
      chatDropModel({ proxy_id: undefined, proxy_identity: undefined })
    );
    await expect(result).resolves.toBeDefined();
    expect(proxyService.findActiveProxyAction).not.toHaveBeenCalled();
  });

  it('rejects a reply whose target lives in another wave, so a reply cannot escape the scope', async () => {
    const useCase = createUseCase({
      dropsDb: {
        getDropsByIds: jest
          .fn()
          .mockResolvedValue([
            { id: 'drop-in-wave-2', wave_id: 'wave-2', parts_count: 1 }
          ])
      }
    });
    await expect(
      (useCase as any).verifyReplyDrop(
        chatDropModel({
          wave_id: 'wave-1',
          reply_to: { drop_id: 'drop-in-wave-2', drop_part_id: 1 }
        }),
        { connection: {} }
      )
    ).rejects.toThrow(
      'Invalid reply. Drop you are replying to is not in the same wave as you attempt to create a drop in'
    );
    await expect(
      (useCase as any).verifyReplyDrop(
        chatDropModel({
          wave_id: 'wave-2',
          reply_to: { drop_id: 'drop-in-wave-2', drop_part_id: 1 }
        }),
        { connection: {} }
      )
    ).resolves.toBeUndefined();
  });
});

describe('CreateOrUpdateDropUseCase.countAllMentionRecipients with a scoped proxy', () => {
  function proxyContext(wave_allowlist: string[] | null) {
    return new AuthenticationContext({
      authenticatedWallet: '0xgrantee',
      authenticatedProfileId: GRANTEE,
      roleProfileId: GRANTOR,
      activeProxyActions: [
        {
          id: 'action-1',
          type: ProfileProxyActionType.CREATE_DROP_TO_WAVE,
          credit_amount: null,
          credit_spent: null,
          wave_allowlist
        }
      ]
    });
  }

  function setup() {
    const findWaveById = jest.fn(async (id: string) => ({
      id,
      created_by: GRANTOR,
      admin_group_id: null,
      visibility_group_id: null,
      parent_wave_id: null
    }));
    const useCase = createUseCase({
      wavesApiDb: { findWaveById },
      userGroupsService: {
        getGroupsUserIsEligibleFor: jest.fn().mockResolvedValue([]),
        findIdentitiesInGroups: jest.fn().mockResolvedValue([])
      },
      identitySubscriptionsDb: {
        findWaveFollowersEligibleForDropNotifications: jest
          .fn()
          .mockResolvedValue([
            { identity_id: 'follower', has_group_mention: true }
          ])
      },
      userNotifier: {
        countMentionRecipients: jest.fn(async (ids: string[]) => ids.length)
      }
    });
    return { useCase, findWaveById };
  }

  it('refuses the count for a wave outside the allowlist without reading the wave', async () => {
    const { useCase, findWaveById } = setup();
    await expect(
      useCase.countAllMentionRecipients('wave-2', {
        authenticationContext: proxyContext(['wave-1'])
      })
    ).rejects.toThrow('Posting rights are required');
    expect(findWaveById).not.toHaveBeenCalled();
  });

  it('counts for a listed wave and for a legacy grant', async () => {
    const { useCase } = setup();
    await expect(
      useCase.countAllMentionRecipients('wave-1', {
        authenticationContext: proxyContext(['wave-1'])
      })
    ).resolves.toBe(1);
    await expect(
      useCase.countAllMentionRecipients('wave-2', {
        authenticationContext: proxyContext(null)
      })
    ).resolves.toBe(1);
  });
});
