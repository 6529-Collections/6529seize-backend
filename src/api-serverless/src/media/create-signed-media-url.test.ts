import { S3Client } from '@aws-sdk/client-s3';
import {
  SINGLE_PUT_UPLOAD_URL_EXPIRY,
  UploadMediaService
} from './upload-media.service';

describe('single-PUT presigned upload URLs', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, S3_BUCKET: 'test-bucket' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function service() {
    // Real presigner, static credentials, no network.
    const s3 = new S3Client({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' }
    });
    return new UploadMediaService(() => s3);
  }

  it('signs the declared content type and uses a short expiry', async () => {
    const result = await service().createSignedDistributionPhotoUploadUrl({
      content_type: 'image/png',
      file_name: 'photo.png',
      contract: '0x33fd426905f149f8376e227d0c9d3340aad17af1',
      card_id: 1
    });

    expect(result.content_type).toBe('image/png');
    const url = new URL(result.upload_url);
    const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders') ?? '';
    expect(signedHeaders.split(';')).toEqual(
      expect.arrayContaining(['content-type', 'host'])
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe(
      String(SINGLE_PUT_UPLOAD_URL_EXPIRY.toSeconds())
    );
    expect(SINGLE_PUT_UPLOAD_URL_EXPIRY.toSeconds()).toBe(15 * 60);
    // The type is bound by the signature, not carried as a query value.
    expect(url.searchParams.has('Content-Type')).toBe(false);
  });
});
