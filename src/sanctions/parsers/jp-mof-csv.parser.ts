import { parseCsv } from '@/sanctions/sanctions-csv';
import {
  normalizeOptionalText,
  parseDottedYearMonthDay,
  toIsoDate
} from '@/sanctions/sanctions-text';
import { decodeUtf8 } from '@/sanctions/sanctions-xml';
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

export const JP_MOF_CSV_PARSER_ID = 'jp-mof-csv/1';

/** The consolidated list's file name carries its publication date. */
export const JP_MOF_FILE_NAME = /^shisantouketsu(\d{4})(\d{2})(\d{2})\.csv$/;

const COLUMN = {
  category: '区分',
  number: '番号',
  noticeDate: '告示日付',
  nameEnglish: '氏名（英語）',
  nameJapanese: '氏名（日本語）',
  otherInformation: 'その他の情報'
} as const;

type ColumnIndex = Record<keyof typeof COLUMN, number>;

function columnIndex(header: string[]): ColumnIndex {
  const index = {} as ColumnIndex;
  for (const key of Object.keys(COLUMN) as Array<keyof typeof COLUMN>) {
    const position = header.indexOf(COLUMN[key]);
    if (position === -1) {
      throw new SanctionsParseError('jp-mof', `missing column ${COLUMN[key]}`);
    }
    index[key] = position;
  }
  return index;
}

function rowListings(
  row: string[],
  column: ColumnIndex
): RawSanctionsListing[] {
  const text = row[column.otherInformation] ?? '';
  const found = addressesInText(text);
  if (found.length === 0) {
    return [];
  }
  const entryId = normalizeOptionalText(row[column.number]);
  if (entryId === null) {
    throw new SanctionsParseError('jp-mof', 'row with an address but no 番号');
  }
  const category = normalizeOptionalText(row[column.category]);
  const entity =
    normalizeOptionalText(row[column.nameEnglish]) ??
    normalizeOptionalText(row[column.nameJapanese]);
  const listedOn = parseDottedYearMonthDay(row[column.noticeDate] ?? null);
  return found.map((address) => ({
    address: address.address,
    entry_id: entryId,
    entity,
    programs: category ? [`${COLUMN.category} ${category}`] : [],
    labels: labelsOf(address.label),
    listed_on: listedOn,
    valid_until: null
  }));
}

/**
 * Japan MoF consolidated asset-freeze list (CSV, UTF-8 with BOM). Addresses
 * are written in the `その他の情報` ("other information") column after
 * `暗号資産アドレス：` ("crypto-asset address"); only that column is read,
 * because `外務省告示情報` repeats it.
 */
export const parseJpMofCsv: SanctionsSourceParser = (
  files: ReadonlyArray<SanctionsInputFile>
): ParsedSanctionsSource => {
  const file = requireSingleFile('jp-mof', files);
  const nameMatch = JP_MOF_FILE_NAME.exec(file.name);
  if (!nameMatch) {
    throw new SanctionsParseError(
      'jp-mof',
      `input file name ${file.name} does not carry the list date`
    );
  }
  const rows = parseCsv(decodeUtf8(file.bytes));
  if (rows.length === 0) {
    throw new SanctionsParseError('jp-mof', 'empty CSV');
  }
  const column = columnIndex(rows[0]);
  const listings: RawSanctionsListing[] = [];
  for (let i = 1; i < rows.length; i++) {
    for (const listing of rowListings(rows[i], column)) {
      listings.push(listing);
    }
  }
  return {
    source_published: toIsoDate(
      Number(nameMatch[1]),
      Number(nameMatch[2]),
      Number(nameMatch[3])
    ),
    listings,
    scanned_addresses: scanFilesForAddresses(files)
  };
};
