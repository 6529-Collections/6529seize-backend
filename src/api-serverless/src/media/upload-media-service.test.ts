import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CLOUDFRONT_LINK } from '@/constants';
import { UploadMediaService } from '@/api/media/upload-media.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn()
}));

const ORIGINAL_ENV = { ...process.env };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('UploadMediaService', () => {
  const getSignedUrlMock = jest.mocked(getSignedUrl);

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      S3_BUCKET: 'test-bucket'
    };
    getSignedUrlMock.mockResolvedValue('https://signed-upload-url.example');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('creates unique distribution photo keys for repeated uploads', async () => {
    const service = new UploadMediaService(
      () =>
        ({
          send: jest.fn()
        }) as any
    );

    const first = await service.createSignedDistributionPhotoUploadUrl({
      content_type: 'image/jpeg',
      file_name: 'photo.JPG',
      contract: '0xABCD',
      card_id: 42
    });
    const second = await service.createSignedDistributionPhotoUploadUrl({
      content_type: 'image/jpeg',
      file_name: 'photo.JPG',
      contract: '0xABCD',
      card_id: 42
    });

    const expectedUrlPattern = new RegExp(
      `^${escapeRegex(CLOUDFRONT_LINK)}/distribution/test/0xabcd/42-.+\\.JPG$`
    );

    expect(first.media_url).toMatch(expectedUrlPattern);
    expect(second.media_url).toMatch(expectedUrlPattern);
    expect(first.media_url).not.toBe(second.media_url);
    expect(first.upload_url).toBe('https://signed-upload-url.example');
    expect(second.upload_url).toBe('https://signed-upload-url.example');
  });
});
