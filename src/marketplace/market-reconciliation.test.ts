import { Interface } from 'ethers';
import type { MarketPrepared } from '@/marketplace/market-preparation';
import type { MarketOperationRow } from '@/marketplace/market-operations.db';
import {
  MarketReconcileDependencies,
  MarketReceiptEvidence,
  MarketTransactionEvidence,
  reconcileMarketOperation,
  validateMarketReceipt
} from '@/marketplace/market-reconciliation';
import {
  buildMarketFulfillment,
  buildMarketOrder
} from '@/marketplace/seaport.builder';
import {
  MARKET_SEAPORT,
  MARKET_WETH,
  MARKET_ZERO_ADDRESS,
  MARKET_ZERO_HASH
} from '@/marketplace/seaport.registry';
import { MARKET_SEAPORT_EVENTS } from '@/marketplace/seaport.events';
import { MarketTradeIntent } from '@/marketplace/provider.types';

const maker = '0x1111111111111111111111111111111111111111';
const buyer = '0x2222222222222222222222222222222222222222';
const recipient = '0x3333333333333333333333333333333333333333';
const contract = '0x33fd426905f149f8376e227d0c9d3340aad17af1';
const txHash = '0x' + '1'.repeat(64),
  blockHash = '0x' + '2'.repeat(64);
const listing: MarketTradeIntent = {
  kind: 'LIST',
  chainId: 1,
  wallet: maker,
  recipient: maker,
  asset: { contract, tokenId: '56', standard: 'ERC1155' },
  quantity: '2',
  currency: MARKET_ZERO_ADDRESS,
  maxTotalWei: '200',
  minNetWei: '198',
  fees: [{ recipient: maker, amountWei: '2' }],
  includeOptionalCreatorFees: false,
  startTime: '1700000000',
  endTime: '1900000000'
};

function fixture() {
  const order = buildMarketOrder(listing, '4', '5').order;
  const intent = {
    ...listing,
    kind: 'BUY' as const,
    wallet: buyer,
    recipient,
    order: { protocolAddress: MARKET_SEAPORT, orderHash: order.orderHash }
  };
  const transaction = buildMarketFulfillment(intent, order, '0x1234');
  const prepared: MarketPrepared = {
    intent,
    recipientInProfile: false,
    approvalTransactions: [],
    transaction,
    reviewOrder: order,
    snapshot: {
      block_number: 90,
      block_hash: blockHash,
      block_timestamp: 1800000000
    },
    feePolicyVersion: MARKET_ZERO_HASH
  };
  const fill = MARKET_SEAPORT_EVENTS.encodeEventLog(
    MARKET_SEAPORT_EVENTS.getEvent('OrderFulfilled')!,
    [
      order.orderHash,
      maker,
      MARKET_ZERO_ADDRESS,
      recipient,
      [[3, contract, '56', '2']],
      [
        [0, MARKET_ZERO_ADDRESS, '0', '198', maker],
        [0, MARKET_ZERO_ADDRESS, '0', '2', maker]
      ]
    ]
  );
  const token = new Interface([
    'event TransferSingle(address indexed operator,address indexed from,address indexed to,uint256 id,uint256 value)'
  ]);
  const transfer = token.encodeEventLog(token.getEvent('TransferSingle')!, [
    MARKET_SEAPORT,
    maker,
    recipient,
    '56',
    '2'
  ]);
  const receipt: MarketReceiptEvidence = {
    hash: txHash,
    blockNumber: 100,
    blockHash,
    status: 1,
    logs: [
      { address: MARKET_SEAPORT, ...fill },
      { address: contract, ...transfer }
    ]
  };
  const submitted: MarketTransactionEvidence = {
    hash: txHash,
    from: buyer,
    to: MARKET_SEAPORT,
    data: transaction.data,
    value: BigInt(transaction.value),
    chainId: BigInt(1)
  };
  const row = {
    id: 'operation',
    state: 'SUBMITTED',
    prepared_json: prepared,
    request_json: { kind: 'BUY' },
    transaction_hash: txHash,
    liability_wei: '200'
  } as MarketOperationRow;
  return { prepared, receipt, submitted, row };
}
function deps(value: ReturnType<typeof fixture>, safeNumber = 99) {
  const transition = jest.fn().mockResolvedValue(undefined);
  const rpc = {
    getTransaction: jest.fn().mockResolvedValue(value.submitted),
    getTransactionReceipt: jest.fn().mockResolvedValue(value.receipt),
    getBlock: jest
      .fn()
      .mockImplementation(async (tag) =>
        tag === 'safe'
          ? { number: safeNumber, hash: blockHash, timestamp: 1800000000 }
          : { number: 100, hash: blockHash, timestamp: 1800000000 }
      ),
    call: jest.fn()
  };
  return { rpc, transition } as unknown as MarketReconcileDependencies;
}

