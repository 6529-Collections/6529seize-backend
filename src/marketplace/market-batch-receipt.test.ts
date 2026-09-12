import { Interface } from 'ethers';
import { marketBatchFixture } from '@/marketplace/market-batch.test-fixture';
import { MarketBatchPrepared } from '@/marketplace/market-batch.types';
import { buildMarketBatchTransaction } from '@/marketplace/seaport-batch.builder';
import { MARKET_SEAPORT_EVENTS } from '@/marketplace/seaport.events';
import {
  MARKET_SEAPORT,
  MARKET_ZERO_ADDRESS,
  marketSpender
} from '@/marketplace/seaport.registry';
import {
  MARKET_BATCH_RECEIPT_EVENTS,
  validateMarketBatchReceipt
} from '@/marketplace/market-batch-receipt';
import {
  MarketReceiptEvidence,
  MarketTransactionEvidence,
  MarketReconcileDependencies,
  reconcileMarketOperation
} from '@/marketplace/market-reconciliation';
import type { MarketOperationRow } from '@/marketplace/market-operations.db';

function log(
  abi: Interface,
  name: string,
  args: readonly unknown[],
  address = MARKET_SEAPORT
) {
  return { address, ...abi.encodeEventLog(abi.getEvent(name)!, args) };
}

export function batchReceiptFixture() {
  const { intent, materials, terms } = marketBatchFixture();
  const prepared: MarketBatchPrepared = {
    intent,
    mirrorTerms: terms,
    reviewOrders: materials.map(({ order }) => order),
    approvalTransactions: [],
    transaction: buildMarketBatchTransaction(intent, materials, terms),
    snapshot: {
      block_number: 10,
      block_hash: `0x${'11'.repeat(32)}`,
      block_timestamp: 1500
    },
    feePolicyVersion: 'EXACT_SELECTED_SIGNED_ORDERS',
    validUntil: 2000000,
    gas: {
      gas_limit: '500000',
      max_fee_per_gas: '10',
      gas_reserve_wei: '5000000'
    }
  };
  const hash = `0x${'aa'.repeat(32)}`,
    mirrorHash = `0x${'bb'.repeat(32)}`;
  const transaction: MarketTransactionEvidence = {
    hash,
    from: intent.wallet,
    to: MARKET_SEAPORT,
    data: prepared.transaction.data,
    value: BigInt(intent.totalWei),
    chainId: BigInt(1)
  };
  const logs = materials.map(({ order }, index) => {
    const c = order.components;
    const item = (i: (typeof c.offer)[number]) => [
      i.itemType,
      i.token,
      i.identifierOrCriteria,
      (
        (BigInt(i.startAmount) * BigInt(intent.items[index].intent.quantity)) /
        BigInt(c.offer[0].startAmount)
      ).toString()
    ];
    return log(MARKET_SEAPORT_EVENTS, 'OrderFulfilled', [
      order.orderHash,
      c.offerer,
      c.zone,
      intent.wallet,
      c.offer.map(item),
      c.consideration.map((i) => [...item(i), i.recipient])
    ]);
  });
  const allocations = intent.items.flatMap((line) =>
    line.allocations.map((a) => [
      line.intent.asset.standard === 'ERC721' ? 2 : 3,
      line.intent.asset.contract,
      line.intent.asset.tokenId,
      a.quantity,
      a.recipient
    ])
  );
  logs.push(
    log(MARKET_SEAPORT_EVENTS, 'OrderFulfilled', [
      mirrorHash,
      intent.wallet,
      MARKET_ZERO_ADDRESS,
      intent.wallet,
      [[0, MARKET_ZERO_ADDRESS, '0', intent.totalWei]],
      allocations
    ])
  );
  logs.push(
    log(MARKET_BATCH_RECEIPT_EVENTS, 'OrdersMatched', [
      [...materials.map((m) => m.order.orderHash), mirrorHash]
    ])
  );
  intent.items.forEach((line, index) => {
    const c = materials[index].order.components;
    line.allocations.forEach((a) =>
      logs.push(
        line.intent.asset.standard === 'ERC721'
          ? log(
              MARKET_BATCH_RECEIPT_EVENTS,
              'Transfer',
              [c.offerer, a.recipient, line.intent.asset.tokenId],
              line.intent.asset.contract
            )
          : log(
              MARKET_BATCH_RECEIPT_EVENTS,
              'TransferSingle',
              [
                marketSpender(c.conduitKey),
                c.offerer,
                a.recipient,
                line.intent.asset.tokenId,
                a.quantity
              ],
              line.intent.asset.contract
            )
      )
    );
  });
  const receipt: MarketReceiptEvidence = {
    hash,
    blockNumber: 11,
    blockHash: `0x${'cc'.repeat(32)}`,
    status: 1,
    logs
  };
  return { prepared, transaction, receipt, logs, mirrorHash };
}

