import * as mysql from 'mysql';

/** Most values in one `in (...)` list. */
export const IN_LIST_MAX_VALUES = 100;
/**
 * Most bytes of one escaped `in (...)` list. With the rest of a statement this
 * keeps it below the RDS Proxy pin size (PROXY_PIN_STATEMENT_BYTES, 16 KB).
 */
export const IN_LIST_MAX_BYTES = 12_000;

/**
 * Splits values into pages for `in (...)` lists: at most `maxValues` values
 * and `maxBytes` escaped bytes (as the executor expands them) per page, in
 * order. A single value larger than `maxBytes` gets a page of its own.
 */
export function inListPages<T extends string>(
  values: readonly T[],
  { maxValues = IN_LIST_MAX_VALUES, maxBytes = IN_LIST_MAX_BYTES } = {}
): T[][] {
  const pages: T[][] = [];
  let page: T[] = [];
  let bytes = 0;
  for (const value of values) {
    // The executor joins escaped values with ', '.
    const size = Buffer.byteLength(mysql.escape(value), 'utf8') + 2;
    if (page.length && (page.length >= maxValues || bytes + size > maxBytes)) {
      pages.push(page);
      page = [];
      bytes = 0;
    }
    page.push(value);
    bytes += size;
  }
  if (page.length) pages.push(page);
  return pages;
}
