import { ethers } from 'ethers';
import {
  Eip1271Provider,
  ethereumBlockAt,
  pinnedEip1271Verifier
} from '@/profile-cms/chain/profile-cms-eip1271-pinned';
import { EIP1271_ABI } from '@/profile-cms/profile-cms-signing';

const SAFE = '0x0000000000000000000000000000000000000001';
const iface = new ethers.Interface(EIP1271_ABI);

/** Blocks every 12 s from t = 1_000_000 s; block n at 1_000_000 + 12n. */
function fakeChain(
  latest: number,
  answer: (blockTag: number) => string = () => '0x1626ba7e'
) {
  const calls: { method: string; blockTag?: number }[] = [];
  const provider: Eip1271Provider = {
    getBlockNumber: async () => latest,
    getBlock: async (block) => {
      calls.push({ method: 'getBlock' });
      return block <= latest
        ? { number: block, timestamp: 1_000_000 + 12 * block }
        : null;
    },
    getCode: async (_address, blockTag) => {
      calls.push({ method: 'getCode', blockTag });
      return '0x6080';
    },
    call: async ({ blockTag }) => {
      calls.push({ method: 'call', blockTag });
      return iface.encodeFunctionResult('isValidSignature', [
        answer(blockTag).padEnd(10, '0')
      ]);
    }
  };
  return { provider, calls };
}

describe('pinned EIP-1271 checks', () => {
  it.each([
    [1_000_000_000, 0],
    [1_000_011_999, 0],
    [1_000_012_000, 1],
    [1_000_600_000, 50],
    [9_999_999_999_999, 1_000]
  ])('finds the last block at or before %d ms: %d', async (timeMs, block) => {
    const { provider } = fakeChain(1_000);
    expect(await ethereumBlockAt(provider, timeMs)).toBe(block);
  });

  it('asks the code and the signature at the block of the change', async () => {
    const { provider, calls } = fakeChain(1_000, (blockTag) =>
      blockTag === 50 ? '0x1626ba7e' : '0xffffffff'
    );
    const verifier = pinnedEip1271Verifier(1_000_600_000, () => provider);
    expect(
      await verifier.hasContractCode({ contractAddress: SAFE, chainId: 1 })
    ).toBe(true);
    expect(
      await verifier.isValidSignature({
        contractAddress: SAFE,
        chainId: 1,
        messageHash: `0x${'ab'.repeat(32)}`,
        signature: '0x1234'
      })
    ).toBe(true);
    expect(
      calls
        .filter((call) => call.method !== 'getBlock')
        .map((call) => [call.method, call.blockTag])
    ).toEqual([
      ['getCode', 50],
      ['call', 50]
    ]);
  });

  it('refuses a signature the Safe did not accept at that block', async () => {
    const { provider } = fakeChain(1_000, () => '0xffffffff');
    const verifier = pinnedEip1271Verifier(1_000_600_000, () => provider);
    expect(
      await verifier.isValidSignature({
        contractAddress: SAFE,
        chainId: 1,
        messageHash: `0x${'ab'.repeat(32)}`,
        signature: '0x1234'
      })
    ).toBe(false);
  });
});