describe('exact atomic batch receipts', () => {
  test('requires all seller fills, buyer mirror and exact split deliveries', () => {
    const { prepared, transaction, receipt } = batchReceiptFixture();
    expect(
      validateMarketBatchReceipt(prepared, transaction, receipt)
    ).toMatchObject({
      outcome: 'ALL_SELECTED',
      items: [
        { filledQuantity: '1' },
        {
          filledQuantity: '2',
          allocations: [{ quantity: '1' }, { quantity: '1' }]
        }
      ]
    });
  });
  test.each([0, 1, 2, 3, 4, 5, 6])(
    'rejects missing receipt evidence at %s',
    (index) => {
      const f = batchReceiptFixture();
      f.logs.splice(index, 1);
      expect(() =>
        validateMarketBatchReceipt(f.prepared, f.transaction, f.receipt)
      ).toThrow();
    }
  );
  test('rejects an additional delivery or duplicate fill', () => {
    const f = batchReceiptFixture();
    f.logs.push(f.logs[5]);
    expect(() =>
      validateMarketBatchReceipt(f.prepared, f.transaction, f.receipt)
    ).toThrow('NFT delivery');
  });
  test('rejects changed recipient even when the matching event otherwise succeeds', () => {
    const f = batchReceiptFixture(),
      line = f.prepared.intent.items[1];
    f.logs[5] = log(
      MARKET_BATCH_RECEIPT_EVENTS,
      'TransferSingle',
      [
        marketSpender(f.prepared.reviewOrders[1].components.conduitKey),
        f.prepared.reviewOrders[1].components.offerer,
        line.allocations[1].recipient,
        line.intent.asset.tokenId,
        '1'
      ],
      line.intent.asset.contract
    );
    expect(() =>
      validateMarketBatchReceipt(f.prepared, f.transaction, f.receipt)
    ).toThrow('NFT delivery');
  });
  test('rejects a wrong ERC1155 operator', () => {
    const f = batchReceiptFixture(),
      line = f.prepared.intent.items[1];
    f.logs[5] = log(
      MARKET_BATCH_RECEIPT_EVENTS,
      'TransferSingle',
      [
        f.prepared.intent.wallet,
        f.prepared.reviewOrders[1].components.offerer,
        line.allocations[0].recipient,
        line.intent.asset.tokenId,
        '1'
      ],
      line.intent.asset.contract
    );
    expect(() =>
      validateMarketBatchReceipt(f.prepared, f.transaction, f.receipt)
    ).toThrow();
  });
  test('rejects substituted OrdersMatched membership', () => {
    const f = batchReceiptFixture();
    f.logs[3] = log(MARKET_BATCH_RECEIPT_EVENTS, 'OrdersMatched', [
      [f.mirrorHash, ...f.prepared.reviewOrders.map((o) => o.orderHash)]
    ]);
    expect(() =>
      validateMarketBatchReceipt(f.prepared, f.transaction, f.receipt)
    ).toThrow('OrdersMatched');
  });
  test.each(['value', 'data', 'from', 'chainId'] as const)(
    'binds transaction %s',
    (field) => {
      const f = batchReceiptFixture();
      if (field === 'value' || field === 'chainId')
        f.transaction[field] += BigInt(1);
      else f.transaction[field] += '00';
      expect(() =>
        validateMarketBatchReceipt(f.prepared, f.transaction, f.receipt)
      ).toThrow();
    }
  );
  test('accepts TransferBatch evidence with the same exact ledger', () => {
    const f = batchReceiptFixture(),
      line = f.prepared.intent.items[1],
      c = f.prepared.reviewOrders[1].components;
    f.logs[5] = log(
      MARKET_BATCH_RECEIPT_EVENTS,
      'TransferBatch',
      [
        marketSpender(c.conduitKey),
        c.offerer,
        line.allocations[0].recipient,
        [line.intent.asset.tokenId],
        ['1']
      ],
      line.intent.asset.contract
    );
    expect(
      validateMarketBatchReceipt(f.prepared, f.transaction, f.receipt).outcome
    ).toBe('ALL_SELECTED');
  });
  test.each([
    [10, 'MINED'],
    [11, 'CONFIRMED']
  ])('requires safe inclusion at %s before %s', async (safe, state) => {
    const f = batchReceiptFixture();
    const transition = jest.fn();
    const deps: MarketReconcileDependencies = {
      transition,
      rpc: {
        getTransaction: jest.fn().mockResolvedValue(f.transaction),
        getTransactionReceipt: jest.fn().mockResolvedValue(f.receipt),
        getBlock: jest.fn(async (tag) => ({
          number: tag === 'safe' ? safe : 11,
          hash: f.receipt.blockHash
        })),
        call: jest.fn()
      } as unknown as MarketReconcileDependencies['rpc']
    };
    await reconcileMarketOperation(
      {
        id: 'batch',
        state: 'SUBMITTED',
        request_json: { kind: 'BUY_BATCH' },
        prepared_json: f.prepared,
        transaction_hash: f.receipt.hash,
        liability_wei: '0'
      } as MarketOperationRow,
      deps
    );
    expect(transition).toHaveBeenCalledWith(
      'batch',
      ['SUBMITTED'],
      state,
      expect.objectContaining({
        prepared: expect.objectContaining({
          settlement: expect.objectContaining({ outcome: 'ALL_SELECTED' })
        })
      })
    );
  });
  test.each(['missing-transfer', 'reorg', 'rpc-outage'])(
    'keeps recovery uncertain after %s',
    async (failure) => {
      const f = batchReceiptFixture();
      if (failure === 'missing-transfer') f.logs.pop();
      const transition = jest.fn();
      const deps: MarketReconcileDependencies = {
        transition,
        rpc: {
          getTransaction: jest.fn().mockResolvedValue(f.transaction),
          getTransactionReceipt: jest.fn().mockResolvedValue(f.receipt),
          getBlock: jest.fn(async (tag) => {
            if (failure === 'rpc-outage') throw new Error('RPC unavailable');
            return {
              number: tag === 'safe' ? 12 : 11,
              hash:
                failure === 'reorg'
                  ? `0x${'dd'.repeat(32)}`
                  : f.receipt.blockHash
            };
          }),
          call: jest.fn()
        } as unknown as MarketReconcileDependencies['rpc']
      };
      await reconcileMarketOperation(
        {
          id: 'batch',
          state: 'SUBMITTED',
          request_json: { kind: 'BUY_BATCH' },
          prepared_json: f.prepared,
          transaction_hash: f.receipt.hash,
          liability_wei: '0'
        } as MarketOperationRow,
        deps
      );
      if (failure === 'rpc-outage') expect(transition).not.toHaveBeenCalled();
      else
        expect(transition).toHaveBeenCalledWith(
          'batch',
          ['SUBMITTED'],
          'UNKNOWN',
          expect.anything()
        );
    }
  );
});
