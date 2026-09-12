import { AuthenticationContext } from '@/auth-context';
import { collectingService } from '@/collecting/collecting.service';
import { collectingDb } from '@/collecting/collecting.db';
import { CollectingAsset } from '@/collecting/collecting.types';
import { OfferAnalysisRequest } from '@/collecting/collecting-offer-analysis.types';
import { collectOfferExposure } from '@/collecting/collecting-offer-exposure.db';
import { marketChain } from '@/marketplace/market-chain';
import { marketDepthApiDb } from '@/api/market-depth/market-depth-api.db';
import { analyzeCollectOffers } from '@/api/collect/collect-offer-analysis.service';
import { MEMES_CONTRACT } from '@/constants';
import { ObjectSerializer } from '@/api/generated/models/ObjectSerializer';

jest.mock('@/collecting/collecting.service', () => ({
  collectingService: { getCatalog: jest.fn() }
}));
jest.mock('@/collecting/collecting.db', () => ({
  collectingDb: { readAccountHoldings: jest.fn() }
}));
jest.mock('@/collecting/collecting-offer-exposure.db', () => ({
  collectOfferExposure: jest.fn()
}));
jest.mock('@/marketplace/market-chain', () => ({ marketChain: jest.fn() }));
jest.mock('@/api/market-depth/market-depth-api.db', () => ({
  marketDepthApiDb: { getBooks: jest.fn() }
}));
jest.mock('@/api/marketplace/marketplace.service', () => ({
  assertMarketActor: (auth: AuthenticationContext) => ({
    profileId: auth.authenticatedProfileId,
    wallet: auth.authenticatedWallet?.toLowerCase()
  }),
  assertMarketEnabled: jest.fn()
}));

const wallet = '0x1111111111111111111111111111111111111111';
const friend = '0x2222222222222222222222222222222222222222';
const asset: CollectingAsset = {
  asset_key: `1:${MEMES_CONTRACT.toLowerCase()}:1`,
  chain_id: 1,
  contract: MEMES_CONTRACT.toLowerCase(),
  token_id: '1',
  family: 'memes',
  name: 'Meme 1',
  image_url: null,
  artist_ids: [],
  season: 1,
  traits: [],
  hodl_rate: 1,
  tdh_eligible: true
};
const auth = new AuthenticationContext({
  authenticatedWallet: wallet,
  authenticatedProfileId: 'profile',
  roleProfileId: null,
  activeProxyActions: []
});
const chain = {
  snapshot: jest.fn(),
  currencyBalance: jest.fn(),
  rpc: { getCode: jest.fn() }
};
function request(
  patch: Partial<OfferAnalysisRequest> = {}
): OfferAnalysisRequest {
  return {
    profile_id: 'profile',
    wallet,
    recipient: wallet,
    acknowledge_external_recipient: false,
    expires_at: Math.floor(Date.now() / 1000) + 86400,
    assets: [
      {
        asset_key: asset.asset_key,
        quantity: '2',
        manual_unit_amount_wei: '100'
      }
    ],
    method: { kind: 'manual' },
    ...patch
  };
}

