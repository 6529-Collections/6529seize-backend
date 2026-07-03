import { getAnimationPaths } from '@/nftsLoop/nft-animation-paths';
import {
  calculateNftHodlRate,
  getMemeTokenIdsForEditionSizeFloorRefresh,
  resolveNftEditionSizeFloor
} from '@/nftsLoop/nfts';

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

describe('NFT edition size floor calculations', () => {
  it('refreshes the on-chain edition size floor only for the latest Meme', () => {
    const nftMap = new Map([
      [
        'memes-515',
        {
          nft: {
            contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
            id: 515
          }
        }
      ],
      [
        'memes-516',
        {
          nft: {
            contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
            id: 516
          }
        }
      ],
      [
        'gradient-1000',
        {
          nft: {
            contract: '0x0c58ef43ff3032005e472cb5709f8908acb00205',
            id: 1000
          }
        }
      ]
    ]);

    expect(getMemeTokenIdsForEditionSizeFloorRefresh(nftMap)).toEqual([516]);
  });

  it('uses resolved Meme floors and current supply for non-Memes', () => {
    expect(
      resolveNftEditionSizeFloor(
        {
          contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
          id: 516,
          supply: 176,
          edition_size_floor: 176
        },
        { 516: 310 }
      )
    ).toBe(310);

    expect(
      resolveNftEditionSizeFloor(
        {
          contract: '0x0c58ef43ff3032005e472cb5709f8908acb00205',
          id: 1,
          supply: 101,
          edition_size_floor: 101
        },
        { 1: 310 }
      )
    ).toBe(101);
  });

  it('keeps an existing Meme floor when no fresh on-chain floor is available', () => {
    expect(
      resolveNftEditionSizeFloor(
        {
          contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
          id: 516,
          supply: 176,
          edition_size_floor: 305
        },
        {}
      )
    ).toBe(305);
  });

  it('calculates hodl rate from max supply over calculation edition size', () => {
    expect(
      calculateNftHodlRate(1000, {
        supply: 176,
        edition_size_floor: 305
      })
    ).toBe(1000 / 305);

    expect(
      calculateNftHodlRate(100, {
        supply: 320,
        edition_size_floor: 310
      })
    ).toBe(1);
  });
});
