import { normalizeEvmAddress } from '@/sanctions/evm-address';
import {
  IsoDate,
  SANCTIONS_CORRECTIONS_SCHEMA,
  SANCTIONS_LIST_SCHEMA,
  SanctionsCorrectionsV1,
  SanctionsListing,
  SanctionsListV1,
  SanctionsSourceId
} from '@/sanctions/sanctions-list.types';
import {
  compareCodePoints,
  isIsoDate,
  sortedUniqueTexts
} from '@/sanctions/sanctions-text';

/**
 * The checking functions of `specs/sanctions-list-v1.md` section 4. They are
 * pure: the same list, input and date always give the same answer, so the
 * API, the desktop signer and validators can implement them identically.
 */

/** A list prepared for O(1) lookups. Build once per list version. */
export interface SanctionsIndex {
  readonly list: SanctionsListV1;
  readonly byAddress: Readonly<Record<string, ReadonlyArray<SanctionsListing>>>;
}

export interface ProfileSanctionMatch {
  readonly address: string;
  readonly sources: SanctionsSourceId[];
}

export interface ProfileSanctionStatus {
  readonly blocked: boolean;
  readonly matched: ProfileSanctionMatch[];
}

function assertAsOf(asOf: IsoDate): void {
  if (!isIsoDate(asOf)) {
    throw new Error(`asOf must be a YYYY-MM-DD date, got ${String(asOf)}`);
  }
}

/** Dates must be strict `YYYY-MM-DD` so that string comparison orders them. */
function assertListingDates(listing: SanctionsListing): void {
  for (const date of [listing.listed_on, listing.valid_until]) {
    if (date !== null && !isIsoDate(date)) {
      throw new Error(`List contains a malformed date in ${listing.source}`);
    }
  }
}

function inForce(listing: SanctionsListing, asOf: IsoDate): boolean {
  return (
    listing.valid_until === null ||
    compareCodePoints(listing.valid_until, asOf) >= 0
  );
}

export function createSanctionsIndex(list: SanctionsListV1): SanctionsIndex {
  if (list.schema !== SANCTIONS_LIST_SCHEMA) {
    throw new Error(`Unsupported sanctions list schema ${String(list.schema)}`);
  }
  const byAddress: Record<string, ReadonlyArray<SanctionsListing>> = {};
  for (const entry of list.addresses) {
    const address = normalizeEvmAddress(entry.address);
    if (address === null || address !== entry.address) {
      throw new Error(`List contains a non-normalized address`);
    }
    if (Object.prototype.hasOwnProperty.call(byAddress, address)) {
      throw new Error(`List contains a duplicate address`);
    }
    for (const listing of entry.listings) {
      assertListingDates(listing);
    }
    byAddress[address] = entry.listings;
  }
  return { list, byAddress };
}

/**
 * A listing is in force on `asOf` (a UTC calendar date) unless it has an end
 * date before that day. Only seizure orders carry end dates today.
 */
export function listingInForce(
  listing: SanctionsListing,
  asOf: IsoDate
): boolean {
  assertAsOf(asOf);
  return inForce(listing, asOf);
}

/** Every listing of the address, lapsed ones included (for provenance). */
export function sanctionListings(
  address: string,
  index: SanctionsIndex
): ReadonlyArray<SanctionsListing> {
  const normalized = normalizeEvmAddress(address);
  if (normalized === null) {
    return [];
  }
  return Object.prototype.hasOwnProperty.call(index.byAddress, normalized)
    ? index.byAddress[normalized]
    : [];
}

function inForceSources(
  address: string,
  index: SanctionsIndex,
  asOf: IsoDate
): SanctionsSourceId[] {
  return sortedUniqueTexts(
    sanctionListings(address, index)
      .filter((listing) => inForce(listing, asOf))
      .map((listing) => listing.source)
  ) as SanctionsSourceId[];
}

/** True when the address has at least one listing in force on `asOf`. */
export function isSanctioned(
  address: string,
  index: SanctionsIndex,
  asOf: IsoDate
): boolean {
  assertAsOf(asOf);
  return inForceSources(address, index, asOf).length > 0;
}

/**
 * A profile is blocked when any of its consolidated wallets is sanctioned
 * (owner policy C50.1). Invalid strings never match; duplicates and case are
 * normalized; an empty wallet set is not blocked.
 */
export function profileSanctionStatus(
  wallets: ReadonlyArray<string>,
  index: SanctionsIndex,
  asOf: IsoDate
): ProfileSanctionStatus {
  assertAsOf(asOf);
  const normalized = sortedUniqueTexts(
    wallets
      .map((wallet) => normalizeEvmAddress(wallet))
      .filter((wallet): wallet is string => wallet !== null)
  );
  const matched: ProfileSanctionMatch[] = [];
  for (const address of normalized) {
    const sources = inForceSources(address, index, asOf);
    if (sources.length > 0) {
      matched.push({ address, sources });
    }
  }
  return { blocked: matched.length > 0, matched };
}

/**
 * A delegation carries rights only when neither side's profile is blocked
 * (C50.2, ruling R2). Each side is the delegating or delegate wallet's
 * consolidated wallet set, or just the wallet when it has no profile. This
 * voids the delegation; it never blocks the counterparty itself.
 */
export function delegationCarriesRights(
  fromWallets: ReadonlyArray<string>,
  toWallets: ReadonlyArray<string>,
  index: SanctionsIndex,
  asOf: IsoDate
): boolean {
  return (
    !profileSanctionStatus(fromWallets, index, asOf).blocked &&
    !profileSanctionStatus(toWallets, index, asOf).blocked
  );
}

function correctionKey(
  address: string,
  source: SanctionsSourceId,
  entryId: string
) {
  return `${address}\u0000${source}\u0000${entryId}`;
}

/**
 * Applies signed, public, address-level corrections (for example a parser
 * error) by removing the named listings. Addresses left without listings are
 * dropped and totals recomputed. Source descriptions are left untouched,
 * because they describe the inputs.
 */
export function effectiveList(
  list: SanctionsListV1,
  corrections: SanctionsCorrectionsV1
): SanctionsListV1 {
  if (corrections.schema !== SANCTIONS_CORRECTIONS_SCHEMA) {
    throw new Error(
      `Unsupported corrections schema ${String(corrections.schema)}`
    );
  }
  const removed: Record<string, true> = {};
  for (const correction of corrections.corrections) {
    const address = normalizeEvmAddress(correction.address);
    if (address === null) {
      throw new Error('Correction with an invalid address');
    }
    removed[correctionKey(address, correction.source, correction.entry_id)] =
      true;
  }
  const addresses = list.addresses
    .map((entry) => ({
      address: entry.address,
      listings: entry.listings.filter(
        (listing) =>
          !removed[
            correctionKey(entry.address, listing.source, listing.entry_id)
          ]
      )
    }))
    .filter((entry) => entry.listings.length > 0);
  return {
    ...list,
    addresses,
    totals: {
      addresses: addresses.length,
      listings: addresses.reduce(
        (sum, entry) => sum + entry.listings.length,
        0
      ),
      sources: list.sources.length
    }
  };
}
