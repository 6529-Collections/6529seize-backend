import { MEMELAB_CONTRACT, MEMES_CONTRACT } from '@/constants';
import {
  CollectingService,
  collectingService
} from '@/collecting/collecting.service';
import {
  handleAnalyzeCollectGoal,
  handleGetCollectAssets
} from '@/api/collect/collect.handlers';
import {
  CollectingAsset,
  CollectingCatalog
} from '@/collecting/collecting.types';
import {
  catalogForTradeAssets,
  CollectingTradeAssetsDb,
  memeLabTradeTokenId
} from '@/collecting/collecting-trade-assets';
import { SqlExecutor } from '@/sql-executor';

jest.mock('@/db', () => ({}));
jest.mock('@/nextgen/nextgen.db', () => ({}));

const key = `1:${MEMELAB_CONTRACT}:70`;
const wallet = '0x1111111111111111111111111111111111111111';
const secondWallet = '0x2222222222222222222222222222222222222222';
const lab: CollectingAsset = {
  asset_key: key,
  chain_id: 1,
  contract: MEMELAB_CONTRACT,
  token_id: '70',
  family: 'memelab',
  name: 'Lab artwork',
  image_url: null,
  artist_ids: [],
  season: null,
  traits: [],
  hodl_rate: null,
  tdh_eligible: false
};
const meme: CollectingAsset = {
  ...lab,
  asset_key: `1:${MEMES_CONTRACT.toLowerCase()}:1`,
  contract: MEMES_CONTRACT.toLowerCase(),
  family: 'memes',
  token_id: '1',
  name: 'Meme artwork',
  hodl_rate: 1,
  tdh_eligible: true
};
const catalog: CollectingCatalog = {
  version: 'planner-version',
  chain_id: 1,
  assets: [meme],
  seasons: [],
  artists: [],
  pebbles_traits: [],
  tdh_snapshot: null
};

function setup() {
  const db = {
    readCatalog: jest.fn().mockResolvedValue(catalog),
    readAccountHoldings: jest
      .fn()
      .mockImplementation(async (profile, options) => ({
        account: {
          profile_id: profile,
          consolidation_key: 'confirmed',
          wallets: [wallet, secondWallet],
          membership_hash: 'members'
        },
        holdings: options?.includeMemeLab
          ? [
              { asset_key: key, wallet, quantity: '2' },
              { asset_key: key, wallet: secondWallet, quantity: '3' }
            ]
          : [],
        snapshot: { block_number: 100, nextgen_block_number: null }
      })),
    readTdhProjectionSource: jest.fn()
  };
  const trade = { readMemeLabAssets: jest.fn().mockResolvedValue([lab]) };
  return { db, trade, service: new CollectingService(db, Date.now, trade) };
}

