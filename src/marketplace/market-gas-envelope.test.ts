import { JsonRpcProvider } from 'ethers';
import { MarketChain } from '@/marketplace/market-chain';
import {
  marketGasFitsEnvelope,
  reviewedMarketGas
} from '@/marketplace/market-gas-envelope';
import {
  MarketGasEstimate,
  MarketTransaction
} from '@/marketplace/provider.types';

const transaction: MarketTransaction = {
  kind: 'TRANSACTION',
  chainId: 1,
  from: `0x${'11'.repeat(20)}`,
  to: `0x${'22'.repeat(20)}`,
  data: '0x1234',
  value: '652000000000000000',
  purpose: 'FULFILL'
};
const reviewed: MarketGasEstimate = {
  gas_limit: '182404',
  max_fee_per_gas: '88117402',
  gas_reserve_wei: '16072966594408'
};

function setup() {
  const rpc = {
    call: jest.fn().mockResolvedValue('0x'),
    estimateGas: jest.fn().mockResolvedValue(BigInt(160000)),
    getFeeData: jest.fn().mockResolvedValue({
      maxFeePerGas: BigInt(95601352),
      maxPriorityFeePerGas: BigInt(10000000)
    }),
    getBlock: jest.fn().mockResolvedValue({
      hash: `0x${'33'.repeat(32)}`,
      timestamp: Math.floor(Date.now() / 1000),
      baseFeePerGas: BigInt(42800676)
    }),
    getBalance: jest
      .fn()
      .mockResolvedValue(
        BigInt(transaction.value) + BigInt(reviewed.gas_reserve_wei)
      )
  };
  return { rpc, chain: new MarketChain(rpc as unknown as JsonRpcProvider) };
}

