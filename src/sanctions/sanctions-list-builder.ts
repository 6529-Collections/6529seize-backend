import { canonicalJsonBytes } from '@/sanctions/canonical-json';
import { rawBlockCid, sha256Hex } from '@/sanctions/content-address';
import { normalizeEvmAddress } from '@/sanctions/evm-address';
import type {
  RawSanctionsListing,
  SanctionsInputFile
} from '@/sanctions/parsers/sanctions-parser.types';
import {
  SANCTIONS_BUILDER_ID,
  SANCTIONS_LIST_SCHEMA,
  SanctionsListAddress,
  SanctionsListing,
  SanctionsListSource,
  SanctionsListV1,
  SanctionsSourceId
} from '@/sanctions/sanctions-list.types';
import {
  SANCTIONS_SOURCES,
  SanctionsSourceDefinition
} from '@/sanctions/sanctions-sources';
import {
  compareCodePoints,
  normalizeOptionalText,
  sortedUniqueTexts
} from '@/sanctions/sanctions-text';

export interface SanctionsSourceInputs {
  readonly source: SanctionsSourceId;
  readonly files: ReadonlyArray<SanctionsInputFile>;
}

export interface SanctionsSourceReport {
  readonly source: SanctionsSourceId;
  readonly evm_addresses: number;
  readonly listings: number;
  /** Addresses a whole-file scan found that the structured parse did not attribute. */
  readonly unattributed: string[];
}

export interface SanctionsListBuild {
  readonly list: SanctionsListV1;
  readonly bytes: Buffer;
  readonly sha256: string;
  readonly cid: string;
  readonly report: SanctionsSourceReport[];
}

type ListingKey = string;

function listingKey(source: SanctionsSourceId, entryId: string): ListingKey {
  return `${source}\u0000${entryId}`;
}

function minNonNull(a: string | null, b: string | null): string | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return compareCodePoints(a, b) <= 0 ? a : b;
}

/** Null (open-ended) wins; otherwise the later end date. */
function laterValidUntil(a: string | null, b: string | null): string | null {
  if (a === null || b === null) {
    return null;
  }
  return compareCodePoints(a, b) >= 0 ? a : b;
}

function toListing(
  source: SanctionsSourceId,
  raw: RawSanctionsListing
): SanctionsListing {
  if (normalizeEvmAddress(raw.address) !== raw.address) {
    throw new Error(`${source} produced a non-normalized address`);
  }
  const entryId = normalizeOptionalText(raw.entry_id);
  if (entryId === null) {
    throw new Error(`${source} produced a listing without an entry id`);
  }
  return {
    source,
    entry_id: entryId,
    entity: normalizeOptionalText(raw.entity),
    programs: sortedUniqueTexts(raw.programs),
    labels: sortedUniqueTexts(raw.labels),
    listed_on: raw.listed_on,
    valid_until: raw.valid_until
  };
}

/**
 * Merges two listings of the same address, source and entry. Every rule is
 * order-independent, so input order never changes the output.
 */
function mergeListings(
  a: SanctionsListing,
  b: SanctionsListing
): SanctionsListing {
  return {
    source: a.source,
    entry_id: a.entry_id,
    entity: minNonNull(a.entity, b.entity),
    programs: sortedUniqueTexts(a.programs.concat(b.programs)),
    labels: sortedUniqueTexts(a.labels.concat(b.labels)),
    listed_on: minNonNull(a.listed_on, b.listed_on),
    valid_until: laterValidUntil(a.valid_until, b.valid_until)
  };
}

function compareListings(a: SanctionsListing, b: SanctionsListing): number {
  return (
    compareCodePoints(a.source, b.source) ||
    compareCodePoints(a.entry_id, b.entry_id)
  );
}

function inputSummary(files: ReadonlyArray<SanctionsInputFile>) {
  return files
    .map((file) => ({
      name: file.name,
      sha256: sha256Hex(file.bytes),
      bytes: file.bytes.length
    }))
    .sort((a, b) => compareCodePoints(a.name, b.name));
}

function requireInputs(
  inputs: ReadonlyArray<SanctionsSourceInputs>,
  definition: SanctionsSourceDefinition
): ReadonlyArray<SanctionsInputFile> {
  const matching = inputs.filter((input) => input.source === definition.id);
  if (matching.length !== 1) {
    throw new Error(
      `Expected inputs for ${definition.id} exactly once, got ${matching.length}`
    );
  }
  return matching[0].files;
}

/**
 * Builds the canonical `6529.sanctions-list.v1` payload from input files.
 * A pure function: no network, clock or environment access, so anyone with
 * the same input files gets the same bytes, sha256 and CID.
 */
export function buildSanctionsList(
  inputs: ReadonlyArray<SanctionsSourceInputs>
): SanctionsListBuild {
  for (const input of inputs) {
    if (!SANCTIONS_SOURCES.some((source) => source.id === input.source)) {
      throw new Error(`Unknown sanctions source ${input.source}`);
    }
  }
  const byAddress: Record<string, Record<ListingKey, SanctionsListing>> = {};
  const sources: SanctionsListSource[] = [];
  const report: SanctionsSourceReport[] = [];

  for (const definition of SANCTIONS_SOURCES) {
    const files = requireInputs(inputs, definition);
    const parsed = definition.parse(files);
    const sourceAddresses: Record<string, true> = {};
    const sourceListings: Record<string, true> = {};
    for (const raw of parsed.listings) {
      const listing = toListing(definition.id, raw);
      const key = listingKey(definition.id, listing.entry_id);
      const forAddress = (byAddress[raw.address] =
        byAddress[raw.address] ?? {});
      const existing = forAddress[key];
      forAddress[key] = existing ? mergeListings(existing, listing) : listing;
      sourceAddresses[raw.address] = true;
      sourceListings[`${raw.address}\u0000${key}`] = true;
    }
    const evmAddresses = Object.keys(sourceAddresses).length;
    const listingCount = Object.keys(sourceListings).length;
    sources.push({
      id: definition.id,
      authority: definition.authority,
      jurisdiction: definition.jurisdiction,
      list_name: definition.list_name,
      nature: definition.nature,
      url: definition.url,
      acquisition: definition.acquisition,
      parser: definition.parser,
      inputs: inputSummary(files),
      source_published: parsed.source_published,
      evm_addresses: evmAddresses,
      listings: listingCount
    });
    report.push({
      source: definition.id,
      evm_addresses: evmAddresses,
      listings: listingCount,
      unattributed: parsed.scanned_addresses.filter(
        (address) =>
          !sourceAddresses[address] &&
          (parsed.excluded_addresses ?? []).indexOf(address) === -1
      )
    });
  }

  const addresses: SanctionsListAddress[] = Object.keys(byAddress)
    .sort(compareCodePoints)
    .map((address) => {
      const listingsByKey = byAddress[address];
      const listings = Object.keys(listingsByKey)
        .map((key) => listingsByKey[key])
        .sort(compareListings);
      return { address, listings };
    });

  const list: SanctionsListV1 = {
    schema: SANCTIONS_LIST_SCHEMA,
    builder: SANCTIONS_BUILDER_ID,
    chain_family: 'evm',
    sources,
    addresses,
    totals: {
      addresses: addresses.length,
      listings: addresses.reduce((sum, item) => sum + item.listings.length, 0),
      sources: sources.length
    }
  };
  const bytes = canonicalJsonBytes(list);
  return {
    list,
    bytes,
    sha256: sha256Hex(bytes),
    cid: rawBlockCid(bytes),
    report
  };
}
