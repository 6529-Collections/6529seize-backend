import fc from 'fast-check';
import { BadRequestException } from '@/exceptions';
import { parseDropSignedEventsBatchIds } from './device-signing.validation';

describe('parseDropSignedEventsBatchIds', () => {
  it('splits, trims and de-duplicates ids in request order', () => {
    expect(parseDropSignedEventsBatchIds(' b, a ,b,c', 50)).toEqual([
      'b',
      'a',
      'c'
    ]);
    expect(parseDropSignedEventsBatchIds('only', 50)).toEqual(['only']);
  });

  it('reads a repeated parameter as one list', () => {
    expect(parseDropSignedEventsBatchIds(['a,b', 'c'], 50)).toEqual([
      'a',
      'b',
      'c'
    ]);
  });

  it('accepts exactly the maximum number of ids', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `drop-${i}`);
    expect(parseDropSignedEventsBatchIds(ids.join(','), 50)).toEqual(ids);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['blank', '  '],
    ['an object', { a: 'b' }],
    ['an empty id', 'a,,b'],
    ['a trailing comma', 'a,'],
    ['an id longer than a drop id', 'x'.repeat(101)],
    ['too many ids', Array.from({ length: 51 }, (_, i) => `d${i}`).join(',')]
  ])('rejects %s', (_, value) => {
    expect(() => parseDropSignedEventsBatchIds(value, 50)).toThrow(
      BadRequestException
    );
  });

  it('counts ids before removing duplicates', () => {
    expect(() =>
      parseDropSignedEventsBatchIds(Array(51).fill('same').join(','), 50)
    ).toThrow('at most 50');
  });

  it('returns at most the maximum number of distinct, non-empty ids', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z0-9-]{1,12}$/), {
          minLength: 1,
          maxLength: 60
        }),
        (ids) => {
          const raw = ids.join(',');
          if (ids.length > 50) {
            expect(() => parseDropSignedEventsBatchIds(raw, 50)).toThrow(
              BadRequestException
            );
            return;
          }
          const parsed = parseDropSignedEventsBatchIds(raw, 50);
          expect(parsed).toEqual(Array.from(new Set(ids)));
        }
      )
    );
  });
});
