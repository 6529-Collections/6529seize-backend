import { collectingService } from '@/collecting/collecting.service';
import { CollectingAsset } from '@/collecting/collecting.types';
import { collectingTradeAssetsDb } from '@/collecting/collecting-trade-assets';
import { MEMES_CONTRACT, MEMELAB_CONTRACT } from '@/constants';
import { MarketBatchPreparation } from '@/marketplace/market-batch-preparation';
import type { MarketChain } from '@/marketplace/market-chain';
import type { OpenSeaMarketplaceProvider } from '@/marketplace/provider.opensea';
import { MarketBatchPrepareRequest } from '@/marketplace/market-batch.schema';
import { MarketBatchPrepared } from '@/marketplace/market-batch.types';
import { MARKET_BATCH_INTERFACE } from '@/marketplace/seaport-batch.builder';
import {
  BATCH_BUYER,
  BATCH_OWN,
  marketBatchFixture
} from '@/marketplace/market-batch.test-fixture';
import { buildMarketFulfillment } from '@/marketplace/seaport.builder';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS
} from '@/marketplace/seaport.registry';

jest.mock('@/collecting/collecting.service', () => ({
  collectingService: { getCatalog: jest.fn() }
}));

function setup(contract = MEMES_CONTRACT) {
  const f = marketBatchFixture(2, contract);
  const request: MarketBatchPrepareRequest = {
    kind: 'BUY_BATCH',
    profile_id: 'profile',
    wallet: f.intent.wallet,
    currency: MARKET_ZERO_ADDRESS,
    execution_policy: 'ALL_OR_REVERT',
    amount_wei: f.intent.totalWei,
    items: f.intent.items.map((line) => ({
      asset_key: line.assetKey,
      quantity: line.intent.quantity,
      amount_wei: line.intent.maxTotalWei,
      order: {
        protocol_address: MARKET_SEAPORT,
        order_hash: line.intent.order!.orderHash
      },
      allocations: line.allocations.map((a) => ({
        recipient: a.recipient,
        quantity: a.quantity,
        acknowledge_external_recipient: a.acknowledgeExternalRecipient
      }))
    }))
  };
  const assets: CollectingAsset[] = f.intent.items.map((line) => ({
    asset_key: line.assetKey,
    contract: line.intent.asset.contract,
    token_id: line.intent.asset.tokenId,
    family:
      line.intent.asset.contract.toLowerCase() === MEMELAB_CONTRACT
        ? 'memelab'
        : line.intent.asset.standard === 'ERC1155'
          ? 'memes'
          : 'gradients',
    chain_id: 1,
    name: 'Test artwork',
    image_url: null,
    artist_ids: [],
    season: null,
    traits: [],
    hodl_rate: null,
    tdh_eligible: false
  }));
  (collectingService.getCatalog as jest.Mock).mockResolvedValue({
    assets: assets.filter((asset) => asset.family !== 'memelab')
  });
  jest
    .spyOn(collectingTradeAssetsDb, 'readMemeLabAssets')
    .mockResolvedValue(assets.filter((asset) => asset.family === 'memelab'));
  const provider = {
    getOrder: jest.fn(async (identity) => {
      const material = f.materials.find(
        (m) => m.order.orderHash === identity.orderHash
      )!;
      return { identity, components: material.order.components };
    }),
    prepareFulfillment: jest.fn(async (intent) => {
      const material = f.materials.find(
        (m) => m.order.orderHash === intent.order.orderHash
      )!;
      return buildMarketFulfillment(intent, material.order, material.signature);
    })
  };
  const chain = {
    rpc: {
      getCode: jest.fn().mockResolvedValue('0x'),
      getBlock: jest.fn().mockResolvedValue({
        hash: `0x${'11'.repeat(32)}`,
        timestamp: 1500,
        gasLimit: BigInt(60000000)
      })
    },
    snapshot: jest.fn().mockResolvedValue({
      block_number: 10,
      block_hash: `0x${'11'.repeat(32)}`,
      block_timestamp: 1500
    }),
    counter: jest.fn().mockResolvedValue('0'),
    orderStatus: jest.fn().mockResolvedValue({
      cancelled: false,
      filled: BigInt(0),
      size: BigInt(0)
    }),
    simulate: jest.fn().mockResolvedValue({
      gas_limit: '500000',
      max_fee_per_gas: '10',
      gas_reserve_wei: '5000000'
    })
  };
  const preparation = new MarketBatchPreparation(
    provider as unknown as OpenSeaMarketplaceProvider,
    chain as unknown as MarketChain
  );
  const prepare = (reviewed?: MarketBatchPrepared) =>
    preparation.prepare(
      request,
      [BATCH_BUYER, BATCH_OWN],
      new AbortController().signal,
      reviewed
    );
  return { f, request, provider, chain, prepare };
}

