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

  it('returns original and compressed video paths for mp4 animations', () => {
    expect(
      getAnimationPaths('0xabc', 1, 'https://example.com/animation.mp4', {
        format: 'MP4'
      })
    ).toEqual({
      animation: 'https://d3lqz0a4bldqgf.cloudfront.net/videos/0xabc/1.MP4',
      compressedAnimation:
        'https://d3lqz0a4bldqgf.cloudfront.net/videos/0xabc/scaledx750/1.MP4'
    });
  });

  it('does not throw on malformed animation_details json', () => {
    expect(() =>
      getAnimationPaths(
        '0xabc',
        1,
        'https://example.com/interactive/index.html',
        '{not-json'
      )
    ).not.toThrow();

    expect(
      getAnimationPaths(
        '0xabc',
        1,
        'https://example.com/interactive/index.html',
        '{not-json'
      )
    ).toEqual({
      animation: 'https://example.com/interactive/index.html'
    });
  });
});
