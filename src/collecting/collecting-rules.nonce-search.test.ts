import { nonceTransactionOnChain } from './collecting-rules.nonce-search';

const WALLET = '0x00000000000000000000000000000000000000b4';
const OTHER = '0x00000000000000000000000000000000000000b5';
const HASH = `0x${'ef'.repeat(32)}`;

/** A chain where WALLET's nonce 4 was used in block `at`; safe is block 90. */
function chain(at: number | null) {
  const calls: unknown[] = [];
  return {
    calls,
    rpc: {
      getBlock: jest.fn(async (tag: unknown, prefetch?: boolean) => {
        calls.push(['getBlock', tag]);
        if (tag === 'safe') return { number: 90 };
        return prefetch
          ? {
              number: tag,
              prefetchedTransactions: [
                {
                  hash: `0x${'aa'.repeat(32)}`,
                  from: OTHER,
                  to: OTHER,
                  value: BigInt(0),
                  nonce: 4
                },
                ...(tag === at
                  ? [
                      {
                        hash: HASH.toUpperCase().replace('0X', '0x'),
                        from: WALLET.toUpperCase().replace('0X', '0x'),
                        to: OTHER,
                        value: BigInt(1),
                        nonce: 4
                      }
                    ]
                  : [])
              ]
            }
          : null;
      }),
      getTransactionCount: jest.fn(async (_wallet: string, block: unknown) =>
        at !== null && typeof block === 'number' && block >= at ? 5 : 4
      ),
      getTransactionReceipt: jest.fn(async () => ({
        status: 1,
        gasUsed: BigInt(21_000),
        gasPrice: BigInt(2),
        logs: []
      }))
    }
  };
}

describe('nonceTransactionOnChain', () => {
  it('finds the transaction that used the nonce, by halving to its block', async () => {
    const { rpc } = chain(37);
    expect(await nonceTransactionOnChain(rpc as never, WALLET, 4)).toEqual({
      hash: HASH,
      transaction: {
        from: WALLET.toUpperCase().replace('0X', '0x'),
        to: OTHER,
        value: BigInt(1),
        nonce: 4
      },
      receipt: {
        status: 1,
        gasUsed: BigInt(21_000),
        gasPrice: BigInt(2),
        logs: []
      }
    });
    expect(rpc.getBlock).toHaveBeenCalledWith(37, true);
    // log2 of 90 blocks, and the safe block.
    expect(rpc.getTransactionCount.mock.calls.length).toBeLessThanOrEqual(9);
  });

  it('finds nothing while the nonce is unused on the safe block', async () => {
    const { rpc } = chain(null);
    expect(await nonceTransactionOnChain(rpc as never, WALLET, 4)).toBeNull();
    expect(rpc.getTransactionCount).toHaveBeenCalledWith(WALLET, 90);
  });
});
