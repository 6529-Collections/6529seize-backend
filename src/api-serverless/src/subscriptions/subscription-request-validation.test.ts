import fc from 'fast-check';
import { MEMES_CONTRACT } from '@/constants';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  MAX_UPCOMING_CARD_COUNT,
  resolveUpcomingCardCount,
  subscriptionCountRequestSchema,
  subscriptionToggleRequestSchema
} from './subscription-request-validation';

describe('resolveUpcomingCardCount', () => {
  it('defaults to 3 when absent or unparsable', () => {
    expect(resolveUpcomingCardCount(undefined)).toBe(3);
    expect(resolveUpcomingCardCount('abc')).toBe(3);
  });

  it('keeps the counts the web app requests', () => {
    for (const count of [1, 3, 10, 41]) {
      expect(resolveUpcomingCardCount(String(count))).toBe(count);
    }
  });

  it('clamps into [1, MAX_UPCOMING_CARD_COUNT]', () => {
    expect(resolveUpcomingCardCount('0')).toBe(1);
    expect(resolveUpcomingCardCount('-5')).toBe(1);
    expect(resolveUpcomingCardCount('1000000')).toBe(MAX_UPCOMING_CARD_COUNT);
    fc.assert(
      fc.property(fc.integer(), (value) => {
        const count = resolveUpcomingCardCount(String(value));
        expect(count).toBeGreaterThanOrEqual(1);
        expect(count).toBeLessThanOrEqual(MAX_UPCOMING_CARD_COUNT);
      })
    );
  });
});

describe('subscription request schemas', () => {
  const validCount = { contract: MEMES_CONTRACT, token_id: 450, count: 2 };

  it('accepts the requests the web app sends', () => {
    expect(
      getValidatedByJoiOrThrow(validCount, subscriptionCountRequestSchema)
    ).toEqual(validCount);
    expect(
      getValidatedByJoiOrThrow(
        { contract: MEMES_CONTRACT, token_id: 450, subscribed: false },
        subscriptionToggleRequestSchema
      )
    ).toEqual({ contract: MEMES_CONTRACT, token_id: 450, subscribed: false });
  });

  it('normalises the Memes contract address casing', () => {
    expect(
      getValidatedByJoiOrThrow(
        { ...validCount, contract: MEMES_CONTRACT.toLowerCase() },
        subscriptionCountRequestSchema
      ).contract
    ).toBe(MEMES_CONTRACT);
  });

  it('rejects other contracts', () => {
    expect(() =>
      getValidatedByJoiOrThrow(
        {
          ...validCount,
          contract: '0x0000000000000000000000000000000000000001'
        },
        subscriptionCountRequestSchema
      )
    ).toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects count %p', (count) => {
    expect(() =>
      getValidatedByJoiOrThrow(
        { ...validCount, count },
        subscriptionCountRequestSchema
      )
    ).toThrow();
  });

  it.each([0, -3, 2.5])('rejects token_id %p', (tokenId) => {
    expect(() =>
      getValidatedByJoiOrThrow(
        { ...validCount, token_id: tokenId },
        subscriptionCountRequestSchema
      )
    ).toThrow();
    expect(() =>
      getValidatedByJoiOrThrow(
        { contract: MEMES_CONTRACT, token_id: tokenId, subscribed: true },
        subscriptionToggleRequestSchema
      )
    ).toThrow();
  });
});