describe('Meme Lab card asset boundary', () => {
  afterEach(() => jest.restoreAllMocks());

  it('serves explicit Lab search and exact profile ownership through the public handlers', async () => {
    const { service, trade } = setup();
    jest
      .spyOn(collectingService, 'listAssets')
      .mockImplementation((request) => service.listAssets(request));
    jest
      .spyOn(collectingService, 'analyze')
      .mockImplementation((request, options) =>
        service.analyze(request, options)
      );
    const assets = await handleGetCollectAssets({
      query: { family: 'memelab', query: '70' }
    } as Parameters<typeof handleGetCollectAssets>[0]);
    expect(assets.data).toEqual([lab]);
    const set = jest.fn();
    const result = await handleAnalyzeCollectGoal({
      body: {
        profile_id: 'profile',
        kind: 'exact',
        assets: [{ asset_key: key, quantity: '6' }]
      },
      res: { set }
    } as unknown as Parameters<typeof handleAnalyzeCollectGoal>[0]);
    expect(result.requirements[0]).toMatchObject({
      owned_quantity: '5',
      missing_quantity: '1'
    });
    expect(set).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
    const calls = trade.readMemeLabAssets.mock.calls.length;
    await expect(
      handleGetCollectAssets({ query: { family: 'unknown' } } as Parameters<
        typeof handleGetCollectAssets
      >[0])
    ).rejects.toThrow('Invalid');
    expect(trade.readMemeLabAssets).toHaveBeenCalledTimes(calls);
  });
  it.each([
    `2:${MEMELAB_CONTRACT}:70`,
    `1:${MEMES_CONTRACT.toLowerCase()}:70`,
    `1:${MEMELAB_CONTRACT}:070`,
    `1:${MEMELAB_CONTRACT}:-1`,
    `${key}:extra`,
    `1:${MEMELAB_CONTRACT}:${BigInt(1) << BigInt(256)}`,
    `1:${MEMELAB_CONTRACT.toUpperCase()}:70`
  ])(
    'rejects a noncanonical key without inferring another identity: %s',
    (value) => {
      expect(memeLabTradeTokenId(value)).toBeNull();
    }
  );

  it('accepts exact uint256 identities and rejects oversized explicit work before I/O', async () => {
    expect(memeLabTradeTokenId(key)).toBe('70');
    expect(
      memeLabTradeTokenId(
        `1:${MEMELAB_CONTRACT}:${(BigInt(1) << BigInt(256)) - BigInt(1)}`
      )
    ).not.toBeNull();
    const { trade } = setup();
    await expect(
      catalogForTradeAssets(catalog, Array(2001).fill(key), trade)
    ).rejects.toThrow('Too many');
    expect(trade.readMemeLabAssets).not.toHaveBeenCalled();
  });

  it('uses only the fixed contract and indexed minted artwork query, with no invented TDH', async () => {
    const execute = jest
      .fn()
      .mockResolvedValue([
        { token_id: '70', name: 'Lab artwork', image_url: null }
      ]);
    const db = new CollectingTradeAssetsDb(
      () => ({ execute }) as unknown as SqlExecutor
    );
    expect(await db.readMemeLabAssets(['70'])).toEqual([lab]);
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining('mint_date IS NOT NULL'),
      { contract: MEMELAB_CONTRACT, tokenIds: ['70'] },
      expect.any(Object)
    );
    await expect(db.readMemeLabAssets(['70 OR 1=1'])).rejects.toThrow(
      'Invalid'
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('searches Meme Lab only when explicitly requested and keeps the cached planner catalog unchanged', async () => {
    const { service, db, trade } = setup();
    const result = await service.listAssets({
      family: 'memelab',
      query: '70',
      page: 1,
      page_size: 24
    });
    expect(result.data).toEqual([lab]);
    expect(db.readCatalog).not.toHaveBeenCalled();
    expect(result.data[0].tdh_eligible).toBe(false);
    const ordinary = await service.listAssets({ page: 1, page_size: 24 });
    expect(ordinary.data).toEqual([meme]);
    expect(await service.getCatalog()).toBe(catalog);
    expect(catalog.assets).toEqual([meme]);
    expect(trade.readMemeLabAssets).toHaveBeenCalledTimes(1);
  });

  it('counts explicit Lab quantities across confirmed wallets without adding them to full-set goals', async () => {
    const { service, db, trade } = setup();
    const exact = await service.analyze(
      {
        profile_id: 'profile',
        kind: 'exact',
        assets: [{ asset_key: key, quantity: '6' }]
      },
      { includeTradeAssets: true }
    );
    expect(exact.requirements[0]).toMatchObject({
      target_quantity: '6',
      owned_quantity: '5',
      missing_quantity: '1',
      holdings: [
        { asset_key: key, wallet, quantity: '2' },
        { asset_key: key, wallet: secondWallet, quantity: '3' }
      ]
    });
    expect(trade.readMemeLabAssets).toHaveBeenCalledWith(['70']);
    const full = await service.analyze({
      profile_id: 'profile',
      kind: 'memes_full_set'
    });
    expect(full.requirements.flatMap((entry) => entry.asset_keys)).toEqual([
      meme.asset_key
    ]);
    expect(db.readAccountHoldings).toHaveBeenLastCalledWith('profile');
    expect(trade.readMemeLabAssets).toHaveBeenCalledTimes(1);
    expect(catalog.assets).toEqual([meme]);
    expect(exact.catalog_version).not.toBe(catalog.version);
  });

  it('does not convert an unknown Lab artwork into a tradable asset', async () => {
    const { service, trade } = setup();
    trade.readMemeLabAssets.mockResolvedValue([]);
    await expect(
      service.analyze(
        {
          profile_id: 'profile',
          kind: 'exact',
          assets: [{ asset_key: key, quantity: '1' }]
        },
        { includeTradeAssets: true }
      )
    ).rejects.toThrow('Unknown');
  });

  it('rejects wrong-profile holdings and a stale explicit catalog revision', async () => {
    const { service, db } = setup();
    const request = {
      profile_id: 'profile',
      kind: 'exact' as const,
      assets: [{ asset_key: key, quantity: '1' }]
    };
    await expect(
      service.analyze(
        { ...request, catalog_version: 'stale' },
        { includeTradeAssets: true }
      )
    ).rejects.toThrow('Catalog changed');
    db.readAccountHoldings.mockResolvedValue({
      account: { profile_id: 'other', wallets: [wallet] },
      holdings: [],
      snapshot: { block_number: 100 }
    });
    await expect(
      service.analyze(request, { includeTradeAssets: true })
    ).rejects.toThrow('Account does not match');
  });

  it('keeps internal planner analyses on the original catalog even for an exact Lab key', async () => {
    const { service, trade } = setup();
    await expect(
      service.analyze({
        profile_id: 'profile',
        kind: 'exact',
        assets: [{ asset_key: key, quantity: '1' }]
      })
    ).rejects.toThrow('Unknown');
    expect(trade.readMemeLabAssets).not.toHaveBeenCalled();
  });
});
