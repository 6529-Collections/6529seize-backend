import { PinnedAddress, publicNetwork } from '@/http/public-fetch';

/**
 * Test seam: lets the shared public-network transport reach owned fixtures
 * (a mocked node-fetch or a loopback test server) without real DNS. It
 * replaces only the per-hop target lookup; runtime policy is unchanged.
 * Returns a function that restores the original lookup.
 */
export function routePublicNetworkToFixtures(): () => void {
  const original = publicNetwork.resolveTarget;
  publicNetwork.resolveTarget = async (
    url: string
  ): Promise<PinnedAddress> => ({
    hostname: new URL(url).hostname,
    address: '127.0.0.1',
    family: 4
  });
  return () => {
    publicNetwork.resolveTarget = original;
  };
}
