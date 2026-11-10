const mockGetAuthenticationContext = jest.fn();
const mockGetGroupsUserIsEligibleFor = jest.fn();
const mockFindWaveById = jest.fn();
const mockFindWaveChatDropCooldownsByWaveIds = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/community-members/user-groups.service', () => ({
  userGroupsService: {
    getGroupsUserIsEligibleFor: mockGetGroupsUserIsEligibleFor
  }
}));

jest.mock('@/api/waves/waves.api.db', () => ({
  wavesApiDb: {
    findWaveById: mockFindWaveById,
    findWaveChatDropCooldownsByWaveIds: mockFindWaveChatDropCooldownsByWaveIds
  }
}));

jest.mock('@/time', () => ({
  Time: jest.requireActual('@/time').Time,
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { CustomApiCompliantException, NotFoundException } from '@/exceptions';
import { ApiWaveParticipationAction } from '@/api/generated/models/ApiWaveParticipationAction';
import { ApiWaveParticipationEvaluation } from '@/api/generated/models/ApiWaveParticipationEvaluation';
import { ApiWaveParticipationReasonCode } from '@/api/generated/models/ApiWaveParticipationReasonCode';
import { handleGetWaveParticipation } from './wave-participation.handlers';

const CHAT_GROUP = 'chat-group';
const VISIBILITY_GROUP = 'visible-group';
const MEMBER = 'member-profile';

function wave(overrides: Record<string, unknown> = {}) {
  return {
    id: 'wave-1',
    parent_wave_id: null,
    visibility_group_id: null,
    created_by: 'creator',
    admin_group_id: null,
    chat_enabled: true,
    chat_group_id: CHAT_GROUP,
    chat_replies_open: false,
    chat_slow_mode_cooldown_ms: null,
    is_direct_message: false,
    ...overrides
  };
}

function proxyContext(actions: ProfileProxyActionType[]) {
  return new AuthenticationContext({
    authenticatedWallet: '0xabc',
    authenticatedProfileId: 'proxy-profile',
    roleProfileId: MEMBER,
    activeProxyActions: actions.map((type) => ({
      id: type,
      type,
      credit_amount: null,
      credit_spent: null
    }))
  });
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    return (error as CustomApiCompliantException).getStatusCode();
  }
  throw new Error('expected rejection');
}

describe('handleGetWaveParticipation', () => {
  const req = { params: { id: 'wave-1' } } as any;
  const timer = { marker: 'timer' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFromRequest.mockReturnValue(timer);
    mockGetAuthenticationContext.mockResolvedValue(
      AuthenticationContext.fromProfileId(MEMBER)
    );
    mockGetGroupsUserIsEligibleFor.mockResolvedValue([CHAT_GROUP]);
    mockFindWaveChatDropCooldownsByWaveIds.mockResolvedValue({});
    mockFindWaveById.mockImplementation(async (id: string) =>
      id === 'wave-1' ? wave() : null
    );
  });

  it('returns a 404 for a wave hidden from the caller, without reasons', async () => {
    mockFindWaveById.mockResolvedValue(
      wave({ visibility_group_id: VISIBILITY_GROUP })
    );
    const call = handleGetWaveParticipation(req);
    await expect(call).rejects.toBeInstanceOf(NotFoundException);
    await expect(call).rejects.toThrow('Wave wave-1 not found');
  });

  it('returns a 404 for a wave whose parent is hidden', async () => {
    mockFindWaveById.mockImplementation(async (id: string) =>
      id === 'wave-1'
        ? wave({ parent_wave_id: 'parent' })
        : wave({
            id: 'parent',
            visibility_group_id: VISIBILITY_GROUP
          })
    );
    await expect(handleGetWaveParticipation(req)).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('returns a 404 for an unknown wave', async () => {
    mockFindWaveById.mockResolvedValue(null);
    await expect(handleGetWaveParticipation(req)).rejects.toBeInstanceOf(
      NotFoundException
    );
  });

  it('propagates the membership 503 instead of answering with a denial', async () => {
    mockGetGroupsUserIsEligibleFor.mockRejectedValue(
      new CustomApiCompliantException(
        503,
        'Membership eligibility is temporarily unavailable'
      )
    );
    expect(await statusOf(handleGetWaveParticipation(req))).toBe(503);
    expect(mockFindWaveById).not.toHaveBeenCalled();
  });

  it('explains an anonymous caller on a public wave', async () => {
    mockGetAuthenticationContext.mockResolvedValue(
      AuthenticationContext.notAuthenticated()
    );
    const result = await handleGetWaveParticipation(req);
    expect(mockGetGroupsUserIsEligibleFor).not.toHaveBeenCalled();
    expect(result.wave_id).toBe('wave-1');
    expect(typeof result.evaluated_at).toBe('number');
    expect(result.decisions).toEqual([
      {
        action: ApiWaveParticipationAction.Chat,
        allowed: false,
        reason_code: ApiWaveParticipationReasonCode.NotAuthenticated,
        constraints: {
          chat_enabled: true,
          chat_group_required: true,
          replies_open: false
        },
        evaluation: ApiWaveParticipationEvaluation.Evaluated
      },
      {
        action: ApiWaveParticipationAction.Reply,
        allowed: false,
        reason_code: ApiWaveParticipationReasonCode.NotAuthenticated,
        constraints: {
          chat_enabled: true,
          chat_group_required: true,
          replies_open: false
        },
        evaluation: ApiWaveParticipationEvaluation.Evaluated
      }
    ]);
  });

  it('allows a chat group member and omits optional fields', async () => {
    const result = await handleGetWaveParticipation(req);
    expect(mockGetGroupsUserIsEligibleFor).toHaveBeenCalledTimes(1);
    expect(mockGetGroupsUserIsEligibleFor).toHaveBeenCalledWith(MEMBER, timer);
    expect(mockFindWaveChatDropCooldownsByWaveIds).not.toHaveBeenCalled();
    for (const decision of result.decisions) {
      expect(decision.allowed).toBe(true);
      expect(decision).not.toHaveProperty('reason_code');
      expect(decision).not.toHaveProperty('retry_at');
    }
  });

  it('names the chat group gate without naming the group', async () => {
    mockGetGroupsUserIsEligibleFor.mockResolvedValue([]);
    const result = await handleGetWaveParticipation(req);
    expect(JSON.stringify(result)).not.toContain(CHAT_GROUP);
    expect(result.decisions.map((it) => it.reason_code)).toEqual([
      ApiWaveParticipationReasonCode.NotInChatGroup,
      ApiWaveParticipationReasonCode.NotInChatGroup
    ]);
  });

  it('reports an active slow mode cooldown with retry_at', async () => {
    const retryAt = Date.now() + 30_000;
    mockFindWaveById.mockResolvedValue(
      wave({ chat_slow_mode_cooldown_ms: 60_000 })
    );
    mockFindWaveChatDropCooldownsByWaveIds.mockResolvedValue({
      'wave-1': { wave_id: 'wave-1', next_drop_timestamp: retryAt }
    });
    const result = await handleGetWaveParticipation(req);
    expect(mockFindWaveChatDropCooldownsByWaveIds).toHaveBeenCalledWith(
      { profileId: MEMBER, waveIds: ['wave-1'] },
      expect.objectContaining({ timer })
    );
    for (const decision of result.decisions) {
      expect(decision.allowed).toBe(false);
      expect(decision.reason_code).toBe(
        ApiWaveParticipationReasonCode.SlowModeCooldown
      );
      expect(decision.retry_at).toBe(retryAt);
      expect(decision.constraints.slow_mode_cooldown_ms).toBe(60_000);
      expect(result.evaluated_at).toBeLessThan(retryAt);
    }
  });

  it('denies a proxy without the create-drop action', async () => {
    mockGetAuthenticationContext.mockResolvedValue(
      proxyContext([ProfileProxyActionType.READ_WAVE])
    );
    const result = await handleGetWaveParticipation(req);
    expect(result.decisions.map((it) => it.reason_code)).toEqual([
      ApiWaveParticipationReasonCode.ProxyLacksAction,
      ApiWaveParticipationReasonCode.ProxyLacksAction
    ]);
  });

  it('judges membership for the acting profile of a drop-only proxy', async () => {
    mockGetAuthenticationContext.mockResolvedValue(
      proxyContext([ProfileProxyActionType.CREATE_DROP_TO_WAVE])
    );
    const result = await handleGetWaveParticipation(req);
    // Read context treated the proxy as anonymous (no READ_WAVE), so the
    // acting profile's groups were fetched for the decision itself.
    expect(mockGetGroupsUserIsEligibleFor).toHaveBeenCalledTimes(1);
    expect(mockGetGroupsUserIsEligibleFor).toHaveBeenCalledWith(MEMBER, timer);
    expect(result.decisions.every((it) => it.allowed)).toBe(true);
  });

  it('reports the unencrypted DM cutoff', async () => {
    process.env.LEGACY_DM_DELETION_CUTOFF = '2000-01-01T00:00:00Z';
    try {
      mockFindWaveById.mockResolvedValue(wave({ is_direct_message: true }));
      const result = await handleGetWaveParticipation(req);
      expect(result.decisions.map((it) => it.reason_code)).toEqual([
        ApiWaveParticipationReasonCode.LegacyDmClosed,
        ApiWaveParticipationReasonCode.LegacyDmClosed
      ]);
    } finally {
      delete process.env.LEGACY_DM_DELETION_CUTOFF;
    }
  });
});
