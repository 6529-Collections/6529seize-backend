import { ethers } from 'ethers';
import { getRpcProvider } from '@/rpc-provider';
import {
  EIP1271_ABI,
  EIP1271_MAGIC_VALUE,
  Eip1271SignatureVerifier,
  getRpcNetwork
} from '@/profile-cms/profile-cms-signing';

/** The few provider calls a pinned check needs. */
export interface Eip1271Provider {
  getBlockNumber(): Promise<number>;
  getBlock(
    block: number
  ): Promise<{ readonly number: number; readonly timestamp: number } | null>;
  getCode(address: string, blockTag: number): Promise<string>;
  call(tx: {
    readonly to: string;
    readonly data: string;
    readonly blockTag: number;
  }): Promise<string>;
}

const iface = new ethers.Interface(EIP1271_ABI);

/**
 * A Safe (EIP-1271) check at the last Ethereum block at or before `timeMs`,
 * the time a ProfileDoc change named the publication. A rebuild later asks
 * the same block, so a Safe whose owners changed since gives the same answer.
 */
export function pinnedEip1271Verifier(
  timeMs: number,
  providerFor: (chainId: number) => Eip1271Provider = (chainId) =>
    getRpcProvider(getRpcNetwork(chainId)) as unknown as Eip1271Provider
): Eip1271SignatureVerifier {
  const blocks = new Map<number, Promise<number>>();
  const blockFor = (chainId: number, provider: Eip1271Provider) => {
    let block = blocks.get(chainId);
    if (!block) {
      block = ethereumBlockAt(provider, timeMs);
      blocks.set(chainId, block);
    }
    return block;
  };
  return {
    async hasContractCode({ contractAddress, chainId }) {
      const provider = providerFor(chainId);
      const code = await provider.getCode(
        contractAddress,
        await blockFor(chainId, provider)
      );
      return code !== '0x';
    },
    async isValidSignature({
      contractAddress,
      chainId,
      messageHash,
      signature
    }) {
      const provider = providerFor(chainId);
      const result = await provider.call({
        to: contractAddress,
        data: iface.encodeFunctionData('isValidSignature', [
          messageHash,
          signature
        ]),
        blockTag: await blockFor(chainId, provider)
      });
      const [magic] = iface.decodeFunctionResult('isValidSignature', result);
      return String(magic).toLowerCase() === EIP1271_MAGIC_VALUE;
    }
  };
}

/** The highest block whose timestamp is at or before `timeMs`. */
export async function ethereumBlockAt(
  provider: Pick<Eip1271Provider, 'getBlockNumber' | 'getBlock'>,
  timeMs: number
): Promise<number> {
  const target = Math.floor(timeMs / 1000);
  let high = await provider.getBlockNumber();
  const latest = await timestampOf(provider, high);
  if (latest <= target) {
    return high;
  }
  let low = 0;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if ((await timestampOf(provider, middle)) <= target) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

async function timestampOf(
  provider: Pick<Eip1271Provider, 'getBlock'>,
  block: number
): Promise<number> {
  const found = await provider.getBlock(block);
  if (!found) {
    throw new Error(`Ethereum block ${block} not found`);
  }
  return found.timestamp;
}