describe('safe marketplace reconciliation', () => {
  it('requires both exact OrderFulfilled flows and actual NFT delivery', () => {
    const f = fixture();
    expect(
      validateMarketReceipt(f.prepared, 'BUY', f.submitted, f.receipt)
        .filledQuantity
    ).toBe('2');
    expect(() =>
      validateMarketReceipt(f.prepared, 'BUY', f.submitted, {
        ...f.receipt,
        logs: f.receipt.logs.slice(0, 1)
      })
    ).toThrow(/delivery/);
    expect(() =>
      validateMarketReceipt(
        f.prepared,
        'BUY',
        { ...f.submitted, value: BigInt(201) },
        f.receipt
      )
    ).toThrow(/reviewed/);
    expect(() =>
      validateMarketReceipt(f.prepared, 'BUY', f.submitted, {
        ...f.receipt,
        logs: [...f.receipt.logs, f.receipt.logs[0]]
      })
    ).toThrow(/exactly one/);
    expect(() =>
      validateMarketReceipt(
        {
          ...f.prepared,
          snapshot: { ...f.prepared.snapshot, block_number: 100 }
        },
        'BUY',
        f.submitted,
        f.receipt
      )
    ).toThrow(/predates/);
  });
  it('does not release a mined fill until its canonical block is safe', async () => {
    const f = fixture(),
      d = deps(f);
    await reconcileMarketOperation(f.row, d);
    expect(d.transition).toHaveBeenCalledWith(
      'operation',
      ['SUBMITTED'],
      'MINED',
      expect.not.objectContaining({ liabilityWei: '0' })
    );
    const safe = deps(f, 100);
    await reconcileMarketOperation(f.row, safe);
    expect(safe.transition).toHaveBeenCalledWith(
      'operation',
      ['SUBMITTED'],
      'CONFIRMED',
      expect.objectContaining({
        liabilityWei: '0',
        prepared: expect.objectContaining({
          settlement: expect.objectContaining({
            safeBlockNumber: 100,
            filledQuantity: '2'
          })
        })
      })
    );
  });
  it('retains liability when a receipt is missing or its block was reorganized', async () => {
    const f = fixture(),
      d = deps(f, 100);
    (d.rpc.getBlock as jest.Mock).mockImplementation(async (tag) => ({
      number: 100,
      hash: tag === 'safe' ? blockHash : MARKET_ZERO_HASH,
      timestamp: 1800000000
    }));
    await reconcileMarketOperation(f.row, d);
    expect(d.transition).toHaveBeenCalledWith(
      'operation',
      ['SUBMITTED'],
      'UNKNOWN',
      { errorCode: 'RECEIPT_REORG' }
    );
    const missing = deps(f, 100);
    (missing.rpc.getTransactionReceipt as jest.Mock).mockResolvedValue(null);
    await reconcileMarketOperation({ ...f.row, state: 'MINED' }, missing);
    expect(missing.transition).toHaveBeenCalledWith(
      'operation',
      ['MINED'],
      'UNKNOWN',
      {}
    );
  });
  it('does not release a reverted transaction before its block is safe', async () => {
    const f = fixture();
    f.receipt.status = 0;
    const unsafe = deps(f);
    await reconcileMarketOperation(f.row, unsafe);
    expect(unsafe.transition).toHaveBeenCalledWith(
      'operation',
      ['SUBMITTED'],
      'MINED',
      { errorCode: 'TRANSACTION_REVERTED' }
    );
    const safe = deps(f, 100);
    await reconcileMarketOperation(f.row, safe);
    expect(safe.transition).toHaveBeenCalledWith(
      'operation',
      ['SUBMITTED'],
      'FAILED',
      { errorCode: 'TRANSACTION_REVERTED', liabilityWei: '0' }
    );
  });
  it('uses safe on-chain partial fractions without prematurely invalidating a newer maker counter', async () => {
    const f = fixture();
    const intent = {
      ...listing,
      kind: 'OFFER' as const,
      currency: MARKET_WETH,
      recipient: maker
    };
    const signedOrder = buildMarketOrder(intent, '4', '5');
    const prepared = {
      ...f.prepared,
      intent,
      transaction: undefined,
      reviewOrder: undefined,
      signedOrder
    };
    const row = {
      ...f.row,
      state: 'LIVE' as const,
      transaction_hash: null,
      order_hash: signedOrder.order.orderHash,
      prepared_json: prepared
    };
    const d = deps(f, 100);
    const state = new Interface([
      'function getCounter(address) view returns (uint256)',
      'function getOrderStatus(bytes32) view returns (bool,bool,uint256,uint256)'
    ]);
    (d.rpc.call as jest.Mock).mockImplementation(async (request) =>
      request.data.slice(0, 10) === state.getFunction('getCounter')!.selector
        ? state.encodeFunctionResult('getCounter', ['3'])
        : state.encodeFunctionResult('getOrderStatus', [false, false, '1', '2'])
    );
    await reconcileMarketOperation(row, d);
    expect(d.transition).toHaveBeenCalledWith(
      'operation',
      ['LIVE'],
      'LIVE',
      expect.objectContaining({
        liabilityWei: '100',
        prepared: expect.objectContaining({
          settlement: expect.objectContaining({
            filledQuantity: '1',
            remainingQuantity: '1'
          })
        })
      })
    );
    expect(d.rpc.call).toHaveBeenCalledWith(
      expect.objectContaining({ blockTag: 100 })
    );
  });
  it('releases signed liabilities only for safe expiry, cancellation, counter invalidation or complete fills', async () => {
    const f = fixture(),
      intent = {
        ...listing,
        kind: 'OFFER' as const,
        currency: MARKET_WETH,
        recipient: maker
      };
    const signedOrder = buildMarketOrder(intent, '4', '5');
    const row = {
      ...f.row,
      state: 'UNKNOWN' as const,
      transaction_hash: null,
      order_hash: signedOrder.order.orderHash,
      prepared_json: {
        ...f.prepared,
        intent,
        transaction: undefined,
        reviewOrder: undefined,
        signedOrder
      }
    };
    const state = new Interface([
      'function getCounter(address) view returns (uint256)',
      'function getOrderStatus(bytes32) view returns (bool,bool,uint256,uint256)'
    ]);
    for (const [counter, cancelled, filled, size, timestamp, expected] of [
      ['4', false, '0', '0', 1900000000, 'EXPIRED'],
      ['5', false, '0', '0', 1800000000, 'CANCELLED'],
      ['4', true, '0', '0', 1800000000, 'CANCELLED'],
      ['4', false, '2', '2', 1800000000, 'CONFIRMED']
    ] as const) {
      const d = deps(f, 100);
      (d.rpc.getBlock as jest.Mock).mockResolvedValue({
        number: 100,
        hash: blockHash,
        timestamp
      });
      (d.rpc.call as jest.Mock).mockImplementation(async (request) =>
        request.data.slice(0, 10) === state.getFunction('getCounter')!.selector
          ? state.encodeFunctionResult('getCounter', [counter])
          : state.encodeFunctionResult('getOrderStatus', [
              false,
              cancelled,
              filled,
              size
            ])
      );
      await reconcileMarketOperation(row, d);
      expect(d.transition).toHaveBeenCalledWith(
        'operation',
        ['UNKNOWN'],
        expected,
        expect.objectContaining({ liabilityWei: '0' })
      );
    }
  });
  it('does not release a signed offer on an RPC timeout', async () => {
    const f = fixture(),
      intent = {
        ...listing,
        kind: 'OFFER' as const,
        currency: MARKET_WETH,
        recipient: maker
      };
    const d = deps(f);
    (d.rpc.getBlock as jest.Mock).mockRejectedValue(
      new Error('temporarily unavailable')
    );
    await reconcileMarketOperation(
      {
        ...f.row,
        state: 'LIVE',
        transaction_hash: null,
        prepared_json: {
          ...f.prepared,
          intent,
          signedOrder: buildMarketOrder(intent, '4', '5')
        }
      },
      d
    );
    expect(d.transition).not.toHaveBeenCalled();
  });
});
