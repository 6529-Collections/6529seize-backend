import {
  IdentityDirectory,
  mirrorIdentityDirectory
} from '../identity/identity-directory';
import { identitiesOfKey, walletsOfKey } from '../opening/opening-attribution';

/**
 * Each legacy consolidation key to the one identity its wallets belong to
 * now, or null when they belong to several.
 */
export async function identityOfLegacyKeys(
  keys: readonly string[],
  directory: IdentityDirectory = mirrorIdentityDirectory
): Promise<Map<string, string | null>> {
  const byWallet = await directory.identitiesOf(
    Array.from(new Set(keys.flatMap((k) => walletsOfKey(k))))
  );
  const result = new Map<string, string | null>();
  for (const key of keys) {
    const identities = identitiesOfKey(key, byWallet);
    result.set(
      key.toLowerCase(),
      identities.length === 1 ? identities[0] : null
    );
  }
  return result;
}
