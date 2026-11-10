import * as mcache from 'memory-cache';
import { AuthenticationContext } from '@/auth-context';
import { Time } from '@/time';

/**
 * Per-instance memory cache of resolved authentication contexts, keyed by the
 * JWT wallet and the role it acts as. Proxy grants are read when the context
 * is built, so a change to a grant is only seen on this instance once the
 * entry is dropped (explicitly, below) or expires.
 */
const AUTH_CONTEXT_CACHE_TTL = Time.minutes(1);

function cacheKey(wallet: string, roleProfileId: string | null): string {
  return `auth-context-${wallet}-${roleProfileId}`;
}

export function getCachedAuthenticationContext(
  wallet: string,
  roleProfileId: string | null
): AuthenticationContext | null {
  return mcache.get(cacheKey(wallet, roleProfileId)) ?? null;
}

export function putCachedAuthenticationContext(
  wallet: string,
  roleProfileId: string | null,
  context: AuthenticationContext
): void {
  mcache.put(
    cacheKey(wallet, roleProfileId),
    context,
    AUTH_CONTEXT_CACHE_TTL.toMillis()
  );
}

/**
 * Drops the cached proxy contexts of `grantee` acting as `grantorProfileId`
 * on this instance, so a grant created, changed, accepted, rejected, revoked
 * or restored takes effect on the next request here instead of after the TTL.
 * Other instances still see the change only after their own entries expire.
 */
export function invalidateCachedProxyAuthenticationContexts({
  granteeWallets,
  grantorProfileId
}: {
  readonly granteeWallets: readonly string[];
  readonly grantorProfileId: string;
}): void {
  for (const wallet of granteeWallets) {
    mcache.del(cacheKey(wallet.toLowerCase(), grantorProfileId));
  }
}
