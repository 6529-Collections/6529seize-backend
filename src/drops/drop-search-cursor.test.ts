import * as fc from 'fast-check';
import {
  decodeDropSearchCursor,
  encodeDropSearchCursor
} from './drop-search-cursor';

describe('drop search cursors', () => {
  it('round-trips bounded database sort keys', () => {
    fc.assert(
      fc.property(
        fc.record({
          created_at: fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
          id: fc.string({ minLength: 1, maxLength: 100 })
        }),
        (cursor) => {
          expect(
            decodeDropSearchCursor(encodeDropSearchCursor(cursor))
          ).toEqual(cursor);
        }
      )
    );
  });
  it.each([
    'not-json',
    '',
    Buffer.from('{}').toString('base64url'),
    Buffer.from('{"created_at":-1,"id":"id"}').toString('base64url'),
    Buffer.from('{"created_at":1,"id":""}').toString('base64url')
  ])('rejects invalid cursors %s', (cursor) => {
    expect(() => decodeDropSearchCursor(cursor)).toThrow(
      'Invalid search cursor'
    );
  });
});
