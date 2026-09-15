import { Interface } from 'ethers';
import type { JsonRpcProvider } from 'ethers';
import { buildMarketOrder } from './seaport.builder';
import { validateMarketOrder } from './quote-validation';
import {
  MARKET_SEAPORT,
  MARKET_WETH,
  MARKET_ZERO_ADDRESS
} from './seaport.registry';
import type { MarketTradeIntent } from './provider.types';
import type { MarketPrepared } from './market-preparation';
import {
  settledMarketOrderRemaining,
  settledMarketPayment,
  mergeMarketReceiptSupplement
} from './market-receipt-enrichment';

const maker = `0x${'11'.repeat(20)}`;
const actor = `0x${'22'.repeat(20)}`;
const hash = `0x${'33'.repeat(32)}`;
const state = new Interface([
  'function getOrderStatus(bytes32) view returns (bool,bool,uint256,uint256)'
]);

function partial(kind: 'BUY' | 'ACCEPT'): MarketPrepared {
  const original: MarketTradeIntent = {
    kind: kind === 'BUY' ? 'LIST' : 'OFFER',
    chainId: 1,
    wallet: maker,
    recipient: maker,
    asset: {
      contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
      tokenId: '60',
      standard: 'ERC1155'
    },
    quantity: '4',
    currency: kind === 'BUY' ? MARKET_ZERO_ADDRESS : MARKET_WETH,
    maxTotalWei: '400',
    minNetWei: '396',
    fees: [{ recipient: maker, amountWei: '4' }],
    includeOptionalCreatorFees: false,
    startTime: '1700000000',
    endTime: '1900000000'
  };
  const built = buildMarketOrder(original, '4', '5').order;
  const order = validateMarketOrder(original, {
    ...built.components,
    orderType: kind === 'BUY' ? 1 : 3
  });
  return {
    intent: {
      ...original,
      kind,
      wallet: actor,
      recipient: actor,
      quantity: '2',
      maxTotalWei: '201',
      minNetWei: '197',
      fees: [{ recipient: maker, amountWei: '2' }],
      order: { orderHash: order.orderHash, protocolAddress: MARKET_SEAPORT }
    },
    recipientInProfile: true,
    approvalTransactions: [],
    reviewOrder: order,
    snapshot: {
      block_number: 99,
      block_hash: hash,
      block_timestamp: 1800000000
    },
    feePolicyVersion: 'test'
  };
}

