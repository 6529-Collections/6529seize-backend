import * as fc from 'fast-check';
import { MEMES_CONTRACT } from '@/constants';
import {
  changeOfRecord,
  recordContentOf,
  SubscriptionChange,
  SubscriptionRecordError
} from './subscription-records';

const CARD = `${MEMES_CONTRACT.toLowerCase()}:581`;

describe('subscription records', () => {
  it('parses each of the four types', () => {
    expect(changeOfRecord('subs.mode', '', { automatic: true })).toEqual({
      type: 'subs.mode',
      automatic: true
    });
    expect(changeOfRecord('subs.all-editions', '', { all: false })).toEqual({
      type: 'subs.all-editions',
      all: false
    });
    expect(changeOfRecord('subs.card', CARD, { subscribed: true })).toEqual({
      type: 'subs.card',
      contract: MEMES_CONTRACT,
      tokenId: 581,
      subscribed: true
    });
    expect(changeOfRecord('subs.count', CARD, { count: 3 })).toEqual({
      type: 'subs.count',
      contract: MEMES_CONTRACT,
      tokenId: 581,
      count: 3
    });
  });

  it.each([
    ['an unknown type', 'subs.other', '', { automatic: true }],
    ['a key on the mode', 'subs.mode', 'x', { automatic: true }],
    ['a key on all editions', 'subs.all-editions', CARD, { all: true }],
    ['an unset (no body)', 'subs.mode', '', null],
    ['an extra member', 'subs.mode', '', { automatic: true, all: true }],
    ['another member', 'subs.mode', '', { all: true }],
    ['no member', 'subs.card', CARD, {}],
    ['a string for a boolean', 'subs.card', CARD, { subscribed: 'true' }],
    ['a number for a boolean', 'subs.all-editions', '', { all: 1 }],
    ['a count of 0', 'subs.count', CARD, { count: 0 }],
    ['a negative count', 'subs.count', CARD, { count: -2 }],
    ['a fractional count', 'subs.count', CARD, { count: 1.5 }],
    ['a count as text', 'subs.count', CARD, { count: '2' }],
    ['a count out of range', 'subs.count', CARD, { count: 2 ** 53 }],
    ['no card key', 'subs.card', '', { subscribed: true }],
    [
      'another contract',
      'subs.card',
      `0x${'0'.repeat(39)}1:581`,
      { subscribed: true }
    ],
    [
      'an uppercase contract',
      'subs.card',
      `${MEMES_CONTRACT}:581`,
      { subscribed: true }
    ],
    [
      'a leading zero',
      'subs.card',
      `${CARD.slice(0, -3)}0581`,
      { subscribed: true }
    ],
    ['token 0', 'subs.card', `${CARD.slice(0, -3)}0`, { subscribed: true }],
    [
      'a token too long',
      'subs.count',
      `${CARD.slice(0, -3)}${'9'.repeat(17)}`,
      { count: 1 }
    ],
    [
      'a token out of the safe range',
      'subs.count',
      `${CARD.slice(0, -3)}${'9'.repeat(16)}`,
      { count: 1 }
    ],
    ['a space in the key', 'subs.card', ` ${CARD}`, { subscribed: true }]
  ])('refuses %s', (_name, type, key, body) => {
    expect(() =>
      changeOfRecord(type, key, body as Record<string, unknown> | null)
    ).toThrow(SubscriptionRecordError);
  });

  it('keys a card by the lowercase contract and the token', () => {
    expect(
      recordContentOf({
        type: 'subs.count',
        contract: MEMES_CONTRACT,
        tokenId: 12,
        count: 2
      })
    ).toEqual({
      type: 'subs.count',
      key: `${MEMES_CONTRACT.toLowerCase()}:12`,
      body: { count: 2 }
    });
  });

  it('reads back every change a record is made for', () => {
    const token = fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER });
    const change: fc.Arbitrary<SubscriptionChange> = fc.oneof(
      fc.boolean().map((automatic) => ({
        type: 'subs.mode' as const,
        automatic
      })),
      fc.boolean().map((all) => ({ type: 'subs.all-editions' as const, all })),
      fc.tuple(token, fc.boolean()).map(([tokenId, subscribed]) => ({
        type: 'subs.card' as const,
        contract: MEMES_CONTRACT,
        tokenId,
        subscribed
      })),
      fc
        .tuple(token, fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }))
        .map(([tokenId, count]) => ({
          type: 'subs.count' as const,
          contract: MEMES_CONTRACT,
          tokenId,
          count
        }))
    );
    fc.assert(
      fc.property(change, (original) => {
        const content = recordContentOf(original);
        expect(changeOfRecord(content.type, content.key, content.body)).toEqual(
          original
        );
      })
    );
  });
});
