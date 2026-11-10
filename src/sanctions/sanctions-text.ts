import type { IsoDate } from '@/sanctions/sanctions-list.types';

const WHITESPACE_RUN = /\s+/g;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Text normalization for names, programmes and labels: Unicode NFC, every
 * run of ECMAScript whitespace (`\s`) becomes one space, then trim.
 */
export function normalizeText(value: string): string {
  return value.normalize('NFC').replace(WHITESPACE_RUN, ' ').trim();
}

/** `normalizeText`, with empty results and non-strings mapped to null. */
export function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = normalizeText(value);
  return normalized === '' ? null : normalized;
}

/**
 * Sorted, de-duplicated, normalized strings. Order is Unicode code point
 * order (equal to UTF-8 byte order), so other languages sort identically.
 */
export function sortedUniqueTexts(values: ReadonlyArray<string>): string[] {
  const unique: Record<string, true> = {};
  for (const value of values) {
    const normalized = normalizeText(value);
    if (normalized !== '') {
      unique[normalized] = true;
    }
  }
  return Object.keys(unique).sort(compareCodePoints);
}

/** Compares two strings by Unicode code point (UTF-8 byte order). */
export function compareCodePoints(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') {
    return false;
  }
  const match = ISO_DATE.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function zeroPad(value: number, width: number): string {
  let text = String(value);
  while (text.length < width) {
    text = `0${text}`;
  }
  return text;
}

export function toIsoDate(year: number, month: number, day: number): IsoDate {
  const iso = `${zeroPad(year, 4)}-${zeroPad(month, 2)}-${zeroPad(day, 2)}`;
  if (!isIsoDate(iso)) {
    throw new Error(`Invalid calendar date ${year}-${month}-${day}`);
  }
  return iso;
}

/** Parses `DD/MM/YYYY` (UK). Null for empty or malformed input. */
export function parseDayMonthYear(value: string | null): IsoDate | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((value ?? '').trim());
  return match
    ? toIsoDate(Number(match[3]), Number(match[2]), Number(match[1]))
    : null;
}

/** Parses `MM/DD/YYYY` (OFAC). Null for empty or malformed input. */
export function parseMonthDayYear(value: string | null): IsoDate | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((value ?? '').trim());
  return match
    ? toIsoDate(Number(match[3]), Number(match[1]), Number(match[2]))
    : null;
}

/** Parses `YYYY.M.D` (Japan MoF). Null for empty or malformed input. */
export function parseDottedYearMonthDay(value: string | null): IsoDate | null {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec((value ?? '').trim());
  return match
    ? toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]))
    : null;
}

/** The `YYYY-MM-DD` prefix of an ISO date or date-time. */
export function isoDatePrefix(
  value: string | null | undefined
): IsoDate | null {
  const prefix = (value ?? '').trim().slice(0, 10);
  return isIsoDate(prefix) ? prefix : null;
}
