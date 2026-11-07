import { compareCodePoints, isoDatePrefix } from '@/sanctions/sanctions-text';
import {
  childText,
  decodeUtf8,
  scanXmlRecords
} from '@/sanctions/sanctions-xml';
import {
  requireSingleFile,
  scanFilesForAddresses
} from '@/sanctions/parsers/parser-helpers';
import {
  ParsedSanctionsSource,
  SanctionsInputFile,
  SanctionsParseError,
  SanctionsSourceParser
} from '@/sanctions/parsers/sanctions-parser.types';

export const CA_SEMA_XML_PARSER_ID = 'ca-sema-xml/1';

/**
 * Canada's SEMA consolidated list has no identifier or crypto-address field,
 * so it yields no listings. It is still parsed (the XML must be well formed)
 * and scanned: the builder reports any address that ever appears in it.
 */
export const parseCaSemaXml: SanctionsSourceParser = (
  files: ReadonlyArray<SanctionsInputFile>
): ParsedSanctionsSource => {
  const file = requireSingleFile('ca-sema', files);
  let latestListing: string | null = null;
  const scan = scanXmlRecords(decodeUtf8(file.bytes), ['record'], (record) => {
    const listed = isoDatePrefix(
      childText(record, 'DateOfListing-DateDinscription')
    );
    if (
      listed !== null &&
      (latestListing === null || compareCodePoints(listed, latestListing) > 0)
    ) {
      latestListing = listed;
    }
  });
  if (scan.rootName !== 'data-set') {
    throw new SanctionsParseError(
      'ca-sema',
      `unexpected root <${scan.rootName}>`
    );
  }
  return {
    source_published: latestListing,
    listings: [],
    scanned_addresses: scanFilesForAddresses(files)
  };
};
