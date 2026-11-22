import {
  CLOUDFRONT_LINK,
  getAcceptedMediaOrigins,
  getUserMediaOrigin,
  isAcceptedMediaOrigin,
  isAcceptedMediaUrl
} from '@/constants';

describe('media origins', () => {
  const original = process.env.FILE_SERVER_URL;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.FILE_SERVER_URL;
    } else {
      process.env.FILE_SERVER_URL = original;
    }
  });

  it('defaults to the prod CDN when FILE_SERVER_URL is unset', () => {
    delete process.env.FILE_SERVER_URL;
    expect(getUserMediaOrigin()).toBe(CLOUDFRONT_LINK);
    expect(getAcceptedMediaOrigins()).toEqual([CLOUDFRONT_LINK]);
  });

  it('keeps prod on the prod CDN only', () => {
    process.env.FILE_SERVER_URL = `${CLOUDFRONT_LINK}/`;
    expect(getUserMediaOrigin()).toBe(CLOUDFRONT_LINK);
    expect(getAcceptedMediaOrigins()).toEqual([CLOUDFRONT_LINK]);
    expect(isAcceptedMediaOrigin('https://media.staging.6529.io')).toBe(false);
  });

  it('uses the configured media host and still accepts the prod CDN', () => {
    process.env.FILE_SERVER_URL = 'https://media.staging.6529.io/';
    expect(getUserMediaOrigin()).toBe('https://media.staging.6529.io');
    expect(getAcceptedMediaOrigins()).toEqual([
      'https://media.staging.6529.io',
      CLOUDFRONT_LINK
    ]);
    expect(isAcceptedMediaOrigin(CLOUDFRONT_LINK)).toBe(true);
  });

  it('ignores a non-https or malformed FILE_SERVER_URL', () => {
    process.env.FILE_SERVER_URL = 'http://media.staging.6529.io/';
    expect(getUserMediaOrigin()).toBe(CLOUDFRONT_LINK);
    process.env.FILE_SERVER_URL = 'not a url';
    expect(getUserMediaOrigin()).toBe(CLOUDFRONT_LINK);
  });

  it('accepts only URLs written exactly on an accepted origin', () => {
    process.env.FILE_SERVER_URL = 'https://media.staging.6529.io/';
    expect(
      isAcceptedMediaUrl('https://media.staging.6529.io/drops/a.jpg')
    ).toBe(true);
    expect(isAcceptedMediaUrl(`${CLOUDFRONT_LINK}/waves/a.png`)).toBe(true);
    expect(isAcceptedMediaUrl('https://media.staging.6529.io.evil.com/a')).toBe(
      false
    );
    expect(isAcceptedMediaUrl('https://x@media.staging.6529.io/a')).toBe(false);
    expect(isAcceptedMediaUrl('https://media.staging.6529.io:444/a')).toBe(
      false
    );
    expect(isAcceptedMediaUrl('https://example.com/a.jpg')).toBe(false);
    expect(isAcceptedMediaUrl('nope')).toBe(false);
  });
});
