import {
  compareCodePoints,
  isoDatePrefix,
  normalizeOptionalText
} from '@/sanctions/sanctions-text';
import {
  childElements,
  decodeUtf8,
  descendants,
  elementsAtPath,
  scanXmlRecords,
  XmlElement
} from '@/sanctions/sanctions-xml';
import { extractEvmAddresses } from '@/sanctions/evm-address';
import {
  addressesInText,
  labelsOf,
  requireSingleFile
} from '@/sanctions/parsers/parser-helpers';
import {
  ParsedSanctionsSource,
  RawSanctionsListing,
  SanctionsInputFile,
  SanctionsParseError,
  SanctionsSourceParser
} from '@/sanctions/parsers/sanctions-parser.types';

export const CH_SECO_XML_PARSER_ID = 'ch-seco-xml/1';

const SUBJECT_ELEMENTS = ['entity', 'individual', 'object'];

interface PendingTarget {
  readonly listings: RawSanctionsListing[];
  readonly setIds: string[];
}

/**
 * Addresses anywhere in a target except its `modification` history, which
 * legitimately keeps delisted addresses. Feeds the drift tripwire.
 */
function currentTargetAddresses(target: XmlElement): string[] {
  const found: string[] = [];
  for (const child of target.children) {
    if (child.name === 'modification') {
      continue;
    }
    for (const element of [child].concat(descendants(child))) {
      for (const match of extractEvmAddresses(element.text)) {
        found.push(match.address);
      }
    }
  }
  return found;
}

function subjectOf(target: XmlElement): XmlElement | null {
  for (const child of target.children) {
    if (SUBJECT_ELEMENTS.indexOf(child.name) !== -1) {
      return child;
    }
  }
  return null;
}

function primaryName(subject: XmlElement): string | null {
  for (const identity of childElements(subject, 'identity')) {
    if (identity.attrs.main !== 'true') {
      continue;
    }
    for (const name of childElements(identity, 'name')) {
      if (name.attrs['name-type'] !== 'primary-name') {
        continue;
      }
      const parts = childElements(name, 'name-part')
        .slice()
        .sort((a, b) => Number(a.attrs.order) - Number(b.attrs.order))
        .map((part) =>
          normalizeOptionalText(elementsAtPath(part, ['value'])[0]?.text)
        )
        .filter((part): part is string => part !== null);
      if (parts.length > 0) {
        return parts.join(' ');
      }
    }
  }
  return null;
}

function listedOn(target: XmlElement): string | null {
  const dates = childElements(target, 'modification')
    .filter(
      (modification) => modification.attrs['modification-type'] === 'listed'
    )
    .map((modification) => isoDatePrefix(modification.attrs['effective-date']))
    .filter((date): date is string => date !== null)
    .sort(compareCodePoints);
  return dates.length > 0 ? dates[0] : null;
}

/** Only the current subject is read; `modification` history repeats every address. */
function targetListings(target: XmlElement): PendingTarget {
  const ssid = normalizeOptionalText(target.attrs.ssid);
  if (ssid === null) {
    throw new SanctionsParseError('ch-seco', 'target without ssid');
  }
  const subject = subjectOf(target);
  const listings: RawSanctionsListing[] = [];
  if (subject !== null) {
    const entity = primaryName(subject);
    const listed = listedOn(target);
    for (const element of descendants(subject)) {
      for (const found of addressesInText(element.text)) {
        listings.push({
          address: found.address,
          entry_id: ssid,
          entity,
          programs: [],
          labels: labelsOf(found.label),
          listed_on: listed,
          valid_until: null
        });
      }
    }
  }
  return {
    listings,
    setIds: childElements(target, 'sanctions-set-id').map((id) =>
      id.text.trim()
    )
  };
}

function programKeysBySet(program: XmlElement, into: Record<string, string>) {
  const key = childElements(program, 'program-key').filter(
    (element) => element.attrs.lang === 'eng'
  )[0];
  const name = normalizeOptionalText(key?.text);
  if (name === null) {
    return;
  }
  for (const set of childElements(program, 'sanctions-set')) {
    if (set.attrs.ssid) {
      into[set.attrs.ssid] = name;
    }
  }
}

/**
 * Swiss SECO consolidated list XML. Wallets are written in free text inside
 * each target's current `entity`/`individual`/`object`; the programme is the
 * English `program-key` of the target's sanctions set.
 */
export const parseChSecoXml: SanctionsSourceParser = (
  files: ReadonlyArray<SanctionsInputFile>
): ParsedSanctionsSource => {
  const file = requireSingleFile('ch-seco', files);
  const programBySet: Record<string, string> = {};
  const pending: PendingTarget[] = [];
  const scanned: Record<string, true> = {};
  const scan = scanXmlRecords(
    decodeUtf8(file.bytes),
    ['sanctions-program', 'target'],
    (record) => {
      if (record.name === 'sanctions-program') {
        programKeysBySet(record, programBySet);
        return;
      }
      for (const address of currentTargetAddresses(record)) {
        scanned[address] = true;
      }
      const target = targetListings(record);
      if (target.listings.length > 0) {
        pending.push(target);
      }
    }
  );
  if (scan.rootName !== 'swiss-sanctions-list') {
    throw new SanctionsParseError(
      'ch-seco',
      `unexpected root <${scan.rootName}>`
    );
  }
  const listings: RawSanctionsListing[] = [];
  for (const target of pending) {
    const programs = target.setIds
      .map((setId) => programBySet[setId])
      .filter((program): program is string => program !== undefined);
    for (const listing of target.listings) {
      listings.push({ ...listing, programs });
    }
  }
  return {
    source_published: isoDatePrefix(scan.rootAttrs.date),
    listings,
    scanned_addresses: Object.keys(scanned).sort(compareCodePoints)
  };
};
