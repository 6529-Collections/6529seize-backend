import { CollectingService } from '@/collecting/collecting.service';
import { collectingAssetKey } from '@/collecting/collecting-analysis';
import { MEMES_CONTRACT } from '@/constants';
import { CollectingTdhProjectionInput } from '@/collecting/collecting-tdh-projection';

jest.mock('@/db', () => ({}));
jest.mock('@/nextgen/nextgen.db', () => ({}));

const wallet = '0x0000000000000000000000000000000000000011';
const outside = '0x0000000000000000000000000000000000000022';
const assetKey = collectingAssetKey(MEMES_CONTRACT, '1');
const input: CollectingTdhProjectionInput = {
  snapshot_block: 100,
  snapshot_timestamp: '2026-01-31T00:00:00Z',
  rules_version: 'fixture',
  wallets: [wallet],
  tokens: [
    {
      contract: MEMES_CONTRACT,
      token_id: 1,
      family: 'memes',
      minted_at: '2025-01-01T00:00:00Z',
      hodl_rate: 1,
      calculation_edition_size: 100
    }
  ],
  seasons: [],
  transactions: [],
  evaluated_at: '2026-01-31T00:00:00Z',
  transfers: []
};

function service(
  now = '2026-01-31T12:00:00Z',
  boost = 1,
  projectionInput = input
) {
  const db = {
    readCatalog: jest.fn(),
    readAccountHoldings: jest.fn(),
    readTdhProjectionSource: jest.fn().mockResolvedValue({
      account: {
        profile_id: 'profile',
        consolidation_key: wallet,
        wallets: [wallet],
        membership_hash: 'members'
      },
      input: projectionInput,
      official: { base_tdh: 0, boosted_tdh: 0, boost, full_memes_sets: 0 }
    })
  };
  return new CollectingService(db, () => Date.parse(now));
}

describe('purchase TDH projections', () => {
  it('projects a 500-card full basket and rejects more than 2000 allocations before replay', async () => {
    const tokens = Array.from({ length: 500 }, (_, index) => ({
      ...input.tokens[0],
      token_id: index + 1
    }));
    const projectionService = service('2026-01-31T12:00:00Z', 1, {
      ...input,
      tokens
    });
    const acquisitions = tokens.map((token) => ({
      asset_key: collectingAssetKey(token.contract, String(token.token_id)),
      quantity: '1',
      recipient: wallet
    }));
    const result = await projectionService.projectPurchases({
      profile_id: 'profile',
      horizon_days: 30,
      acquisitions
    });
    expect(result.recipient_allocations).toHaveLength(500);
    expect(result.proposed.tokens).toHaveLength(500);
    expect(result.additional_base_tdh).toBe(500 * 29);
    await expect(
      projectionService.projectPurchases({
        profile_id: 'profile',
        horizon_days: 30,
        acquisitions: Array.from({ length: 2001 }, () => acquisitions[0])
      })
    ).rejects.toThrow('bounds');
  });

  it('constructs acquisition dates on the server and permits split own and third-party recipients', async () => {
    const result = await service().projectPurchases({
      profile_id: 'profile',
      horizon_days: 30,
      acquisitions: [
        { asset_key: assetKey, quantity: '1', recipient: wallet },
        { asset_key: assetKey, quantity: '2', recipient: outside }
      ]
    });
    expect(result.acquisition_timestamp).toBe('2026-01-31T12:00:00.000Z');
    expect(result.evaluated_at).toBe('2026-03-02T00:00:00.000Z');
    expect(result.proposed.base_tdh).toBe(29);
    expect(result.proposed.tokens[0].balance).toBe(1);
    expect(
      result.recipient_allocations.map(
        (allocation) => allocation.counts_toward_profile
      )
    ).toEqual([true, false]);
  });

  it('shows zero new lot days at the next daily cutoff when held for less than a full day', async () => {
    const result = await service().projectPurchases({
      profile_id: 'profile',
      horizon_days: 1,
      acquisitions: [{ asset_key: assetKey, quantity: '1', recipient: wallet }]
    });
    expect(result.evaluated_at).toBe('2026-02-01T00:00:00.000Z');
    expect(result.additional_base_tdh).toBe(0);
  });

  it('requires a recent source, official parity and supported horizon', async () => {
    const request = {
      profile_id: 'profile',
      horizon_days: 30 as const,
      acquisitions: [{ asset_key: assetKey, quantity: '1', recipient: wallet }]
    };
    await expect(
      service('2026-02-02T00:00:00Z').projectPurchases(request)
    ).rejects.toThrow('recent');
    await expect(
      service('2026-01-31T12:00:00Z', 1.01).projectPurchases(request)
    ).rejects.toThrow('official snapshot');
    await expect(
      service().projectPurchases({ ...request, horizon_days: 2 as 1 })
    ).rejects.toThrow('bounds');
  });

  it('rejects unknown assets, duplicate allocations, invalid recipients and fractional quantities', async () => {
    const request = {
      profile_id: 'profile',
      horizon_days: 30 as const,
      acquisitions: [{ asset_key: assetKey, quantity: '1', recipient: wallet }]
    };
    for (const acquisition of [
      { ...request.acquisitions[0], asset_key: 'unknown' },
      { ...request.acquisitions[0], quantity: '1.1' },
      { ...request.acquisitions[0], recipient: 'not-a-wallet' }
    ])
      await expect(
        service().projectPurchases({ ...request, acquisitions: [acquisition] })
      ).rejects.toThrow('allocation');
    await expect(
      service().projectPurchases({
        ...request,
        acquisitions: request.acquisitions.concat(request.acquisitions)
      })
    ).rejects.toThrow('allocation');
  });
});
