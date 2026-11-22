import { ProfileCmsChainPort } from '@/profile-cms/chain/profile-cms-chain.port';

/**
 * The one place the profile site index gets its chain reads. It becomes a
 * thin adapter over the shared gateway client (`src/chain-gateway`) when
 * that module lands on this branch; until then it refuses, so nothing runs
 * against a half-wired gateway.
 */
export function createProfileCmsChainPort(
  gatewayBaseUrl: string | null
): ProfileCmsChainPort {
  throw new Error(
    `No chain gateway adapter yet for ${gatewayBaseUrl ?? 'the configured gateway'}: ` +
      'profile sites read the chain through the shared gateway client, which has not landed here.'
  );
}
