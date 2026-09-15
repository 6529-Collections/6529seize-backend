import type { JsonRpcProvider } from 'ethers';
import {
  appendMarketReceiptTransaction,
  confirmedMarketApprovalReceipts,
  marketReceiptTransaction,
  marketReceiptRead
} from './market-receipt-evidence';

const hash = `0x${'ab'.repeat(32)}`;
const payer = `0x${'cd'.repeat(20)}`;
const mined = {
  hash,
  blockNumber: 100,
  blockHash: hash,
  status: 1,
  gasUsed: BigInt('9007199254740993'),
  gasPrice: BigInt('1900000001')
};

describe('actual marketplace transaction cost evidence', () => {
  it('uses exact bigint receipt gas and effective price, retaining canonical time and payer', () => {
    expect(
      marketReceiptTransaction(mined, 1800000000, payer, 'TRANSACTION', 101)
    ).toEqual({
      purpose: 'TRANSACTION',
      from: payer,
      transactionHash: hash,
      blockNumber: 100,
      blockHash: hash,
      blockTimestamp: 1800000000,
      status: 'SUCCESS',
      confirmation: 'CONFIRMED',
      safeBlockNumber: 101,
      gasUsed: '9007199254740993',
      effectiveGasPriceWei: '1900000001',
      networkFeeWei: (mined.gasUsed * mined.gasPrice).toString()
    });
  });
  it.each([undefined, BigInt(-1)])(
    'omits all cost fields for missing or invalid effective price %s',
    (gasPrice) => {
      const result = marketReceiptTransaction(
        { ...mined, gasPrice },
        1800000000,
        payer,
        'TRANSACTION',
        101
      );
      expect(result).toMatchObject({ confirmation: 'CONFIRMED' });
      expect(result).not.toHaveProperty('networkFeeWei');
      expect(result).not.toHaveProperty('gasUsed');
    }
  );
  it('retains a genuine zero effective fee and distinguishes included/reverted transactions', () => {
    expect(
      marketReceiptTransaction(
        { ...mined, gasPrice: BigInt(0), status: 0 },
        1800000000,
        payer,
        'APPROVAL',
        99
      )
    ).toMatchObject({
      purpose: 'APPROVAL',
      confirmation: 'INCLUDED',
      status: 'REVERTED',
      networkFeeWei: '0'
    });
  });
  it.each([0, NaN, Infinity, -1, 1800000000.5])(
    'never invents an inclusion date from %s',
    (timestamp) => {
      expect(
        marketReceiptTransaction(mined, timestamp, payer, 'TRANSACTION')
      ).toBeUndefined();
    }
  );
  it('deduplicates the same known approval hash without dropping unrelated approvals', () => {
    const first = marketReceiptTransaction(
      mined,
      1800000000,
      payer,
      'APPROVAL'
    )!;
    const other = { ...first, transactionHash: `0x${'12'.repeat(32)}` };
    const confirmed = {
      ...first,
      confirmation: 'CONFIRMED' as const,
      safeBlockNumber: 110
    };
    expect(appendMarketReceiptTransaction([first, other], confirmed)).toEqual([
      other,
      confirmed
    ]);
    expect(first.confirmation).toBe('INCLUDED');
  });
  it('requires safe canonical approval blocks and preserves the first confirmation anchor', async () => {
    const entry = marketReceiptTransaction(
      mined,
      1800000000,
      payer,
      'APPROVAL',
      100
    )!;
    const getBlock = jest.fn().mockResolvedValue({ hash });
    const rpc = { getBlock } as unknown as Pick<JsonRpcProvider, 'getBlock'>;
    const entries = await confirmedMarketApprovalReceipts([entry], rpc, {
      number: 102,
      hash
    });
    expect(entries).toEqual([entry]);
    expect(getBlock.mock.calls).toEqual([[100], [102]]);
    getBlock.mockResolvedValue({ hash: 'reorganized' });
    expect(
      await confirmedMarketApprovalReceipts([entry], rpc, { number: 102, hash })
    ).toEqual([]);
  });
  it('never attributes unsafe, missing or reorganized approval evidence to final recorded cost', async () => {
    const entry = marketReceiptTransaction(
      mined,
      1800000000,
      payer,
      'APPROVAL'
    )!;
    const getBlock = jest.fn().mockResolvedValue(null);
    const rpc = { getBlock } as unknown as Pick<JsonRpcProvider, 'getBlock'>;
    expect(
      await confirmedMarketApprovalReceipts([entry], rpc, { number: 99, hash })
    ).toEqual([]);
    expect(
      await confirmedMarketApprovalReceipts([entry], rpc, { number: 102, hash })
    ).toEqual([]);
    getBlock
      .mockResolvedValueOnce({ hash })
      .mockResolvedValueOnce({ hash: 'new-fork' });
    expect(
      await confirmedMarketApprovalReceipts([entry], rpc, { number: 102, hash })
    ).toEqual([]);
  });
  it('retains historical confirmed cost on a missing block or timeout without upgrading included approvals', async () => {
    const confirmed = marketReceiptTransaction(
      mined,
      1800000000,
      payer,
      'APPROVAL',
      100
    )!;
    const included = {
      ...confirmed,
      transactionHash: `0x${'99'.repeat(32)}`,
      confirmation: 'INCLUDED' as const,
      safeBlockNumber: undefined
    };
    const getBlock = jest.fn().mockResolvedValue(null);
    const rpc = { getBlock } as unknown as Pick<JsonRpcProvider, 'getBlock'>;
    expect(
      await confirmedMarketApprovalReceipts([confirmed, included], rpc, {
        number: 102,
        hash
      })
    ).toEqual([confirmed]);
    getBlock.mockRejectedValue(new Error('RPC unavailable'));
    expect(
      await confirmedMarketApprovalReceipts([confirmed, included], rpc, {
        number: 102,
        hash
      })
    ).toEqual([confirmed]);
  });
  it('bounds supplemental reads and does not start them after the shared deadline', async () => {
    jest.useFakeTimers();
    try {
      const read = jest.fn(() => new Promise<never>(() => {}));
      const result = marketReceiptRead(read, Date.now() + 50);
      const assertion = expect(result).rejects.toThrow('timed out');
      await jest.advanceTimersByTimeAsync(50);
      await assertion;
      await expect(marketReceiptRead(read, Date.now())).rejects.toThrow(
        'timed out'
      );
      expect(read).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
