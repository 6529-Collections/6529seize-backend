import { stableUuid } from '@/competitions/competition-id';
import { isIdentityOnChain } from '@/identity-freeze/identity-freeze';

/**
 * The namespace of the profile ids 6529.io gives identities rows that hold
 * one address and nothing else: a group listing an address no identity
 * holds, and a wallet leaving a chain identity. Used for nothing else.
 */
export const ADDRESS_IDENTITY_NAMESPACE =
  '7e587c0f-e470-430d-984a-9d9d5ccce0ef';

/**
 * The n-th candidate profile id of an address-only identities row: n = 0
 * is the address itself, n >= 1 the address with ":n". An address has no
 * ':', so a suffixed value is never another address.
 */
export function addressIdentityId(address: string, n = 0): string {
  const value = address.toLowerCase();
  return stableUuid(
    ADDRESS_IDENTITY_NAMESPACE,
    n === 0 ? value : `${value}:${n}`
  );
}

/**
 * The first candidate (n = 0, 1, 2, ...) that no identities row or profile
 * holds, as `isTaken` says: never a second holder of an id.
 */
export function pickAddressIdentityId(
  address: string,
  isTaken: (id: string) => boolean
): string {
  for (let n = 0; ; n++) {
    const id = addressIdentityId(address, n);
    if (!isTaken(id)) return id;
  }
}

/**
 * Whether an address-only row made at this time takes a derived id: from
 * switch-on. Before it, its creator gives a random one, as 6529.io did.
 * The identity mirror passes the block time of the event it writes for,
 * so a mirror catching up and a rebuild pick the same side; the API
 * passes the wall time.
 */
export function addressIdentityIdsFrom(nowMillis: number): boolean {
  return isIdentityOnChain(nowMillis);
}
