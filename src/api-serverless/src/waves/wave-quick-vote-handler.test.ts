import { AuthenticationContext } from '@/auth-context';
import { getAuthenticationContext } from '@/api/auth/auth';
import { GetWaveUndiscoveredDropsRequest } from '@/api/generated/routes/operations';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { waveQuickVoteApiService } from './wave-quick-vote.api.service';
import { handleGetWaveUndiscoveredDrops } from './wave-quick-vote.handler';

jest.mock('@/api/auth/auth', () => ({ getAuthenticationContext: jest.fn() }));
jest.mock('./wave-quick-vote.api.service', () => ({
  waveQuickVoteApiService: { findUndiscoveredDrops: jest.fn() }
}));

const request = (query: Record<string, string> = {}) =>
  ({
    params: { id: 'wave' },
    query,
    headers: {}
  }) as unknown as GetWaveUndiscoveredDropsRequest;

describe('quick vote window handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.fromProfileId('viewer'));
    jest
      .mocked(waveQuickVoteApiService.findUndiscoveredDrops)
      .mockResolvedValue({
        drops: [],
        total_count: 0,
        left_to_vote_in_current_round: 0
      });
  });

  it('defaults to four previews for the acting identity', async () => {
    await handleGetWaveUndiscoveredDrops(request());
    expect(waveQuickVoteApiService.findUndiscoveredDrops).toHaveBeenCalledWith(
      { waveId: 'wave', identityId: 'viewer', limit: 4 },
      expect.anything()
    );
  });

  it.each(['0', '5', '-1', '1.5', 'bad'])(
    'rejects invalid window limit %s',
    async (limit) => {
      await expect(
        handleGetWaveUndiscoveredDrops(request({ limit }))
      ).rejects.toThrow();
      expect(
        waveQuickVoteApiService.findUndiscoveredDrops
      ).not.toHaveBeenCalled();
    }
  );

  it('requires a profile', async () => {
    jest
      .mocked(getAuthenticationContext)
      .mockResolvedValue(AuthenticationContext.notAuthenticated());
    await expect(handleGetWaveUndiscoveredDrops(request())).rejects.toThrow(
      'Please create a profile'
    );
  });

  it.each([
    null,
    ProfileProxyActionType.READ_WAVE,
    ProfileProxyActionType.RATE_WAVE_DROP
  ])('preserves proxy permissions %s', async (action) => {
    jest.mocked(getAuthenticationContext).mockResolvedValue(
      new AuthenticationContext({
        authenticatedWallet: null,
        authenticatedProfileId: 'proxy',
        roleProfileId: 'viewer',
        activeProxyActions: action
          ? [
              {
                id: 'action',
                type: action,
                credit_amount: null,
                credit_spent: null
              }
            ]
          : []
      })
    );
    if (action) {
      await handleGetWaveUndiscoveredDrops(request({ limit: '1' }));
      expect(
        waveQuickVoteApiService.findUndiscoveredDrops
      ).toHaveBeenCalledWith(
        { waveId: 'wave', identityId: 'viewer', limit: 1 },
        expect.anything()
      );
    } else {
      await expect(handleGetWaveUndiscoveredDrops(request())).rejects.toThrow(
        "Proxy doesn't have permission"
      );
      expect(
        waveQuickVoteApiService.findUndiscoveredDrops
      ).not.toHaveBeenCalled();
    }
  });
});
