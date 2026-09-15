import { getRpcUrlFromNetwork } from '@/alchemy';
import { Network } from '@/alchemy-sdk';
import { FetchRequest, isAddress, JsonRpcProvider, ZeroAddress } from 'ethers';
import { Cache } from 'memory-cache';

const resolvedAddresses = new Cache<string, string>();

export function createWalletGalleryEnsProvider(): JsonRpcProvider {
  if (!process.env.ALCHEMY_API_KEY) {
    throw new Error('CMS ENS provider is not configured');
  }
  const request = new FetchRequest(getRpcUrlFromNetwork(Network.ETH_MAINNET));
  request.timeout = 1500;
  request.setThrottleParams({ maxAttempts: 1 });
  const provider = new JsonRpcProvider(request, 1, { staticNetwork: true });
  provider.disableCcipRead = true;
  return provider;
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
