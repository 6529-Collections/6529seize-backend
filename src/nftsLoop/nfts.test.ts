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
  const NOW_MILLIS = new Date('2026-07-04T00:00:00Z').getTime();
  const DAY_MILLIS = 24 * 60 * 60 * 1000;

  it('refreshes only the latest Meme when older Memes are outside the refresh window', () => {
    const nftMap = new Map([
      [
        'memes-515',
        {
          nft: {
            contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
            id: 515,
            mint_date: new Date(NOW_MILLIS - 45 * DAY_MILLIS)
          }
        }
      ],
      [
        'memes-516',
        {
          nft: {
            contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
            id: 516,
            mint_date: new Date(NOW_MILLIS - 40 * DAY_MILLIS)
          }
        }
      ],
      [
        'gradient-1000',
        {
          nft: {
            contract: '0x0c58ef43ff3032005e472cb5709f8908acb00205',
            id: 1000,
            mint_date: new Date(NOW_MILLIS - DAY_MILLIS)
          }
        }
      ]
    ]);

    expect(
      getMemeTokenIdsForEditionSizeFloorRefresh(nftMap, NOW_MILLIS)
    ).toEqual([516]);
  });

  it('also refreshes non-latest Memes minted inside the refresh window', () => {
    const nftMap = new Map([
      [
        'memes-514',
        {
          nft: {
            contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
            id: 514,
            mint_date: new Date(NOW_MILLIS - 60 * DAY_MILLIS)
          }
        }
      ],
      [
        'memes-515',
        {
          nft: {
            contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
            id: 515,
            mint_date: new Date(NOW_MILLIS - 8 * DAY_MILLIS)
          }
        }
      ],
      [
        'memes-516',
        {
          nft: {
            contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
            id: 516,
            mint_date: new Date(NOW_MILLIS - DAY_MILLIS)
          }
        }
      ]
    ]);

    expect(
      getMemeTokenIdsForEditionSizeFloorRefresh(nftMap, NOW_MILLIS)
    ).toEqual([515, 516]);
  });

  it('still refreshes the latest Meme when its mint_date is missing', () => {
    const nftMap = new Map([
      [
        'memes-516',
        {
          nft: {
            contract: '0x33FD426905F149f8376e227d0C9D3340AaD17aF1',
            id: 516,
            mint_date: undefined
          }
        }
      ]
    ]);

    expect(
      getMemeTokenIdsForEditionSizeFloorRefresh(nftMap, NOW_MILLIS)
    ).toEqual([516]);
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
