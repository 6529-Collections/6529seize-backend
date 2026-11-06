import { normalizeEvmAddress } from '@/sanctions/evm-address';
import {
  normalizeOptionalText,
  parseMonthDayYear
} from '@/sanctions/sanctions-text';
import {
  childText,
  decodeUtf8,
  elementsAtPath,
  scanXmlRecords,
  XmlElement
} from '@/sanctions/sanctions-xml';
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

export const OFAC_SDN_XML_PARSER_ID = 'ofac-sdn-xml/1';

const DIGITAL_CURRENCY_PREFIX = 'Digital Currency Address - ';

function entityName(entry: XmlElement): string | null {
  const parts = [childText(entry, 'firstName'), childText(entry, 'lastName')]
    .map((part) => normalizeOptionalText(part))
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(' ') : null;
}

function entryListings(entry: XmlElement): RawSanctionsListing[] {
  const uid = normalizeOptionalText(childText(entry, 'uid'));
  if (uid === null) {
    throw new SanctionsParseError('us-ofac-sdn', 'sdnEntry without uid');
  }
  const programs = elementsAtPath(entry, ['programList', 'program']).map(
    (program) => program.text
  );
  const entity = entityName(entry);
  const listings: RawSanctionsListing[] = [];
  for (const id of elementsAtPath(entry, ['idList', 'id'])) {
    const idType = childText(id, 'idType') ?? '';
    if (idType.indexOf(DIGITAL_CURRENCY_PREFIX) !== 0) {
      continue;
    }
    const address = normalizeEvmAddress(childText(id, 'idNumber'));
    if (address === null) {
      continue;
    }
    listings.push({
      address,
      entry_id: uid,
      entity,
      programs,
      labels: [idType.slice(DIGITAL_CURRENCY_PREFIX.length)],
      listed_on: null,
      valid_until: null
    });
  }
  return listings;
}

/**
 * OFAC SDN.XML: every `sdnEntry/idList/id` whose `idType` starts with
 * `Digital Currency Address - ` and whose `idNumber` is an EVM address. The
 * ticker suffix is only a label; EVM addresses appear under ETH, USDT, USDC,
 * ETC, ARB and BSC. SDN.XML has no designation dates.
 */
export const parseOfacSdnXml: SanctionsSourceParser = (
  files: ReadonlyArray<SanctionsInputFile>
): ParsedSanctionsSource => {
  const file = requireSingleFile('us-ofac-sdn', files);
  const listings: RawSanctionsListing[] = [];
  let publishDate: string | null = null;
  const scan = scanXmlRecords(
    decodeUtf8(file.bytes),
    ['publshInformation', 'sdnEntry'],
    (record) => {
      if (record.name === 'publshInformation') {
        publishDate = childText(record, 'Publish_Date');
        return;
      }
      for (const listing of entryListings(record)) {
        listings.push(listing);
      }
    }
  );
  if (scan.rootName !== 'sdnList') {
    throw new SanctionsParseError(
      'us-ofac-sdn',
      `unexpected root <${scan.rootName}>`
    );
  }
  return {
    source_published: parseMonthDayYear(publishDate),
    listings,
    scanned_addresses: scanFilesForAddresses(files)
  };
};
