import { createEthereumRpcProvider } from '@/ethereum-rpc/ethereum-rpc-provider';
import { isAddress, JsonRpcProvider, ZeroAddress } from 'ethers';
import { Cache } from 'memory-cache';

const resolvedAddresses = new Cache<string, string>();

export function createWalletGalleryEnsProvider(): JsonRpcProvider {
  return createEthereumRpcProvider(1, {
    timeoutMs: 1500,
    maxAttempts: 1,
    disableCcipRead: true
  });
}

export async function resolveWalletGalleryEns(
  name: string
): Promise<string | null> {
  const cached = resolvedAddresses.get(name);
  if (cached) return cached;

  const provider = createWalletGalleryEnsProvider();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('CMS ENS lookup timed out')),
        4000
      );
    });
    const address = await Promise.race([provider.resolveName(name), deadline]);
    if (address && isAddress(address) && address !== ZeroAddress) {
      resolvedAddresses.put(name, address, 60_000);
    }
    return address;
  } finally {
    clearTimeout(timeout);
    provider.destroy();
  }
}