describe('atomic batch preparation', () => {
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(1500000);
    jest.clearAllMocks();
  });
  afterEach(() => jest.restoreAllMocks());
  test('keeps the unsigned buyer mirror active for an adjacent older RPC block without altering seller terms', async () => {
    const s = setup();
    const prepared = await s.prepare();
    const decoded = MARKET_BATCH_INTERFACE.decodeFunctionData(
      'matchAdvancedOrders',
      prepared.transaction.data
    );
    const buyer = decoded.orders[decoded.orders.length - 1];
    expect(buyer.parameters.startTime).toBe(BigInt(1380));
    expect(buyer.parameters.startTime).toBeLessThanOrEqual(BigInt(1488));
    expect(buyer.parameters.endTime).toBe(BigInt(1590));
    expect(buyer.signature).toBe('0x');
    s.f.materials.forEach((material, index) => {
      expect(decoded.orders[index].parameters.startTime.toString()).toBe(
        material.order.components.startTime
      );
      expect(decoded.orders[index].parameters.endTime.toString()).toBe(
        material.order.components.endTime
      );
      expect(decoded.orders[index].signature).toBe(material.signature);
    });
  });
  test('never backdates the mirror before any signed seller start', async () => {
    const s = setup();
    s.chain.snapshot.mockResolvedValue({
      block_number: 10,
      block_hash: `0x${'11'.repeat(32)}`,
      block_timestamp: 1050
    });
    const prepared = await s.prepare();
    expect(prepared.mirrorTerms.startTime).toBe('1000');
  });
  test('retains a valid reviewed mirror start and passes its exact caps into a fully refreshed batch simulation', async () => {
    const s = setup();
    const previous = await s.prepare();
    s.chain.snapshot.mockResolvedValue({
      block_number: 11,
      block_hash: `0x${'22'.repeat(32)}`,
      block_timestamp: 1512
    });
    jest.mocked(Date.now).mockReturnValue(1512000);
    const refreshed = await s.prepare(previous);
    expect(refreshed.mirrorTerms.startTime).toBe(
      previous.mirrorTerms.startTime
    );
    expect(refreshed.mirrorTerms.endTime).toBe('1602');
    expect(refreshed.transaction.data).not.toBe(previous.transaction.data);
    expect(refreshed.intent).toEqual(previous.intent);
    expect(s.chain.simulate).toHaveBeenLastCalledWith(
      refreshed.transaction,
      previous.gas
    );
    expect(s.provider.getOrder).toHaveBeenCalledTimes(4);
  });
  test('replaces expired or future prior mirror starts rather than exposing an inactive buyer order', async () => {
    const s = setup();
    const previous = await s.prepare();
    for (const candidate of [
      { ...previous, validUntil: Date.now() },
      {
        ...previous,
        mirrorTerms: { ...previous.mirrorTerms, startTime: '1512' }
      }
    ]) {
      const refreshed = await s.prepare(candidate);
      expect(refreshed.mirrorTerms.startTime).toBe('1380');
    }
  });
  test('prepares Meme Lab editions and multiple destinations in the same complete batch', async () => {
    const s = setup(MEMELAB_CONTRACT);
    const prepared = await s.prepare();
    expect(prepared.intent.items[1].intent.asset).toMatchObject({
      contract: MEMELAB_CONTRACT,
      standard: 'ERC1155'
    });
    expect(prepared.intent.items[1].allocations).toEqual(
      s.f.intent.items[1].allocations
    );
    expect(prepared.transaction.value).toBe('300');
    expect(s.chain.simulate).toHaveBeenCalledTimes(1);
    s.chain.orderStatus.mockResolvedValue({
      cancelled: false,
      filled: BigInt(2),
      size: BigInt(3)
    });
    await expect(s.prepare()).rejects.toThrow('complete requested quantity');
    expect(s.chain.simulate).toHaveBeenCalledTimes(1);
  });
  test('quotes only exact selected orders and simulates their complete allocated transaction', async () => {
    const s = setup(),
      prepared = await s.prepare();
    expect(s.provider.getOrder).toHaveBeenCalledTimes(2);
    expect(s.provider.prepareFulfillment).toHaveBeenCalledTimes(2);
    expect(s.chain.simulate).toHaveBeenCalledTimes(1);
    expect(prepared.intent.items[1].allocations).toEqual(
      s.f.intent.items[1].allocations
    );
    expect(prepared.approvalTransactions).toEqual([]);
    expect(prepared.transaction.value).toBe('300');
    expect(prepared.validUntil).toBe(1590000);
    expect(prepared.mirrorTerms.endTime).toBe('1590');
  });
  test('caps review by the earliest seller expiry instead of the preparation work budget', async () => {
    jest.mocked(Date.now).mockReturnValue(2950000);
    const s = setup();
    s.chain.snapshot.mockResolvedValue({
      block_number: 10,
      block_hash: `0x${'11'.repeat(32)}`,
      block_timestamp: 2950
    });
    s.chain.rpc.getBlock.mockResolvedValue({
      hash: `0x${'11'.repeat(32)}`,
      timestamp: 2950,
      gasLimit: BigInt(60000000)
    });
    const prepared = await s.prepare();
    expect(prepared.mirrorTerms.endTime).toBe('3000');
    expect(prepared.validUntil).toBe(3000000);
    expect(s.chain.simulate).toHaveBeenCalledTimes(1);
  });
  test('still refuses authorizations with insufficient review time', async () => {
    jest.mocked(Date.now).mockReturnValue(2980000);
    const s = setup();
    await expect(s.prepare()).rejects.toThrow('expires too soon');
    expect(s.chain.simulate).not.toHaveBeenCalled();
  });
  test('never substitutes an exact order after its remaining quantity becomes insufficient', async () => {
    const s = setup();
    s.chain.orderStatus.mockResolvedValue({
      cancelled: false,
      filled: BigInt(2),
      size: BigInt(3)
    });
    await expect(s.prepare()).rejects.toThrow('complete requested quantity');
    expect(s.chain.simulate).not.toHaveBeenCalled();
  });
  test('requires external recipient acknowledgment', async () => {
    const s = setup();
    s.request.items[1].allocations[1].acknowledge_external_recipient = false;
    await expect(s.prepare()).rejects.toThrow('third-party');
    expect(s.provider.getOrder).not.toHaveBeenCalled();
  });
  test('rejects contract payer while allowing contract recipients through complete simulation', async () => {
    const s = setup();
    s.chain.rpc.getCode.mockResolvedValue('0x1234');
    await expect(s.prepare()).rejects.toThrow('paying smart wallet');
    expect(s.provider.getOrder).not.toHaveBeenCalled();
  });
  test('rejects changed exact native cost', async () => {
    const s = setup();
    s.request.items[1].amount_wei = '201';
    s.request.amount_wei = '301';
    await expect(s.prepare()).rejects.toThrow('price changed');
    expect(s.chain.simulate).not.toHaveBeenCalled();
  });
  test('fails the whole preparation when its complete simulation reverts', async () => {
    const s = setup();
    s.chain.simulate.mockRejectedValue(new Error('receiver rejected'));
    await expect(s.prepare()).rejects.toThrow('receiver rejected');
  });
  test.each(['16777217', '60000001'])(
    'rejects padded gas limit %s before exposing review',
    async (gas) => {
      const s = setup();
      s.chain.simulate.mockResolvedValue({
        gas_limit: gas,
        max_fee_per_gas: '10',
        gas_reserve_wei: (BigInt(gas) * BigInt(10)).toString()
      });
      await expect(s.prepare()).rejects.toThrow('transaction gas limit');
    }
  );
  test('rejects an RPC snapshot that becomes stale after quoting', async () => {
    const s = setup();
    s.chain.rpc.getBlock.mockResolvedValue({
      hash: `0x${'11'.repeat(32)}`,
      timestamp: 1000,
      gasLimit: BigInt(60000000)
    });
    await expect(s.prepare()).rejects.toThrow('snapshot is stale');
  });
});
