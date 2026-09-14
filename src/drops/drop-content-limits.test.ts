import {
  DROP_PART_MAX_UTF16_CODE_UNITS,
  DROP_PART_MAX_UTF8_BYTES,
  DROP_TOTAL_MAX_UTF16_CODE_UNITS,
  getDropContentLimitViolation
} from './drop-content-limits';

describe('drop content limits', () => {
  it('accepts every exact boundary', () => {
    expect(
      getDropContentLimitViolation([
        { content: 'a'.repeat(DROP_PART_MAX_UTF16_CODE_UNITS) },
        { content: 'b'.repeat(DROP_PART_MAX_UTF16_CODE_UNITS) }
      ])
    ).toBeNull();
    expect(
      getDropContentLimitViolation([
        { content: '漢'.repeat(DROP_PART_MAX_UTF8_BYTES / 3) }
      ])
    ).toBeNull();
    expect(
      getDropContentLimitViolation([
        { content: '😀'.repeat(DROP_PART_MAX_UTF16_CODE_UNITS / 2) }
      ])
    ).toBeNull();
  });

  it('rejects the first unit beyond each boundary', () => {
    expect(
      getDropContentLimitViolation([
        { content: 'a'.repeat(DROP_PART_MAX_UTF16_CODE_UNITS + 1) }
      ])
    ).toEqual({
      kind: 'part-utf16',
      limit: DROP_PART_MAX_UTF16_CODE_UNITS,
      partIndex: 1
    });
    expect(
      getDropContentLimitViolation([
        { content: '漢'.repeat(DROP_PART_MAX_UTF8_BYTES / 3 + 1) }
      ])
    ).toEqual({
      kind: 'part-utf8',
      limit: DROP_PART_MAX_UTF8_BYTES,
      partIndex: 1
    });
    expect(
      getDropContentLimitViolation([
        { content: 'a'.repeat(DROP_TOTAL_MAX_UTF16_CODE_UNITS / 2) },
        { content: 'b'.repeat(DROP_TOTAL_MAX_UTF16_CODE_UNITS / 2) },
        { content: 'c' }
      ])
    ).toEqual({
      kind: 'total-utf16',
      limit: DROP_TOTAL_MAX_UTF16_CODE_UNITS
    });
  });
});
