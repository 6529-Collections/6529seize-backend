import { ProfileCmsChainPort } from '@/profile-cms/chain/profile-cms-chain.port';

/**
 * The one place the profile site index gets its chain reads: the identity
 * mirror's port, over the shared gateway client at CHAIN_GATEWAY_URL. A
 * caller that names a gateway (a rebuild check's source) must name that
 * one; another is refused rather than read. Until the identity mirror is
 * wired in here, it refuses, so nothing runs half-wired.
 */
export function createProfileCmsChainPort(
  gateway: string | null = null
): ProfileCmsChainPort {
  assertConfiguredGateway(gateway);
  throw new Error(
    'No chain gateway adapter yet: profile sites read the chain through the identity mirror, which is not wired in here.'
  );
}

function assertConfiguredGateway(gateway: string | null): void {
  if (gateway === null) {
    return;
  }
  const configured = process.env.CHAIN_GATEWAY_URL ?? '';
  if (withoutTrailingSlashes(gateway) !== withoutTrailingSlashes(configured)) {
    throw new Error(
      `Profile sites read the chain at CHAIN_GATEWAY_URL; set it to ${gateway} to read that gateway`
    );
  }
}

function withoutTrailingSlashes(url: string): string {
  let trimmed = url.trim();
  while (trimmed.endsWith('/')) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}