describe('safe receipt payment and whole-order availability', () => {
  it('keeps previously proven costs and source remainder when a later same-block read lacks supplemental fields', () => {
    const previous = partial('BUY');
    previous.receipt = {
      transactions: [
        {
          purpose: 'TRANSACTION',
          from: actor,
          transactionHash: hash,
          blockNumber: 100,
          blockHash: hash,
          blockTimestamp: 1800000000,
          status: 'SUCCESS',
          confirmation: 'CONFIRMED',
          gasUsed: '21000',
          effectiveGasPriceWei: '7',
          networkFeeWei: '147000'
        }
      ]
    };
    const oldSettlement = {
      filledQuantity: '2',
      remainingQuantity: '0',
      orderRemainingQuantity: '1',
      transactionHash: hash,
      blockHash: hash,
      blockNumber: 100
    };
    const stored = { ...previous, settlement: oldSettlement };
    previous.receipt.payment = settledMarketPayment(previous);
    const {
      gasUsed: _gas,
      effectiveGasPriceWei: _price,
      networkFeeWei: _cost,
      ...unavailable
    } = previous.receipt.transactions[0];
    const { orderRemainingQuantity: _remaining, ...settlement } = oldSettlement;
    const incoming = {
      ...previous,
      receipt: { transactions: [unavailable] },
      settlement
    };
    const enriched = mergeMarketReceiptSupplement(
      stored,
      incoming
    ) as typeof stored;
    expect(enriched.receipt?.transactions[0].networkFeeWei).toBe('147000');
    expect(enriched.settlement.orderRemainingQuantity).toBe('1');
    expect(enriched.receipt?.payment?.totalWei).toBe('200');
    const relocated = mergeMarketReceiptSupplement(stored, {
      ...incoming,
      receipt: {
        transactions: [{ ...unavailable, blockHash: `0x${'44'.repeat(32)}` }]
      }
    });
    expect(relocated.receipt?.transactions[0]).not.toHaveProperty(
      'networkFeeWei'
    );
  });
  it.each(['BUY', 'ACCEPT'] as const)(
    'uses the actual partial %s consideration rather than review bounds or full-order amounts',
    (kind) => {
      const result = settledMarketPayment(partial(kind));
      expect(result).toEqual({
        currency: kind === 'BUY' ? MARKET_ZERO_ADDRESS : MARKET_WETH,
        totalWei: '200',
        netWei: '198',
        fees: [{ recipient: maker, amountWei: '2' }],
        payoutWallet: kind === 'BUY' ? maker : actor
      });
      expect(result).not.toHaveProperty('networkFeeWei');
    }
  );
  it('never turns signed-listing consideration into actual proceeds before a receipt', () => {
    const prepared = partial('BUY');
    prepared.intent.kind = 'LIST';
    expect(settledMarketPayment(prepared)).toBeUndefined();
  });
  it.each(['BUY', 'ACCEPT'] as const)(
    'reports whole source %s remaining after other fills, pinned to the safe block',
    async (kind) => {
      const prepared = partial(kind);
      const call = jest
        .fn()
        .mockResolvedValue(
          state.encodeFunctionResult('getOrderStatus', [true, false, 3, 4])
        );
      const getBlock = jest.fn().mockResolvedValue({ hash });
      const rpc = { call, getBlock } as unknown as Pick<
        JsonRpcProvider,
        'call' | 'getBlock'
      >;
      const result = await settledMarketOrderRemaining(prepared, rpc, {
        number: 101,
        hash
      });
      expect(result.get(prepared.reviewOrder!.orderHash)).toBe('1');
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({ to: MARKET_SEAPORT, blockTag: 101 })
      );
      expect(getBlock).toHaveBeenCalledWith(101);
    }
  );
  it.each([
    [0, 0],
    [0, 4],
    [5, 4],
    [1, 3],
    [1, 4]
  ])(
    'omits uncorroborated or nonintegral status %s/%s without inventing zero remaining',
    async (filled, size) => {
      const call = jest
        .fn()
        .mockResolvedValue(
          state.encodeFunctionResult('getOrderStatus', [
            true,
            false,
            filled,
            size
          ])
        );
      const rpc = {
        call,
        getBlock: jest.fn().mockResolvedValue({ hash })
      } as unknown as Pick<JsonRpcProvider, 'call' | 'getBlock'>;
      expect(
        (
          await settledMarketOrderRemaining(partial('BUY'), rpc, {
            number: 101,
            hash
          })
        ).size
      ).toBe(0);
    }
  );
  it('discards availability on reorg or RPC failure, leaving core confirmation independent', async () => {
    const call = jest
      .fn()
      .mockResolvedValue(
        state.encodeFunctionResult('getOrderStatus', [true, false, 4, 4])
      );
    const rpc = {
      call,
      getBlock: jest.fn().mockResolvedValue({ hash: 'different' })
    } as unknown as Pick<JsonRpcProvider, 'call' | 'getBlock'>;
    expect(
      (
        await settledMarketOrderRemaining(partial('BUY'), rpc, {
          number: 101,
          hash
        })
      ).size
    ).toBe(0);
    call.mockRejectedValue(new Error('RPC unavailable'));
    expect(
      (
        await settledMarketOrderRemaining(partial('BUY'), rpc, {
          number: 101,
          hash
        })
      ).size
    ).toBe(0);
  });
});
