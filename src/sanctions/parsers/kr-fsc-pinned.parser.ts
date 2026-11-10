import { normalizeEvmAddress } from '@/sanctions/evm-address';
import { isIsoDate, normalizeOptionalText } from '@/sanctions/sanctions-text';
import { decodeUtf8 } from '@/sanctions/sanctions-xml';
import {
  requireSingleFile,
  scanFilesForAddresses
} from '@/sanctions/parsers/parser-helpers';
import {
  ParsedSanctionsSource,
  RawSanctionsListing,
  SanctionsInputFile,
  SanctionsParseError,
  SanctionsSourceParser
} from '@/sanctions/parsers/sanctions-parser.types';

export const KR_FSC_PINNED_PARSER_ID = 'kr-fsc-pinned/1';
export const PINNED_SOURCE_SCHEMA = '6529.sanctions-pinned-source.v1';
export const KR_FSC_PINNED_FILE_NAME = 'kr-fsc.pinned.json';

export interface PinnedSourceDocument {
  readonly title: string;
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly format: string;
}

export interface PinnedSourceEntry {
  readonly entry_id: string;
  readonly entity: string;
  readonly programs: string[];
  readonly listed_on: string | null;
  readonly addresses: Array<{ address: string; labels: string[] }>;
}

/**
 * A human-reviewed transcription of an official document that a machine
 * cannot read reliably on its own. The daily job re-downloads the document
 * and alerts when its sha256 no longer matches `document.sha256`.
 */
export interface PinnedSourceFile {
  readonly schema: typeof PINNED_SOURCE_SCHEMA;
  readonly source: string;
  readonly published: string;
  readonly document: PinnedSourceDocument;
  readonly alternate_documents: PinnedSourceDocument[];
  readonly review: Record<string, string | null>;
  readonly entries: PinnedSourceEntry[];
}

function fail(message: string): never {
  throw new SanctionsParseError('kr-fsc', message);
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    fail(`${field} must be an array of strings`);
  }
  return value as string[];
}

function entryListings(entry: PinnedSourceEntry): RawSanctionsListing[] {
  const entryId = normalizeOptionalText(entry.entry_id);
  if (entryId === null) {
    fail('entry without entry_id');
  }
  if (entry.listed_on !== null && !isIsoDate(entry.listed_on)) {
    fail(`entry ${entryId} has an invalid listed_on`);
  }
  if (!Array.isArray(entry.addresses) || entry.addresses.length === 0) {
    fail(`entry ${entryId} has no addresses`);
  }
  const programs = stringArray(entry.programs, `entry ${entryId} programs`);
  return entry.addresses.map((item) => {
    const address = normalizeEvmAddress(item.address);
    if (address === null) {
      fail(`entry ${entryId} has an invalid address`);
    }
    return {
      address,
      entry_id: entryId,
      entity: normalizeOptionalText(entry.entity),
      programs,
      labels: stringArray(item.labels, `entry ${entryId} labels`),
      listed_on: entry.listed_on,
      valid_until: null
    };
  });
}

/** Korea FSC/KoFIU: reads the reviewed pinned transcription of the annex. */
export const parseKrFscPinned: SanctionsSourceParser = (
  files: ReadonlyArray<SanctionsInputFile>
): ParsedSanctionsSource => {
  const file = requireSingleFile('kr-fsc', files);
  if (file.name !== KR_FSC_PINNED_FILE_NAME) {
    fail(`expected ${KR_FSC_PINNED_FILE_NAME}, got ${file.name}`);
  }
  const pinned = JSON.parse(decodeUtf8(file.bytes)) as PinnedSourceFile;
  if (pinned.schema !== PINNED_SOURCE_SCHEMA || pinned.source !== 'kr-fsc') {
    fail('not a kr-fsc pinned source file');
  }
  if (!isIsoDate(pinned.published)) {
    fail('published must be YYYY-MM-DD');
  }
  if (!Array.isArray(pinned.entries)) {
    fail('entries must be an array');
  }
  const listings: RawSanctionsListing[] = [];
  for (const entry of pinned.entries) {
    for (const listing of entryListings(entry)) {
      listings.push(listing);
    }
  }
  return {
    source_published: pinned.published,
    listings,
    scanned_addresses: scanFilesForAddresses(files)
  };
};
