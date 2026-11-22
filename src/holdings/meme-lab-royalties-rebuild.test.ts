import { readMemeLabRoyalties } from './meme-lab-royalties-rebuild';

describe('readMemeLabRoyalties', () => {
  it('reads the checked-in file', () => {
    expect(() => readMemeLabRoyalties()).not.toThrow();
  });

  it('returns the rows in token order', () => {
    expect(
      readMemeLabRoyalties({
        '12': { primary_royalty_split: 0.5, secondary_royalty_split: 0.25 },
        '3': { primary_royalty_split: 0, secondary_royalty_split: 1 }
      })
    ).toEqual([
      { token_id: 3, primary: 0, secondary: 1 },
      { token_id: 12, primary: 0.5, secondary: 0.25 }
    ]);
  });

  it.each([
    ['a token id that is not a whole number', '1.5', 0.5, 0.5],
    ['a split above one', '1', 50, 0.5],
    ['a negative split', '1', 0.5, -0.1],
    ['a split that is not a number', '1', Number.NaN, 0.5]
  ])('rejects %s', (_case, tokenId, primary, secondary) => {
    expect(() =>
      readMemeLabRoyalties({
        [tokenId]: {
          primary_royalty_split: primary,
          secondary_royalty_split: secondary
        }
      })
    ).toThrow(`Invalid Meme Lab royalty splits for token ${tokenId}`);
  });
});
