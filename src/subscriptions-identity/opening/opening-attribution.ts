import { compareText } from '../engine/text-order';
import { AttributionNote, BlockedKey, OpeningKey } from './opening-file';

/*
 * How legacy rows, keyed by consolidation key, go to identities at the cut.
 *
 * Current state (balance, mode, choices for open cards, final rows for open
 * cards) goes to the identity the key's wallets belong to. Keys of one
 * identity are merged by the legacy merge rules (the re-key the key-width
 * guard held back). A key whose wallets belong to several identities is a
 * split, which only the legacy re-key (consolidateSubscriptions) can make,
 * so it blocks the cut.
 *
 * History rows are kept whole:
 * - a top-up goes to the sender's identity;
 * - a final row or redemption of a key that spans identities goes to the
 *   identity holding its airdrop address, else to the first spanned one;
 * - a log line of such a key is copied to every spanned identity.
 */

/** wallet (lowercase) -> identity key. */
export type WalletIdentities = ReadonlyMap<string, string>;

export function walletsOfKey(consolidationKey: string): string[] {
  return consolidationKey
    .toLowerCase()
    .split('-')
    .filter((w) => w.length > 0);
}

/** Every identity the key's wallets belong to, sorted. */
export function identitiesOfKey(
  consolidationKey: string,
  byWallet: WalletIdentities
): string[] {
  const identities = new Set<string>();
  for (const wallet of walletsOfKey(consolidationKey)) {
    identities.add(byWallet.get(wallet) ?? wallet);
  }
  return Array.from(identities).sort(compareText);
}

export interface CurrentKeyMap {
  /** key -> identity, for every key whose wallets belong to one identity. */
  readonly identityOf: ReadonlyMap<string, string>;
  /** Identities that several keys belong to, with those keys sorted. */
  readonly shared: ReadonlyMap<string, readonly string[]>;
  /** Keys whose wallets belong to several identities (splits). */
  readonly blocked: BlockedKey[];
}

/**
 * Maps the keys that hold current state. A key whose wallets belong to one
 * identity moves to it; several such keys of one identity are merged by the
 * builder; a key that spans identities (a split) is blocked.
 */
export function mapCurrentKeys(
  currentKeys: Iterable<string>,
  byWallet: WalletIdentities,
  /**
   * For a key whose wallets now span identities: the identity the legacy
   * re-key decided it goes to, when that decision is waiting in the queue.
   */
  decided: (consolidationKey: string) => string | undefined = () => undefined
): CurrentKeyMap {
  const keys = Array.from(new Set(Array.from(currentKeys))).sort(compareText);
  const blocked: BlockedKey[] = [];
  const identityOf = new Map<string, string>();
  const keysByIdentity = new Map<string, string[]>();
  for (const key of keys) {
    const spanned = identitiesOfKey(key, byWallet);
    const decision = spanned.length === 1 ? undefined : decided(key);
    const identities = decision ? [decision] : spanned;
    if (identities.length !== 1) {
      blocked.push({
        consolidationKey: key,
        reason: 'SPANS_IDENTITIES',
        identities
      });
      continue;
    }
    identityOf.set(key, identities[0]);
    keysByIdentity.set(identities[0], [
      ...(keysByIdentity.get(identities[0]) ?? []),
      key
    ]);
  }
  const shared = new Map<string, readonly string[]>();
  for (const [identity, ofIdentity] of Array.from(keysByIdentity.entries())) {
    if (ofIdentity.length > 1) {
      shared.set(identity, ofIdentity);
    }
  }
  return { identityOf, shared, blocked };
}

/**
 * The one identity a history row with an airdrop address goes to, and a note
 * when the key spans several identities.
 */
export function attributeByAddress(
  table: string,
  consolidationKey: string,
  address: string | null,
  byWallet: WalletIdentities
): { identityKey: string; note: AttributionNote | null } {
  const identities = identitiesOfKey(consolidationKey, byWallet);
  if (identities.length === 1) {
    return { identityKey: identities[0], note: null };
  }
  const lowerAddress = address?.toLowerCase() ?? null;
  const ofAddress = lowerAddress
    ? (byWallet.get(lowerAddress) ?? lowerAddress)
    : null;
  if (ofAddress && identities.includes(ofAddress)) {
    return {
      identityKey: ofAddress,
      note: {
        table,
        consolidationKey,
        identityKey: ofAddress,
        rule: 'AIRDROP_ADDRESS'
      }
    };
  }
  return {
    identityKey: identities[0],
    note: {
      table,
      consolidationKey,
      identityKey: identities[0],
      rule: 'FIRST_IDENTITY'
    }
  };
}

/** Every key the file names, with where its current state went. */
export function openingKeys(
  allKeys: Iterable<string>,
  identityOf: (consolidationKey: string) => string,
  byWallet: WalletIdentities
): OpeningKey[] {
  return Array.from(new Set(Array.from(allKeys)))
    .sort(compareText)
    .map((consolidationKey) => ({
      consolidationKey,
      identityKey: identityOf(consolidationKey),
      identities: identitiesOfKey(consolidationKey, byWallet)
    }));
}
