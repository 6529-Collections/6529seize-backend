import * as mysql from 'mysql';
import {
  IN_LIST_MAX_BYTES,
  IN_LIST_MAX_VALUES,
  inListPages
} from './in-list-pages';

const listBytes = (page: string[]) =>
  Buffer.byteLength(
    page.map((value) => mysql.escape(value)).join(', '),
    'utf8'
  );

describe('inListPages', () => {
  it('pages by count when values are small', () => {
    const values = Array.from({ length: 205 }, (_, index) => `id-${index}`);
    const pages = inListPages(values);
    expect(pages.map((page) => page.length)).toEqual([100, 100, 5]);
    expect(pages.flat()).toEqual(values);
  });

  it('pages by escaped bytes at the boundary, keeping order', () => {
    // Each escapes to 2 + 2 * 98 bytes plus the separator.
    const values = Array.from({ length: 150 }, () => "'".repeat(98));
    const pages = inListPages(values);
    expect(pages.flat()).toEqual(values);
    for (const page of pages) {
      expect(page.length).toBeLessThanOrEqual(IN_LIST_MAX_VALUES);
      expect(listBytes(page)).toBeLessThanOrEqual(IN_LIST_MAX_BYTES);
    }
    // A page is closed only when the next value would not fit.
    for (const page of pages.slice(0, -1))
      expect(listBytes([...page, "'".repeat(98)]) + 2).toBeGreaterThan(
        IN_LIST_MAX_BYTES
      );
  });

  it('returns no pages for no values', () => {
    expect(inListPages([])).toEqual([]);
  });
});
