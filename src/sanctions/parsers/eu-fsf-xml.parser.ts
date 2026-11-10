import {
  isoDatePrefix,
  normalizeOptionalText
} from '@/sanctions/sanctions-text';
import {
  childElements,
  decodeUtf8,
  descendants,
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

export const EU_FSF_XML_PARSER_ID = 'eu-fsf-xml/1';

function firstWholeName(entity: XmlElement): string | null {
  for (const alias of childElements(entity, 'nameAlias')) {
    const name = normalizeOptionalText(alias.attrs.wholeName);
    if (name !== null) {
      return name;
    }
  }
  return null;
}

function programmes(entity: XmlElement): string[] {
  return childElements(entity, 'regulation')
    .map((regulation) => regulation.attrs.programme ?? '')
    .filter((programme) => programme.trim() !== '');
}

function entityListings(entity: XmlElement): RawSanctionsListing[] {
  const reference = normalizeOptionalText(entity.attrs.euReferenceNumber);
  if (reference === null) {
    throw new SanctionsParseError(
      'eu-fsf',
      `sanctionEntity ${entity.attrs.logicalId ?? '?'} without euReferenceNumber`
    );
  }
  const name = firstWholeName(entity);
  const programs = programmes(entity);
  const listedOn = isoDatePrefix(entity.attrs.designationDate);
  const listings: RawSanctionsListing[] = [];
  for (const element of descendants(entity)) {
    for (const found of addressesInText(element.text)) {
      listings.push({
        address: found.address,
        entry_id: reference,
        entity: name,
        programs,
        labels: labelsOf(found.label),
        listed_on: listedOn,
        valid_until: null
      });
    }
  }
  return listings;
}

/**
 * EU consolidated Financial Sanctions File (FSF 1.1 XML). Wallets are written
 * in free-text `remark` elements of a `sanctionEntity`; every text node of
 * the entity is scanned.
 */
export const parseEuFsfXml: SanctionsSourceParser = (
  files: ReadonlyArray<SanctionsInputFile>
): ParsedSanctionsSource => {
  const file = requireSingleFile('eu-fsf', files);
  const listings: RawSanctionsListing[] = [];
  const scan = scanXmlRecords(
    decodeUtf8(file.bytes),
    ['sanctionEntity'],
    (record) => {
      for (const listing of entityListings(record)) {
        listings.push(listing);
      }
    }
  );
  if (scan.rootName !== 'export') {
    throw new SanctionsParseError(
      'eu-fsf',
      `unexpected root <${scan.rootName}>`
    );
  }
  return {
    source_published: isoDatePrefix(scan.rootAttrs.generationDate),
    listings,
    scanned_addresses: scanFilesForAddresses(files)
  };
};
