import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CLOUDFRONT_LINK } from '@/constants';
import { UploadMediaService } from '@/api/media/upload-media.service';
import { ApiDropMediaStatus } from '@/api/generated/models/ApiDropMediaStatus';

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

  it('includes a sanitized slug of the original name in drop media keys', async () => {
    const service = new UploadMediaService(
      () =>
        ({
          send: jest.fn()
        }) as any
    );

    const result = await service.createSingedDropMediaUploadUrl({
      content_type: 'image/jpeg',
      file_name: 'My Vacation Photo!.JPG',
      author_id: 'author-123'
    });

    expect(result.media_url).toMatch(
      new RegExp(
        `^${escapeRegex(CLOUDFRONT_LINK)}/drops/author_author-123/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/My-Vacation-Photo\\.JPG$`
      )
    );
  });

  it('falls back to a UUID-only drop media key when the name has no safe characters', async () => {
    const service = new UploadMediaService(
      () =>
        ({
          send: jest.fn()
        }) as any
    );

    const result = await service.createSingedDropMediaUploadUrl({
      content_type: 'image/jpeg',
      file_name: '🎉🎊.jpg',
      author_id: 'author-123'
    });

    expect(result.media_url).toMatch(
      new RegExp(
        `^${escapeRegex(CLOUDFRONT_LINK)}/drops/author_author-123/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/\\1\\.jpg$`
      )
    );
  });

  it('includes a sanitized slug of the original name in wave media keys', async () => {
    const service = new UploadMediaService(
      () =>
        ({
          send: jest.fn()
        }) as any
    );

    const result = await service.createSingedWaveMediaUploadUrl({
      content_type: 'image/png',
      file_name: 'Banner Image.PNG',
      author_id: 'author-xyz'
    });

    const uuidPattern =
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    expect(result.media_url).toMatch(
      new RegExp(
        `^${escapeRegex(CLOUDFRONT_LINK)}/waves/author_author-xyz/Banner-Image-${uuidPattern}\\.PNG$`
      )
    );
  });

  it('creates image multipart uploads in the ingest bucket when sanitization is enabled', async () => {
    process.env.DROP_MEDIA_SANITIZE_IMAGES = 'true';
    process.env.DROP_MEDIA_INGEST_S3_BUCKET = 'ingest-bucket';
    process.env.DROP_MEDIA_INGEST_STAGE = 'staging';

    const publicS3 = {
      send: jest.fn()
    };
    const ingestS3 = {
      send: jest.fn().mockResolvedValue({ UploadId: 'upload-123' })
    };
    const uploadsDb = {
      createUpload: jest.fn()
    };

    const service = new UploadMediaService(
      () => publicS3 as any,
      () => ingestS3 as any,
      uploadsDb as any,
      jest.fn()
    );

    const result = await service.getDropMediaMultipartUploadKeyAndUploadId({
      content_type: 'image/jpeg',
      file_name: 'phone-photo.jpg',
      author_id: 'author-123'
    });

    expect(result.upload_id).toBe('upload-123');
    expect(result.media_upload_id).toBeDefined();
    expect(result.media_status).toBe(ApiDropMediaStatus.Uploading);
    expect(publicS3.send).not.toHaveBeenCalled();
    expect(ingestS3.send).toHaveBeenCalledTimes(1);
    expect(ingestS3.send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'ingest-bucket',
      Key: expect.stringMatching(
        /^staging\/drop-media-ingest\/drops\/author_author-123\//
      ),
      ContentType: 'image/jpeg'
    });
    expect(uploadsDb.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        profile_id: 'author-123',
        public_key: result.key,
        ingest_bucket: 'ingest-bucket',
        s3_upload_id: 'upload-123',
        declared_mime_type: 'image/jpeg',
        status: 'uploading'
      })
    );
  });

  it('keeps non-image multipart uploads in the public bucket when sanitization is enabled', async () => {
    process.env.DROP_MEDIA_SANITIZE_IMAGES = 'true';

    const publicS3 = {
      send: jest.fn().mockResolvedValue({ UploadId: 'video-upload-123' })
    };
    const ingestS3 = {
      send: jest.fn()
    };
    const uploadsDb = {
      createUpload: jest.fn()
    };

    const service = new UploadMediaService(
      () => publicS3 as any,
      () => ingestS3 as any,
      uploadsDb as any,
      jest.fn()
    );

    const result = await service.getDropMediaMultipartUploadKeyAndUploadId({
      content_type: 'video/mp4',
      file_name: 'clip.mp4',
      author_id: 'author-123'
    });

    expect(result.upload_id).toBe('video-upload-123');
    expect(result.media_upload_id).toBeUndefined();
    expect(publicS3.send).toHaveBeenCalledTimes(1);
    expect(publicS3.send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'test-bucket',
      Key: result.key,
      ContentType: 'video/mp4'
    });
    expect(ingestS3.send).not.toHaveBeenCalled();
    expect(uploadsDb.createUpload).not.toHaveBeenCalled();
  });

  it('signs image upload parts against the ingest object when a tracked upload exists', async () => {
    const publicS3 = { send: jest.fn() };
    const ingestS3 = { send: jest.fn() };
    const uploadsDb = {
      findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue({
        profile_id: 'author-123',
        ingest_bucket: 'ingest-bucket',
        ingest_key: 'staging/drop-media-ingest/drops/key.jpg'
      })
    };

    const service = new UploadMediaService(
      () => publicS3 as any,
      () => ingestS3 as any,
      uploadsDb as any,
      jest.fn()
    );

    const url = await service.getSignedUrlForPartOfMultipartUpload({
      key: 'drops/key.jpg',
      upload_id: 'upload-123',
      part_no: 2,
      authenticatedProfileId: 'author-123'
    });

    expect(url).toBe('https://signed-upload-url.example');
    expect(getSignedUrlMock.mock.calls[0][1].input).toMatchObject({
      Bucket: 'ingest-bucket',
      Key: 'staging/drop-media-ingest/drops/key.jpg',
      PartNumber: 2,
      UploadId: 'upload-123'
    });
  });

  it('rejects tracked upload part signing for another profile', async () => {
    const uploadsDb = {
      findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue({
        profile_id: 'author-123',
        ingest_bucket: 'ingest-bucket',
        ingest_key: 'staging/drop-media-ingest/drops/key.jpg'
      })
    };

    const service = new UploadMediaService(
      () =>
        ({
          send: jest.fn()
        }) as any,
      () =>
        ({
          send: jest.fn()
        }) as any,
      uploadsDb as any,
      jest.fn()
    );

    await expect(
      service.getSignedUrlForPartOfMultipartUpload({
        key: 'drops/key.jpg',
        upload_id: 'upload-123',
        part_no: 2,
        authenticatedProfileId: 'author-456'
      })
    ).rejects.toThrow('Cannot write this media upload');
  });

  it('enqueues sanitization after completing an ingest multipart upload', async () => {
    const ingestS3 = {
      send: jest.fn().mockResolvedValue({})
    };
    const uploadsDb = {
      findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue({
        id: 'media-upload-123',
        profile_id: 'author-123',
        status: 'uploading',
        ingest_bucket: 'ingest-bucket',
        ingest_key: 'staging/drop-media-ingest/drops/key.jpg',
        s3_upload_id: 'upload-123',
        public_url: `${CLOUDFRONT_LINK}/drops/key.jpg`
      }),
      transitionStatus: jest.fn().mockResolvedValue(true)
    };
    const enqueue = jest.fn().mockResolvedValue(undefined);

    const service = new UploadMediaService(
      () =>
        ({
          send: jest.fn()
        }) as any,
      () => ingestS3 as any,
      uploadsDb as any,
      enqueue
    );

    const result = await service.completeMultipartUpload({
      key: 'drops/key.jpg',
      upload_id: 'upload-123',
      parts: [{ etag: '"etag-1"', part_no: 1 }],
      authenticatedProfileId: 'author-123'
    });

    expect(ingestS3.send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'ingest-bucket',
      Key: 'staging/drop-media-ingest/drops/key.jpg',
      UploadId: 'upload-123'
    });
    expect(uploadsDb.transitionStatus).toHaveBeenCalledWith({
      id: 'media-upload-123',
      fromStatuses: ['uploading'],
      toStatus: 'processing'
    });
    expect(enqueue).toHaveBeenCalledWith({
      mediaUploadId: 'media-upload-123'
    });
    expect(result).toEqual({
      media_url: `${CLOUDFRONT_LINK}/drops/key.jpg`,
      media_upload_id: 'media-upload-123',
      media_status: ApiDropMediaStatus.Processing
    });
  });

  it('keeps upload processing when sanitization enqueue fails after completion', async () => {
    const ingestS3 = {
      send: jest.fn().mockResolvedValue({})
    };
    const uploadsDb = {
      findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue({
        id: 'media-upload-123',
        profile_id: 'author-123',
        status: 'uploading',
        ingest_bucket: 'ingest-bucket',
        ingest_key: 'staging/drop-media-ingest/drops/key.jpg',
        s3_upload_id: 'upload-123',
        public_url: `${CLOUDFRONT_LINK}/drops/key.jpg`
      }),
      transitionStatus: jest.fn().mockResolvedValue(true)
    };
    const enqueue = jest.fn().mockRejectedValue(new Error('sqs maybe sent'));

    const service = new UploadMediaService(
      () =>
        ({
          send: jest.fn()
        }) as any,
      () => ingestS3 as any,
      uploadsDb as any,
      enqueue
    );

    await expect(
      service.completeMultipartUpload({
        key: 'drops/key.jpg',
        upload_id: 'upload-123',
        parts: [{ etag: '"etag-1"', part_no: 1 }],
        authenticatedProfileId: 'author-123'
      })
    ).rejects.toThrow(
      'Failed to enqueue sanitization for media upload media-upload-123'
    );
    expect(uploadsDb.transitionStatus).toHaveBeenCalledTimes(1);
    expect(uploadsDb.transitionStatus).toHaveBeenCalledWith({
      id: 'media-upload-123',
      fromStatuses: ['uploading'],
      toStatus: 'processing'
    });
  });

  it('re-enqueues sanitization when completion is retried for a processing upload', async () => {
    const ingestS3 = {
      send: jest.fn()
    };
    const uploadsDb = {
      findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue({
        id: 'media-upload-123',
        profile_id: 'author-123',
        status: 'processing',
        ingest_bucket: 'ingest-bucket',
        ingest_key: 'staging/drop-media-ingest/drops/key.jpg',
        s3_upload_id: 'upload-123',
        public_url: `${CLOUDFRONT_LINK}/drops/key.jpg`
      }),
      transitionStatus: jest.fn()
    };
    const enqueue = jest.fn().mockResolvedValue(undefined);

    const service = new UploadMediaService(
      () =>
        ({
          send: jest.fn()
        }) as any,
      () => ingestS3 as any,
      uploadsDb as any,
      enqueue
    );

    const result = await service.completeMultipartUpload({
      key: 'drops/key.jpg',
      upload_id: 'upload-123',
      parts: [{ etag: '"etag-1"', part_no: 1 }],
      authenticatedProfileId: 'author-123'
    });

    expect(ingestS3.send).not.toHaveBeenCalled();
    expect(uploadsDb.transitionStatus).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith({
      mediaUploadId: 'media-upload-123'
    });
    expect(result).toEqual({
      media_url: `${CLOUDFRONT_LINK}/drops/key.jpg`,
      media_upload_id: 'media-upload-123',
      media_status: ApiDropMediaStatus.Processing
    });
  });

  it('rejects tracked upload completion for another profile', async () => {
    const uploadsDb = {
      findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue({
        id: 'media-upload-123',
        profile_id: 'author-123',
        ingest_bucket: 'ingest-bucket',
        ingest_key: 'staging/drop-media-ingest/drops/key.jpg',
        s3_upload_id: 'upload-123',
        public_url: `${CLOUDFRONT_LINK}/drops/key.jpg`
      })
    };

    const service = new UploadMediaService(
      () =>
        ({
          send: jest.fn()
        }) as any,
      () =>
        ({
          send: jest.fn()
        }) as any,
      uploadsDb as any,
      jest.fn()
    );

    await expect(
      service.completeMultipartUpload({
        key: 'drops/key.jpg',
        upload_id: 'upload-123',
        parts: [{ etag: '"etag-1"', part_no: 1 }],
        authenticatedProfileId: 'author-456'
      })
    ).rejects.toThrow('Cannot write this media upload');
  });

  it('rejects single PUT image upload prep while sanitization is enabled', async () => {
    process.env.DROP_MEDIA_SANITIZE_IMAGES = 'true';

    const service = new UploadMediaService(
      () =>
        ({
          send: jest.fn()
        }) as any
    );

    await expect(
      service.createSingedDropMediaUploadUrl({
        content_type: 'image/jpeg',
        file_name: 'phone-photo.jpg',
        author_id: 'author-123'
      })
    ).rejects.toThrow(
      'Image uploads must use multipart upload while image sanitization is enabled'
    );
  });
});
