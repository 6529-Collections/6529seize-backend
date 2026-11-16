import { CLOUDFRONT_LINK } from '@/constants/media';
import {
  isDropMediaPublicUrl,
  matchDropMediaUploadUrl,
  publicUploadMediaUrl,
  resolveAdditionalMediaPreview,
  resolveDropMediaDeliveryUrl
} from './drop-media-public-url';

const STAGING_ORIGIN = 'https://media.staging.6529.io';
const key = 'drops/example/art%20work.png';
const legacy = `${CLOUDFRONT_LINK}/${key}`;
const staging = `${STAGING_ORIGIN}/${key}`;

afterEach(() => jest.restoreAllMocks());

it('uses staging for new and stored drop uploads while preserving URL suffixes', () => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    DROP_MEDIA_INGEST_STAGE: 'staging',
    FILE_SERVER_URL: `${STAGING_ORIGIN}/`
  });
  expect(publicUploadMediaUrl(key)).toBe(staging);
  expect(resolveDropMediaDeliveryUrl(`${legacy}?x=1#art`)).toBe(
    `${staging}?x=1#art`
  );
  expect(resolveDropMediaDeliveryUrl(staging)).toBe(staging);
  expect(isDropMediaPublicUrl(new URL(staging))).toBe(true);
  expect(
    isDropMediaPublicUrl(new URL(`${STAGING_ORIGIN}/waves/avatar.png`))
  ).toBe(false);
  expect(matchDropMediaUploadUrl(legacy, staging)).toBe(true);
  expect(matchDropMediaUploadUrl(legacy, `${staging}?x=1`)).toBe(false);
  expect(matchDropMediaUploadUrl(legacy, `${staging}.other`)).toBe(false);
  expect(publicUploadMediaUrl('waves/avatar.png')).toBe(
    `${CLOUDFRONT_LINK}/waves/avatar.png`
  );
  expect(resolveDropMediaDeliveryUrl('ipfs://example')).toBe('ipfs://example');
  expect(
    JSON.parse(
      resolveAdditionalMediaPreview(
        JSON.stringify({ preview_image: legacy, extra: 'kept' })
      )
    )
  ).toEqual({ preview_image: staging, extra: 'kept' });
  expect(resolveAdditionalMediaPreview(`{${legacy}`)).toBe(`{${legacy}`);
});

it('preserves production URL generation and identity checks', () => {
  jest.replaceProperty(process, 'env', {
    ...process.env,
    DROP_MEDIA_INGEST_STAGE: 'prod',
    FILE_SERVER_URL: `${STAGING_ORIGIN}/`
  });
  expect(publicUploadMediaUrl(key)).toBe(legacy);
  expect(resolveDropMediaDeliveryUrl(legacy)).toBe(legacy);
  expect(isDropMediaPublicUrl(new URL(staging))).toBe(false);
  expect(matchDropMediaUploadUrl(legacy, staging)).toBe(false);
});
