import {
  normalizeOptionalText,
  parseDayMonthYear
} from '@/sanctions/sanctions-text';
import {
  childText,
  decodeUtf8,
  descendants,
  elementsAtPath,
  scanXmlRecords,
  XmlElement
} from '@/sanctions/sanctions-xml';
import {
  addressesInText,
  labelsOf,
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

export const UK_FCDO_XML_PARSER_ID = 'uk-fcdo-xml/1';

const NAME_PARTS = ['Name1', 'Name2', 'Name3', 'Name4', 'Name5', 'Name6'];

function primaryName(designation: XmlElement): string | null {
  for (const name of elementsAtPath(designation, ['Names', 'Name'])) {
    if (normalizeOptionalText(childText(name, 'NameType')) !== 'Primary Name') {
      continue;
    }
    const parts = NAME_PARTS.map((part) =>
      normalizeOptionalText(childText(name, part))
    ).filter((part): part is string => part !== null);
    if (parts.length > 0) {
      return parts.join(' ');
    }
  }
  return null;
}

/**
 * Every text node of the designation. Wallets are written in the free-text
 * `OtherInformation` field today; the schema's `CryptoWalletAddresses` and
 * any other field are covered too, so a format change is not missed.
 */
function designationTexts(designation: XmlElement): string[] {
  return descendants(designation).map((element) => element.text);
}

function designationListings(designation: XmlElement): RawSanctionsListing[] {
  const uniqueId = normalizeOptionalText(childText(designation, 'UniqueID'));
  if (uniqueId === null) {
    throw new SanctionsParseError('uk-fcdo', 'Designation without UniqueID');
  }
  const regime = normalizeOptionalText(childText(designation, 'RegimeName'));
  const entity = primaryName(designation);
  const listedOn = parseDayMonthYear(childText(designation, 'DateDesignated'));
  const listings: RawSanctionsListing[] = [];
  for (const text of designationTexts(designation)) {
    for (const found of addressesInText(text)) {
      listings.push({
        address: found.address,
        entry_id: uniqueId,
        entity,
        programs: regime ? [regime] : [],
        labels: labelsOf(found.label),
        listed_on: listedOn,
        valid_until: null
      });
    }
  }
  return listings;
}

/**
 * UK Sanctions List (FCDO) XML. Wallets appear in free text inside each
 * `Designation`. Parse the XML, never the CSV (the CSV loses a line break and
 * glues two addresses together).
 */
export const parseUkFcdoXml: SanctionsSourceParser = (
  files: ReadonlyArray<SanctionsInputFile>
): ParsedSanctionsSource => {
  const file = requireSingleFile('uk-fcdo', files);
  const listings: RawSanctionsListing[] = [];
  let dateGenerated: string | null = null;
  const scan = scanXmlRecords(
    decodeUtf8(file.bytes),
    ['DateGenerated', 'Designation'],
    (record) => {
      if (record.name === 'DateGenerated') {
        dateGenerated = record.text;
        return;
      }
      for (const listing of designationListings(record)) {
        listings.push(listing);
      }
    }
  );
  if (scan.rootName !== 'Designations') {
    throw new SanctionsParseError(
      'uk-fcdo',
      `unexpected root <${scan.rootName}>`
    );
  }
  return {
    source_published: parseDayMonthYear(dateGenerated),
    listings,
    scanned_addresses: scanFilesForAddresses(files)
  };
};
