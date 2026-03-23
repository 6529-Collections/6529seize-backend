import { getAnimationPaths } from '@/nftsLoop/nft-animation-paths';

describe('getAnimationPaths', () => {
  it('keeps the original html animation url instead of rewriting it to CloudFront', () => {
    const originalAnimationUrl = 'https://example.com/interactive/index.html';

    expect(
      getAnimationPaths('0xabc', 1, originalAnimationUrl, { format: 'HTML' })
    ).toEqual({
      animation: originalAnimationUrl
    });
  });

  it('does not return an html animation path when the metadata url is invalid', () => {
    expect(
      getAnimationPaths('0xabc', 1, 'not-a-url', { format: 'HTML' })
    ).toEqual({});
  });
});