describe('private group offer analysis service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(collectingService.getCatalog).mockResolvedValue({
      version: 'catalog',
      chain_id: 1,
      assets: [asset],
      seasons: [],
      artists: [],
      pebbles_traits: [],
      tdh_snapshot: null
    });
    jest.mocked(collectingDb.readAccountHoldings).mockResolvedValue({
      account: {
        profile_id: 'profile',
        consolidation_key: 'profile',
        wallets: [wallet],
        membership_hash: 'membership'
      },
      holdings: [],
      block_number: 1
    } as unknown as Awaited<
      ReturnType<typeof collectingDb.readAccountHoldings>
    >);
    jest.mocked(collectOfferExposure).mockResolvedValue(BigInt(300));
    jest.mocked(marketDepthApiDb.getBooks).mockResolvedValue([]);
    jest
      .mocked(marketChain)
      .mockReturnValue(chain as unknown as ReturnType<typeof marketChain>);
    chain.snapshot.mockResolvedValue({ block_number: 1 });
    chain.currencyBalance.mockResolvedValue('1000');
    chain.rpc.getCode.mockResolvedValue('0x');
  });

  it('returns catalog metadata and exact per-NFT terms, subtracting existing liabilities without reserving funds', async () => {
    const result = await analyzeCollectOffers(auth, request());
    expect(result.rows[0]).toMatchObject({
      asset: { name: 'Meme 1', asset_key: asset.asset_key },
      total_amount_wei: '200',
      prepare_request: { amount_wei: '200', quantity: '2' }
    });
    expect(result.totals).toMatchObject({
      proposed_weth_wei: '200',
      tracked_payer_liability_wei: '300',
      weth_balance_wei: '1000',
      available_weth_wei: '700',
      unallocated_weth_wei: '500'
    });
    expect(result.coverage).toMatchObject({
      complete: false,
      external_orders: 'NOT_COMPREHENSIVE',
      execution_verified: false,
      funding_reserved: false
    });
    expect(result.signing_policy).toBe('INDIVIDUAL_OFFERS');
    expect(result.valid_until - result.created_at).toBeLessThanOrEqual(60000);
    expect(marketDepthApiDb.getBooks).not.toHaveBeenCalled();
    expect(collectOfferExposure).toHaveBeenCalledWith(wallet);
    const wire = ObjectSerializer.serialize(
      result,
      'ApiCollectOfferAnalysis',
      ''
    );
    expect(
      ObjectSerializer.deserialize(wire, 'ApiCollectOfferAnalysis', '')
    ).toMatchObject(result);
  });

  it('rejects profile or payer substitution before reading private account state', async () => {
    await expect(
      analyzeCollectOffers(auth, request({ profile_id: 'other' }))
    ).rejects.toThrow();
    await expect(
      analyzeCollectOffers(auth, request({ wallet: friend }))
    ).rejects.toThrow();
    expect(collectingDb.readAccountHoldings).not.toHaveBeenCalled();
  });

  it('fails closed when the payer leaves the profile', async () => {
    jest.mocked(collectingDb.readAccountHoldings).mockResolvedValue({
      account: { wallets: [friend] }
    } as unknown as Awaited<
      ReturnType<typeof collectingDb.readAccountHoldings>
    >);
    await expect(analyzeCollectOffers(auth, request())).rejects.toThrow(
      'no longer'
    );
    expect(chain.currencyBalance).not.toHaveBeenCalled();
  });

  it('rejects unsupported offer gifting even when the external recipient is acknowledged', async () => {
    await expect(
      analyzeCollectOffers(auth, request({ recipient: friend }))
    ).rejects.toThrow('paying wallet');
    await expect(
      analyzeCollectOffers(
        auth,
        request({ recipient: friend, acknowledge_external_recipient: true })
      )
    ).rejects.toThrow('paying wallet');
    expect(collectingDb.readAccountHoldings).not.toHaveBeenCalled();
  });

  it('does not turn insufficient funding or unsupported wallet execution into actionable proposals', async () => {
    chain.currencyBalance.mockResolvedValue('400');
    const result = await analyzeCollectOffers(auth, request());
    expect(result.totals.available_weth_wei).toBe('100');
    expect(result.rows[0]).toMatchObject({
      total_amount_wei: '200',
      selected: false
    });
    expect(result.rows[0].prepare_request).toBeUndefined();
    expect(result.rows[0].reason_codes).toContain('INSUFFICIENT_WETH');
    chain.rpc.getCode.mockResolvedValue('0x1234');
    await expect(analyzeCollectOffers(auth, request())).rejects.toThrow(
      'smart wallet'
    );
  });

  it('reads one bounded collection book for all selected NFT references and reports unknown assets explicitly', async () => {
    const result = await analyzeCollectOffers(
      auth,
      request({
        assets: [
          { asset_key: asset.asset_key, quantity: '1' },
          { asset_key: 'unknown', quantity: '1' }
        ],
        method: { kind: 'match_bid' }
      })
    );
    expect(marketDepthApiDb.getBooks).toHaveBeenCalledTimes(1);
    expect(marketDepthApiDb.getBooks).toHaveBeenCalledWith(
      {
        contract: asset.contract,
        token_id: asset.token_id,
        collection_id: null
      },
      'all'
    );
    expect(result.rows[0].reason_codes).toContain('NO_APPLICABLE_BID');
    expect(result.rows[1]).toMatchObject({
      status: 'UNAVAILABLE',
      reason_codes: ['UNSUPPORTED_ASSET']
    });
    expect(result.rows[1].asset).toBeUndefined();
  });

  it('validates proposed expiry before obtaining market or account snapshots', async () => {
    for (const offset of [299, 86400 * 31])
      await expect(
        analyzeCollectOffers(
          auth,
          request({ expires_at: Math.floor(Date.now() / 1000) + offset })
        )
      ).rejects.toThrow('expiry');
    expect(collectingService.getCatalog).not.toHaveBeenCalled();
  });
});
