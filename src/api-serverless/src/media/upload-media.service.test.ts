import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadMediaService } from './upload-media.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn()
}));

describe('UploadMediaService', () => {
  const getSignedUrlMock = jest.mocked(getSignedUrl);

  beforeEach(() => {
    jest.resetAllMocks();
    process.env.NODE_ENV = 'test';
    process.env.S3_BUCKET = 'test-bucket';
    getSignedUrlMock.mockResolvedValue('https://signed-upload-url.example');
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

    expect(first.media_url).toMatch(
      /^https:\/\/d3lqz0a4bldqgf\.cloudfront\.net\/distribution\/test\/0xabcd\/42\/.+\.JPG$/
    );
    expect(second.media_url).toMatch(
      /^https:\/\/d3lqz0a4bldqgf\.cloudfront\.net\/distribution\/test\/0xabcd\/42\/.+\.JPG$/
    );
    expect(first.media_url).not.toBe(second.media_url);
    expect(first.upload_url).toBe('https://signed-upload-url.example');
    expect(second.upload_url).toBe('https://signed-upload-url.example');
  });
});
