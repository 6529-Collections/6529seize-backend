import { AuthenticationContext } from '@/auth-context';
import { getAuthenticationContext } from '@/api/auth/auth';
import { analyzeCollectOffers } from '@/api/collect/collect-offer-analysis.service';
import { handleAnalyzeCollectOffers } from '@/api/collect/collect-offer-analysis.handlers';
import * as Operations from '@/api/generated/routes/operations';

jest.mock('@/api/auth/auth', () => ({ getAuthenticationContext: jest.fn() }));
jest.mock('@/api/collect/collect-offer-analysis.service', () => ({
  analyzeCollectOffers: jest.fn()
}));

const wallet = '0x1111111111111111111111111111111111111111';
const auth = new AuthenticationContext({
  authenticatedWallet: wallet,
  authenticatedProfileId: 'profile',
  roleProfileId: null,
  activeProxyActions: []
});
const body = {
  profile_id: 'profile',
  wallet,
  recipient: wallet,
  acknowledge_external_recipient: false,
  expires_at: 2000000000,
  assets: [{ asset_key: 'nft', quantity: '1', manual_unit_amount_wei: '10' }],
  method: { kind: 'manual' }
};

describe('private offer analysis handler boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getAuthenticationContext).mockResolvedValue(auth);
  });

  it('keeps private analysis out of caches and removes input before downstream telemetry', async () => {
    const req = { body: { ...body }, res: { set: jest.fn() } };
    jest
      .mocked(analyzeCollectOffers)
      .mockResolvedValue({ analysis_id: 'analysis' } as Awaited<
        ReturnType<typeof analyzeCollectOffers>
      >);
    await expect(
      handleAnalyzeCollectOffers(
        req as unknown as Operations.AnalyzeCollectOffersRequest
      )
    ).resolves.toMatchObject({ analysis_id: 'analysis' });
    expect(analyzeCollectOffers).toHaveBeenCalledWith(auth, body);
    expect(req.res.set).toHaveBeenCalledWith({
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    expect(req.body).toBeUndefined();
  });

  it('rejects a manual budget without explicit per-NFT prices and scrubs the rejected input', async () => {
    const req = {
      body: {
        ...body,
        assets: [{ asset_key: 'nft', quantity: '1' }],
        max_total_weth_wei: '100'
      },
      res: { set: jest.fn() }
    };
    await expect(
      handleAnalyzeCollectOffers(
        req as unknown as Operations.AnalyzeCollectOffersRequest
      )
    ).rejects.toThrow('Invalid collecting or trade request');
    expect(analyzeCollectOffers).not.toHaveBeenCalled();
    expect(req.body).toBeUndefined();
  });
});