describe('stable reviewed gas envelope', () => {
  it('spends existing gas and EIP1559 headroom instead of requiring a new padded recommendation', async () => {
    const { chain, rpc } = setup();
    const result = await chain.simulate(transaction, reviewed);
    expect(result).toEqual(reviewed);
    expect(result).not.toBe(reviewed);
    expect(rpc.call).toHaveBeenCalledWith({
      from: transaction.from,
      to: transaction.to,
      data: transaction.data,
      value: BigInt(transaction.value)
    });
    expect(rpc.estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ data: transaction.data })
    );
    // The recomputed 192000 gas limit and 95601352 fee cap both exceed the
    // original ceilings, but the raw 160000 gas and 52800676 fee still fit.
    expect(rpc.getBalance).toHaveBeenCalledWith(transaction.from);
  });

  it('retains all exact caps when recommendations decrease, rather than ratcheting the next review downward', async () => {
    const { chain, rpc } = setup();
    rpc.estimateGas.mockResolvedValue(BigInt(100000));
    rpc.getFeeData.mockResolvedValue({
      maxFeePerGas: BigInt(20),
      maxPriorityFeePerGas: BigInt(1)
    });
    rpc.getBlock.mockResolvedValue({
      hash: '0x1',
      timestamp: Math.floor(Date.now() / 1000),
      baseFeePerGas: BigInt(5)
    });
    await expect(chain.simulate(transaction, reviewed)).resolves.toEqual(
      reviewed
    );
  });

  it.each(['gas', 'fee'] as const)(
    'returns a new review for a genuine %s requirement overrun',
    async (field) => {
      const { chain, rpc } = setup();
      rpc.getBalance.mockResolvedValue(
        BigInt(transaction.value) + BigInt('1000000000000000000')
      );
      if (field === 'gas')
        rpc.estimateGas.mockResolvedValue(
          BigInt(reviewed.gas_limit) + BigInt(1)
        );
      else
        rpc.getBlock.mockResolvedValue({
          hash: '0x1',
          timestamp: Math.floor(Date.now() / 1000),
          baseFeePerGas: BigInt(reviewed.max_fee_per_gas)
        });
      const result = await chain.simulate(transaction, reviewed);
      expect(
        BigInt(result[field === 'gas' ? 'gas_limit' : 'max_fee_per_gas'])
      ).toBeGreaterThan(
        BigInt(reviewed[field === 'gas' ? 'gas_limit' : 'max_fee_per_gas'])
      );
      expect(BigInt(result.gas_reserve_wei)).toBe(
        BigInt(result.gas_limit) * BigInt(result.max_fee_per_gas)
      );
      expect(reviewed.gas_limit).toBe('182404');
    }
  );

  it('does not emit a replacement ceiling below raw requirements when fee data crosses a block boundary', async () => {
    const { chain, rpc } = setup();
    rpc.getBalance.mockResolvedValue(
      BigInt(transaction.value) + BigInt('1000000000000000000')
    );
    rpc.getFeeData.mockResolvedValue({
      maxFeePerGas: BigInt(2),
      maxPriorityFeePerGas: BigInt(1)
    });
    rpc.getBlock.mockResolvedValue({
      hash: '0x1',
      timestamp: Math.floor(Date.now() / 1000),
      baseFeePerGas: BigInt(100000000)
    });
    const result = await chain.simulate(transaction, reviewed);
    expect(result.max_fee_per_gas).toBe('100000001');
  });

  it('leaves initial quoting unchanged and requires the complete padded reserve', async () => {
    const { chain, rpc } = setup();
    await expect(chain.simulate(transaction)).rejects.toMatchObject({
      code: 'ORDER_MISMATCH'
    });
    rpc.getBalance.mockResolvedValue(
      BigInt(transaction.value) + BigInt('1000000000000000000')
    );
    await expect(chain.simulate(transaction)).resolves.toEqual({
      gas_limit: '192000',
      max_fee_per_gas: '95601352',
      gas_reserve_wei: '18355459584000'
    });
    expect(rpc.getBlock).not.toHaveBeenCalled();
  });

  it('requires enough balance for the retained worst-case reserve even when current needs are smaller', async () => {
    const { chain, rpc } = setup();
    rpc.getBalance.mockResolvedValue(
      BigInt(transaction.value) + BigInt(reviewed.gas_reserve_wei) - BigInt(1)
    );
    await expect(chain.simulate(transaction, reviewed)).rejects.toMatchObject({
      code: 'ORDER_MISMATCH'
    });
  });

  it.each([
    'missing',
    'stale',
    'base-null',
    'base-negative',
    'priority-null',
    'priority-negative'
  ] as const)(
    'fails closed when current fee evidence is %s',
    async (failure) => {
      const { chain, rpc } = setup();
      const block = {
        hash: '0x1',
        timestamp: Math.floor(Date.now() / 1000),
        baseFeePerGas: BigInt(1)
      };
      if (failure === 'missing') rpc.getBlock.mockResolvedValue(null);
      else if (failure === 'stale')
        rpc.getBlock.mockResolvedValue({
          ...block,
          timestamp: block.timestamp - 121
        });
      else if (failure === 'base-null')
        rpc.getBlock.mockResolvedValue({ ...block, baseFeePerGas: null });
      else if (failure === 'base-negative')
        rpc.getBlock.mockResolvedValue({ ...block, baseFeePerGas: BigInt(-1) });
      else
        rpc.getFeeData.mockResolvedValue({
          maxFeePerGas: BigInt(95601352),
          maxPriorityFeePerGas: failure === 'priority-null' ? null : BigInt(-1)
        });
      await expect(chain.simulate(transaction, reviewed)).rejects.toMatchObject(
        { code: 'PROVIDER_UNAVAILABLE' }
      );
    }
  );

  it('accepts exact boundary requirements, including zero base fee and tip', async () => {
    const { chain, rpc } = setup();
    rpc.estimateGas.mockResolvedValue(BigInt(reviewed.gas_limit));
    rpc.getBlock.mockResolvedValue({
      hash: '0x1',
      timestamp: Math.floor(Date.now() / 1000),
      baseFeePerGas: BigInt(reviewed.max_fee_per_gas) - BigInt(10000000)
    });
    await expect(chain.simulate(transaction, reviewed)).resolves.toEqual(
      reviewed
    );
    expect(marketGasFitsEnvelope(BigInt(1), BigInt(0), reviewed)).toBe(true);
  });

  it.each(['0', '-1', '01', '1.5', '1e3', '9'.repeat(79)])(
    'rejects malformed saved cap %s',
    (value) => {
      expect(() =>
        marketGasFitsEnvelope(BigInt(1), BigInt(1), {
          ...reviewed,
          gas_limit: value
        })
      ).toThrow('reviewed network fee');
    }
  );
  it('rejects a reserve smaller than the authorized gas-limit/fee-cap product', () => {
    expect(() =>
      marketGasFitsEnvelope(BigInt(1), BigInt(1), {
        ...reviewed,
        gas_reserve_wei: '1'
      })
    ).toThrow('reviewed network fee');
  });
});

describe('gas authorization identity', () => {
  it('allows refreshed fulfillment authorization bytes without changing the cap', () => {
    expect(
      reviewedMarketGas(
        { ...transaction, data: '0xabcd' },
        transaction,
        reviewed
      )
    ).toBe(reviewed);
  });
  it.each(['from', 'to', 'value', 'purpose', 'approvalScope'] as const)(
    'does not reuse an envelope when %s changes',
    (field) => {
      const changed = {
        ...transaction,
        [field]: 'different'
      } as MarketTransaction;
      expect(reviewedMarketGas(changed, transaction, reviewed)).toBeUndefined();
    }
  );
  it.each(['APPROVE_NFT', 'APPROVE_CURRENCY', 'CANCEL'] as const)(
    'requires exact %s calldata before retaining gas limits',
    (purpose) => {
      const previous = { ...transaction, purpose, gas: reviewed };
      expect(reviewedMarketGas(previous, previous)).toBe(reviewed);
      expect(
        reviewedMarketGas({ ...previous, data: '0xabcd' }, previous)
      ).toBeUndefined();
    }
  );
});
