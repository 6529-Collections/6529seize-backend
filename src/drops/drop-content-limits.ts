export const DROP_PART_MAX_UTF16_CODE_UNITS = 25_000;
export const DROP_PART_MAX_UTF8_BYTES = 65_535;
export const DROP_TOTAL_MAX_UTF16_CODE_UNITS = 50_000;

export type DropContentLimitViolation =
  | {
      readonly kind: 'part-utf16';
      readonly limit: number;
      readonly partIndex: number;
    }
  | {
      readonly kind: 'part-utf8';
      readonly limit: number;
      readonly partIndex: number;
    }
  | { readonly kind: 'total-utf16'; readonly limit: number };

interface DropContentPart {
  readonly content?: string | null;
}

export function getDropContentLimitViolation(
  parts: readonly DropContentPart[]
): DropContentLimitViolation | null {
  let totalUtf16CodeUnits = 0;

  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const content = parts[partIndex]?.content ?? '';
    const utf16CodeUnits = content.length;
    if (utf16CodeUnits > DROP_PART_MAX_UTF16_CODE_UNITS) {
      return {
        kind: 'part-utf16',
        limit: DROP_PART_MAX_UTF16_CODE_UNITS,
        partIndex: partIndex + 1
      };
    }

    if (Buffer.byteLength(content, 'utf8') > DROP_PART_MAX_UTF8_BYTES) {
      return {
        kind: 'part-utf8',
        limit: DROP_PART_MAX_UTF8_BYTES,
        partIndex: partIndex + 1
      };
    }

    totalUtf16CodeUnits += utf16CodeUnits;
    if (totalUtf16CodeUnits > DROP_TOTAL_MAX_UTF16_CODE_UNITS) {
      return {
        kind: 'total-utf16',
        limit: DROP_TOTAL_MAX_UTF16_CODE_UNITS
      };
    }
  }

  return null;
}

export function formatDropContentLimitViolation(
  violation: DropContentLimitViolation
): string {
  switch (violation.kind) {
    case 'part-utf16':
      return `drop part ${violation.partIndex} content must be at most ${violation.limit} UTF-16 code units`;
    case 'part-utf8':
      return `drop part ${violation.partIndex} content must be at most ${violation.limit} UTF-8 bytes`;
    case 'total-utf16':
      return `total content across all drop parts must be at most ${violation.limit} UTF-16 code units`;
  }
}
