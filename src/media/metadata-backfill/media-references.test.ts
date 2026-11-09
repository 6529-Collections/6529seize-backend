import fc from 'fast-check';
import { CLOUDFRONT_LINK } from '@/constants';
import {
  backfillScopeKey,
  extractMediaKeyReferences,
  invalidationPathsFor,
  isReferencePrefixOf,
  textOf
} from './media-references';

const UPLOAD = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

describe('extractMediaKeyReferences', () => {
  it('finds every Memes additional_media URL in the metadata JSON', () => {
    const value = JSON.stringify({
      artist_profile_media: [`${CLOUDFRONT_LINK}/drops/${UPLOAD}/profile.jpg`],
      artwork_commentary_media: [
        `${CLOUDFRONT_LINK}/drops/author_7/commentary.png`
      ],
      preview_image: `${CLOUDFRONT_LINK}/drops/${UPLOAD}/preview.webp?v=2`,
      promo_video: `${CLOUDFRONT_LINK}/drops/${UPLOAD}/promo.mp4#t=1`
    });
    expect(extractMediaKeyReferences(value)).toEqual(
      expect.arrayContaining([
        `drops/${UPLOAD}/profile.jpg`,
        'drops/author_7/commentary.png',
        `drops/${UPLOAD}/preview.webp`,
        `drops/${UPLOAD}/promo.mp4`
      ])
    );
  });

  it('reads escaped, encoded and bare keys and markdown links', () => {
    const text = [
      `{"u":"https:\\/\\/d3lqz0a4bldqgf.cloudfront.net\\/drops\\/${UPLOAD}\\/a.png"}`,
      `![art](${CLOUDFRONT_LINK}/drops/${UPLOAD}/Final%20Art.png).`,
      `see waves/author_1/${UPLOAD}.gif, thanks`
    ].join('\n');
    const references = extractMediaKeyReferences(text);
    expect(references).toEqual(
      expect.arrayContaining([
        `drops/${UPLOAD}/a.png`,
        `drops/${UPLOAD}/Final%20Art.png`,
        `drops/${UPLOAD}/Final Art.png`,
        `waves/author_1/${UPLOAD}.gif`
      ])
    );
  });

  it('ignores words that only end in drops or waves', () => {
    expect(
      extractMediaKeyReferences('raindrops/x/y.png microwaves/a/b')
    ).toEqual([]);
    expect(extractMediaKeyReferences('')).toEqual([]);
  });

  it('a file name starting with a bracket still excludes its folder', () => {
    const key = `drops/${UPLOAD}/(final) art.png`;
    const references = extractMediaKeyReferences(
      JSON.stringify({ preview_image: `${CLOUDFRONT_LINK}/${key}` })
    );
    expect(references).toEqual([`drops/${UPLOAD}/`]);
    expect(isReferencePrefixOf(references[0], key)).toBe(true);
  });

  it('a key with a space yields a prefix that still names it', () => {
    const key = `drops/author_3/${UPLOAD}/My Photo (1).jpg`;
    const [reference] = extractMediaKeyReferences(`url: ${key} end`);
    expect(reference).toBe(`drops/author_3/${UPLOAD}/My`);
    expect(isReferencePrefixOf(reference, key)).toBe(true);
  });

  it('always recovers a reference matching any key written in a URL', () => {
    const segment = fc
      .array(fc.constantFrom(...'abcXYZ019 -_().,%!'.split('')), {
        minLength: 1,
        maxLength: 12
      })
      .map((chars) => chars.join(''));
    fc.assert(
      fc.property(segment, (fileName) => {
        const key = `drops/${UPLOAD}/${fileName}`;
        const url = `${CLOUDFRONT_LINK}/${key
          .split('/')
          .map(encodeURIComponent)
          .join('/')}`;
        const references = extractMediaKeyReferences(
          JSON.stringify({ preview_image: url })
        );
        expect(
          references.some((reference) => isReferencePrefixOf(reference, key))
        ).toBe(true);
      })
    );
  });
});

describe('isReferencePrefixOf', () => {
  it('matches by prefix from the folder slash on', () => {
    expect(isReferencePrefixOf('drops/author_1/', 'drops/author_1/a.png')).toBe(
      true
    );
    expect(isReferencePrefixOf('drops/author_1', 'drops/author_1/a.png')).toBe(
      false
    );
    expect(
      isReferencePrefixOf('drops/author_1/a', 'drops/author_1/a.png')
    ).toBe(true);
    expect(isReferencePrefixOf('drops/x', 'drops/x')).toBe(true);
  });
});

describe('backfillScopeKey', () => {
  it('accepts only drop and wave media on the media CDN', () => {
    expect(backfillScopeKey(`${CLOUDFRONT_LINK}/drops/${UPLOAD}/a.png`)).toBe(
      `drops/${UPLOAD}/a.png`
    );
    expect(backfillScopeKey(`${CLOUDFRONT_LINK}/waves/author_1/a.png`)).toBe(
      'waves/author_1/a.png'
    );
    expect(backfillScopeKey(`${CLOUDFRONT_LINK}/pfp/a.png`)).toBeNull();
    expect(backfillScopeKey('https://example.com/drops/a/b.png')).toBeNull();
    expect(backfillScopeKey('ipfs://abc')).toBeNull();
  });
});

describe('invalidationPathsFor', () => {
  it('covers the canonical encoding and the path clients were given', () => {
    expect(
      invalidationPathsFor(`drops/${UPLOAD}/My Photo.jpg`, [
        `${CLOUDFRONT_LINK}/drops/${UPLOAD}/My%20Photo.jpg?x=1`,
        'not a url'
      ])
    ).toEqual([`/drops/${UPLOAD}/My%20Photo.jpg`]);
    expect(invalidationPathsFor('drops/a/(1).png', [])).toEqual([
      '/drops/a/(1).png'
    ]);
  });
});

describe('textOf', () => {
  it('stringifies JSON columns and buffers', () => {
    expect(textOf(null)).toBe('');
    expect(textOf('x')).toBe('x');
    expect(textOf(Buffer.from('y'))).toBe('y');
    expect(textOf({ a: 'drops/x/y' })).toBe('{"a":"drops/x/y"}');
  });
});
