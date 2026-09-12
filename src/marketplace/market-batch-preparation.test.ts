import { collectingService } from '@/collecting/collecting.service';
import { MarketBatchPreparation } from '@/marketplace/market-batch-preparation';
import type { MarketChain } from '@/marketplace/market-chain';
import type { OpenSeaMarketplaceProvider } from '@/marketplace/provider.opensea';
import { MarketBatchPrepareRequest } from '@/marketplace/market-batch.schema';
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

function setup() {
  const f = marketBatchFixture();
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
  (collectingService.getCatalog as jest.Mock).mockResolvedValue({
    assets: f.intent.items.map((line) => ({
      asset_key: line.assetKey,
      contract: line.intent.asset.contract,
      token_id: line.intent.asset.tokenId,
      family: line.intent.asset.standard === 'ERC1155' ? 'memes' : 'gradients'
    }))
  });
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
  const prepare = () =>
    preparation.prepare(
      request,
      [BATCH_BUYER, BATCH_OWN],
      new AbortController().signal
    );
  return { f, request, provider, chain, prepare };
}

describe('atomic batch preparation', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(1500000);
    jest.clearAllMocks();
  });
  afterEach(() => jest.useRealTimers());
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
    jest.setSystemTime(2950000);
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
    jest.setSystemTime(2980000);
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
