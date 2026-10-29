import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { CLOUDFRONT_LINK } from '@/constants';
import { UploadMediaService } from '@/api/media/upload-media.service';
import { ApiDropMediaStatus } from '@/api/generated/models/ApiDropMediaStatus';
import { S3Client } from '@aws-sdk/client-s3';
import { DropMediaUploadsDb } from '@/drops/drop-media-uploads.db';
import { DropMediaUploadEntity } from '@/entities/IDropMediaUpload';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn()
}));

const ORIGINAL_ENV = { ...process.env };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeImageUploadService() {
  return new UploadMediaService(
    () => ({ send: jest.fn() }) as any,
    () =>
      ({
        send: jest.fn().mockResolvedValue({ UploadId: 'image-upload' })
      }) as any,
    { createUpload: jest.fn() } as any,
    jest.fn()
  );
}

function makePublicUploadService() {
  const publicS3 = {
    send: jest.fn().mockResolvedValue({ UploadId: 'private-video-session' })
  };
  const ingestS3 = { send: jest.fn() };
  let record: DropMediaUploadEntity | null = null;
  const uploadsDb = {
    createUpload: jest.fn(async (value: DropMediaUploadEntity) => {
      record = value;
    }),
    findByPublicKeyAndS3UploadId: jest.fn(
      async ({
        publicKey,
        s3UploadId
      }: {
        publicKey: string;
        s3UploadId: string;
      }) =>
        record?.public_key === publicKey && record?.s3_upload_id === s3UploadId
          ? record
          : null
    ),
    updateUpload: jest.fn(
      async ({
        id,
        patch
      }: Parameters<DropMediaUploadsDb['updateUpload']>[0]) => {
        if (record?.id === id) Object.assign(record, patch);
      }
    )
  };
  const enqueue = jest.fn();
  return {
    service: new UploadMediaService(
      () => publicS3 as unknown as S3Client,
      () => ingestS3 as unknown as S3Client,
      uploadsDb as unknown as DropMediaUploadsDb,
      enqueue
    ),
    publicS3,
    ingestS3,
    uploadsDb,
    enqueue,
    record: () => record
  };
}

describe('UploadMediaService', () => {
  const getSignedUrlMock = jest.mocked(getSignedUrl);

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      S3_BUCKET: 'test-bucket',
      DROP_MEDIA_INGEST_S3_BUCKET: 'ingest-bucket'
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
    const service = makeImageUploadService();

    const result = await service.getDropMediaMultipartUploadKeyAndUploadId({
      content_type: 'image/jpeg',
      file_name: 'My Vacation Photo!.JPG',
      author_id: 'author-123'
    });

    expect(`${CLOUDFRONT_LINK}/${result.key}`).toMatch(
      new RegExp(
        `^${escapeRegex(CLOUDFRONT_LINK)}/drops/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/My-Vacation-Photo\\.JPG$`
      )
    );
  });

  it('falls back to a UUID-only drop media key when the name has no safe characters', async () => {
    const service = makeImageUploadService();

    const result = await service.getDropMediaMultipartUploadKeyAndUploadId({
      content_type: 'image/jpeg',
      file_name: '🎉🎊.jpg',
      author_id: 'author-123'
    });

    expect(`${CLOUDFRONT_LINK}/${result.key}`).toMatch(
      new RegExp(
        `^${escapeRegex(CLOUDFRONT_LINK)}/drops/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/\\1\\.jpg$`
      )
    );
  });

  it('includes a sanitized slug of the original name in wave media keys', async () => {
    const service = makeImageUploadService();

    const result = await service.getWaveMediaMultipartUploadKeyAndUploadId({
      content_type: 'image/png',
      file_name: 'Banner Image.PNG',
      author_id: 'author-xyz'
    });

    const uuidPattern =
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    expect(`${CLOUDFRONT_LINK}/${result.key}`).toMatch(
      new RegExp(
        `^${escapeRegex(CLOUDFRONT_LINK)}/waves/author_author-xyz/Banner-Image-${uuidPattern}\\.PNG$`
      )
    );
  });

  it.each(['true', 'false', undefined])(
    'requires private image ingest when privacy sanitization is %s',
    async (enabled) => {
      if (enabled === undefined) delete process.env.DROP_MEDIA_SANITIZE_IMAGES;
      else process.env.DROP_MEDIA_SANITIZE_IMAGES = enabled;
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
          /^staging\/drop-media-ingest\/drops\/[0-9a-f-]{36}\//
        ),
        ContentType: 'image/jpeg'
      });
      // The sanitizer sets public caching when it publishes the cleaned copy.
      expect(ingestS3.send.mock.calls[0][0].input.CacheControl).toBeUndefined();
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
    }
  );

  it.each(['true', 'false'])(
    'converts AVIF through private ingest when sanitization is %s',
    async (enabled) => {
      process.env.DROP_MEDIA_SANITIZE_IMAGES = enabled;
      process.env.DROP_MEDIA_INGEST_S3_BUCKET = 'ingest-bucket';
      const publicS3 = { send: jest.fn() };
      const ingestS3 = {
        send: jest.fn().mockResolvedValue({ UploadId: 'upload-avif' })
      };
      const uploadsDb = { createUpload: jest.fn() };
      const service = new UploadMediaService(
        () => publicS3 as any,
        () => ingestS3 as any,
        uploadsDb as any,
        jest.fn()
      );
      const result = await service.getDropMediaMultipartUploadKeyAndUploadId({
        content_type: 'image/avif',
        file_name: 'photo.AVIF',
        author_id: 'author-123'
      });
      expect(result.key).toMatch(/\/photo\.webp$/);
      expect(result.media_upload_id).toBeDefined();
      expect(publicS3.send).not.toHaveBeenCalled();
      expect(ingestS3.send.mock.calls[0][0].input).toMatchObject({
        Bucket: 'ingest-bucket',
        ContentType: 'image/avif'
      });
      expect(uploadsDb.createUpload).toHaveBeenCalledWith(
        expect.objectContaining({
          declared_mime_type: 'image/avif',
          public_key: result.key,
          public_url: `${CLOUDFRONT_LINK}/${result.key}`
        })
      );
      const repeated = await service.getDropMediaMultipartUploadKeyAndUploadId({
        content_type: 'image/avif',
        file_name: 'photo.AVIF',
        author_id: 'author-123'
      });
      expect(repeated.key).toMatch(/\/photo\.webp$/);
      expect(repeated.key).not.toBe(result.key);
      expect(repeated.media_upload_id).not.toBe(result.media_upload_id);
    }
  );

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
      ContentType: 'video/mp4',
      CacheControl: 'public, max-age=31536000, immutable'
    });
    expect(ingestS3.send).not.toHaveBeenCalled();
    expect(result.key).not.toContain('author-123');
    expect(uploadsDb.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        profile_id: 'author-123',
        public_key: result.key,
        ingest_bucket: 'test-bucket',
        ingest_key: result.key,
        declared_mime_type: 'video/mp4',
        status: 'uploading'
      })
    );
  });

  it('keeps new video upload ownership private and uses public S3 without the image sanitizer', async () => {
    const { service, publicS3, ingestS3, uploadsDb, enqueue, record } =
      makePublicUploadService();
    const started = await service.getDropMediaMultipartUploadKeyAndUploadId({
      content_type: 'video/mp4',
      file_name: 'clip.mp4',
      author_id: 'private-owner'
    });
    expect(started.key).not.toContain('private-owner');
    expect(started.key).not.toContain('author_');
    await expect(
      service.getSignedUrlForPartOfMultipartUpload({
        ...started,
        part_no: 1,
        authenticatedProfileId: 'other'
      })
    ).rejects.toThrow('Cannot write this media upload');
    await service.getSignedUrlForPartOfMultipartUpload({
      ...started,
      part_no: 1,
      authenticatedProfileId: 'private-owner'
    });
    expect(
      getSignedUrlMock.mock.calls[getSignedUrlMock.mock.calls.length - 1]?.[0]
    ).toBe(publicS3);
    publicS3.send.mockResolvedValue({ Key: started.key });
    await expect(
      service.completeMultipartUpload({
        ...started,
        parts: [{ etag: 'etag', part_no: 1 }],
        authenticatedProfileId: 'other'
      })
    ).rejects.toThrow('Cannot write this media upload');
    const completed = await service.completeMultipartUpload({
      ...started,
      parts: [{ etag: 'etag', part_no: 1 }],
      authenticatedProfileId: 'private-owner'
    });
    expect(completed).toEqual({
      media_url: `${CLOUDFRONT_LINK}/${started.key}`,
      media_status: ApiDropMediaStatus.Ready
    });
    expect(uploadsDb.updateUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ status: 'ready' })
      })
    );
    expect(record()).toMatchObject({ status: 'ready' });
    publicS3.send.mockClear();
    await expect(
      service.completeMultipartUpload({
        ...started,
        parts: [{ etag: 'etag', part_no: 1 }],
        authenticatedProfileId: 'private-owner'
      })
    ).resolves.toEqual(completed);
    expect(publicS3.send).not.toHaveBeenCalled();
    expect(ingestS3.send).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('keeps single PUT drop media paths unlinkable while recording their owner privately', async () => {
    const { service, uploadsDb, publicS3, record } = makePublicUploadService();
    const result = await service.createSingedDropMediaUploadUrl({
      content_type: 'audio/mpeg',
      file_name: 'sound.mp3',
      author_id: 'private-owner'
    });
    expect(result.media_url).not.toContain('private-owner');
    expect(result.media_url).not.toContain('author_');
    expect(uploadsDb.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({
        profile_id: 'private-owner',
        public_url: result.media_url,
        status: 'ready'
      })
    );
    expect(result).not.toHaveProperty('upload_id');
    expect(result).not.toHaveProperty('media_upload_id');
    expect(record()?.s3_upload_id).toMatch(/^single-put:/);
    await expect(
      service.completeMultipartUpload({
        key: new URL(result.media_url).pathname.slice(1),
        upload_id: 'guessed-multipart-session',
        parts: [{ etag: 'etag', part_no: 1 }],
        authenticatedProfileId: 'private-owner'
      })
    ).rejects.toThrow('Cannot write this media upload');
    expect(publicS3.send).not.toHaveBeenCalled();
  });

  it.each(['unknown key', 'wrong upload id'])(
    'rejects signing and completion for a random-path upload with %s',
    async (mismatch) => {
      const { service, publicS3, ingestS3, uploadsDb } =
        makePublicUploadService();
      const started = await service.getDropMediaMultipartUploadKeyAndUploadId({
        content_type: 'video/mp4',
        file_name: 'clip.mp4',
        author_id: 'private-owner'
      });
      publicS3.send.mockClear();
      const request = {
        key:
          mismatch === 'unknown key'
            ? 'drops/12345678-1234-1234-1234-123456789012/clip.mp4'
            : started.key,
        upload_id:
          mismatch === 'wrong upload id' ? 'wrong-session' : started.upload_id,
        authenticatedProfileId: 'private-owner'
      };
      const signaturesBefore = getSignedUrlMock.mock.calls.length;

      await expect(
        service.getSignedUrlForPartOfMultipartUpload({ ...request, part_no: 1 })
      ).rejects.toThrow('Cannot write this media upload');
      await expect(
        service.completeMultipartUpload({
          ...request,
          parts: [{ etag: 'etag', part_no: 1 }]
        })
      ).rejects.toThrow('Cannot write this media upload');

      expect(uploadsDb.findByPublicKeyAndS3UploadId).toHaveBeenCalledWith({
        publicKey: request.key,
        s3UploadId: request.upload_id
      });
      expect(getSignedUrlMock).toHaveBeenCalledTimes(signaturesBefore);
      expect(publicS3.send).not.toHaveBeenCalled();
      expect(ingestS3.send).not.toHaveBeenCalled();
      expect(uploadsDb.updateUpload).not.toHaveBeenCalled();
    }
  );

  it('stores long-lived caching on public multipart uploads with unique keys', async () => {
    const publicS3 = {
      send: jest.fn().mockResolvedValue({ UploadId: 'upload-123' })
    };
    const service = new UploadMediaService(
      () => publicS3 as any,
      () => ({ send: jest.fn() }) as any,
      { createUpload: jest.fn() } as any,
      jest.fn()
    );

    const distribution =
      await service.getDistributionPhotoMultipartUploadKeyAndUploadId({
        content_type: 'image/jpeg',
        file_name: 'photo.jpg',
        contract: '0xABCD',
        card_id: 42
      });
    const wave = await service.getWaveMediaMultipartUploadKeyAndUploadId({
      content_type: 'video/mp4',
      file_name: 'clip.mp4',
      author_id: 'author-123'
    });

    expect(publicS3.send.mock.calls.map(([command]) => command.input)).toEqual([
      expect.objectContaining({
        Bucket: 'test-bucket',
        Key: distribution.key,
        CacheControl: 'public, max-age=31536000, immutable'
      }),
      expect.objectContaining({
        Bucket: 'test-bucket',
        Key: wave.key,
        CacheControl: 'public, max-age=31536000, immutable'
      })
    ]);
  });

  it('keeps presigned single uploads free of signed headers the client does not send', async () => {
    const service = new UploadMediaService(() => ({ send: jest.fn() }) as any);

    await service.createSignedDistributionPhotoUploadUrl({
      content_type: 'image/jpeg',
      file_name: 'photo.jpg',
      contract: '0xABCD',
      card_id: 42
    });

    // A signed Cache-Control header would reject uploads from current clients.
    expect(getSignedUrlMock.mock.calls[0][1].input).not.toHaveProperty(
      'CacheControl'
    );
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
        declared_mime_type: 'image/jpg',
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
    expect(uploadsDb.transitionStatus).toHaveBeenNthCalledWith(1, {
      id: 'media-upload-123',
      fromStatuses: ['uploading'],
      toStatus: 'completing'
    });
    expect(uploadsDb.transitionStatus).toHaveBeenNthCalledWith(2, {
      id: 'media-upload-123',
      fromStatuses: ['completing'],
      toStatus: 'processing'
    });
    expect(enqueue).toHaveBeenCalledWith({
      mediaUploadId: 'media-upload-123'
    });
    expect(result).toEqual({
      media_url: `${CLOUDFRONT_LINK}/drops/key.jpg`,
      mime_type: 'image/jpeg',
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
    expect(uploadsDb.transitionStatus).toHaveBeenCalledTimes(2);
    expect(uploadsDb.transitionStatus).toHaveBeenNthCalledWith(1, {
      id: 'media-upload-123',
      fromStatuses: ['uploading'],
      toStatus: 'completing'
    });
    expect(uploadsDb.transitionStatus).toHaveBeenNthCalledWith(2, {
      id: 'media-upload-123',
      fromStatuses: ['completing'],
      toStatus: 'processing'
    });
  });

  it('rejects untracked drop media part signing for another profile', async () => {
    const uploadsDb = {
      findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue(null)
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
        key: 'drops/author_author-123/upload/file.mp4',
        upload_id: 'upload-123',
        part_no: 1,
        authenticatedProfileId: 'author-456'
      })
    ).rejects.toThrow('Cannot write this media upload');
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

  it.each(['true', 'false', undefined])(
    'rejects single PUT images regardless of privacy policy %s',
    async (enabled) => {
      if (enabled === undefined) delete process.env.DROP_MEDIA_SANITIZE_IMAGES;
      else process.env.DROP_MEDIA_SANITIZE_IMAGES = enabled;

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
        'Image uploads must use multipart upload so the file format can be validated'
      );
    }
  );
});

describe('mandatory image validation gate', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it.each(['true', 'false', undefined])(
    'captures privacy choice %s on the private multipart object',
    async (enabled) => {
      process.env.S3_BUCKET = 'public-bucket';
      process.env.DROP_MEDIA_INGEST_S3_BUCKET = 'ingest-bucket';
      if (enabled === undefined) delete process.env.DROP_MEDIA_SANITIZE_IMAGES;
      else process.env.DROP_MEDIA_SANITIZE_IMAGES = enabled;
      const publicSend = jest.fn();
      const ingestSend = jest.fn().mockResolvedValue({ UploadId: 'upload' });
      const createUpload = jest.fn();
      const service = new UploadMediaService(
        () => ({ send: publicSend }) as any,
        () => ({ send: ingestSend }) as any,
        { createUpload } as any,
        jest.fn()
      );
      for (const source of ['drop', 'wave'] as const) {
        const input = {
          file_name: 'image.png',
          content_type: 'image/png',
          author_id: 'author'
        };
        const response =
          source === 'drop'
            ? await service.getDropMediaMultipartUploadKeyAndUploadId(input)
            : await service.getWaveMediaMultipartUploadKeyAndUploadId(input);
        expect(response.media_status).toBe(ApiDropMediaStatus.Uploading);
        expect(response.media_upload_id).toBeDefined();
      }
      expect(publicSend).not.toHaveBeenCalled();
      expect(ingestSend.mock.calls.map(([c]) => c.input)).toEqual([
        expect.objectContaining({
          Bucket: 'ingest-bucket',
          Metadata: { 'sanitize-image-metadata': String(enabled === 'true') }
        }),
        expect.objectContaining({
          Bucket: 'ingest-bucket',
          Metadata: { 'sanitize-image-metadata': String(enabled === 'true') }
        })
      ]);
      expect(createUpload.mock.calls.map(([u]) => u.source)).toEqual([
        'drop',
        'wave'
      ]);
    }
  );

  it.each([
    'drops/author_author/old/photo.JPG',
    'waves/author_author/old-name'
  ])(
    'blocks untracked public image session %s before signing or completing',
    async (key) => {
      const send = jest.fn();
      const service = new UploadMediaService(
        () => ({ send }) as any,
        () => ({ send }) as any,
        {
          findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue(null)
        } as any,
        jest.fn()
      );
      await expect(
        service.getSignedUrlForPartOfMultipartUpload({
          key,
          upload_id: 'old',
          part_no: 1,
          authenticatedProfileId: 'author'
        })
      ).rejects.toThrow('Restart this image upload');
      await expect(
        service.completeMultipartUpload({
          key,
          upload_id: 'old',
          parts: [{ part_no: 1, etag: 'etag' }],
          authenticatedProfileId: 'author'
        })
      ).rejects.toThrow('Restart this image upload');
      expect(send).not.toHaveBeenCalled();
    }
  );

  it('keeps untracked video completion working', async () => {
    process.env.S3_BUCKET = 'public-bucket';
    const send = jest
      .fn()
      .mockResolvedValue({ Key: 'drops/author_author/old/video.mp4' });
    const service = new UploadMediaService(
      () => ({ send }) as any,
      () => ({ send }) as any,
      {
        findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue(null)
      } as any,
      jest.fn()
    );
    const result = await service.completeMultipartUpload({
      key: 'drops/author_author/old/video.mp4',
      upload_id: 'old',
      parts: [{ part_no: 1, etag: 'etag' }],
      authenticatedProfileId: 'author'
    });
    expect(result.media_status).toBe(ApiDropMediaStatus.Ready);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not issue a single-PUT wave image URL with sanitization disabled', async () => {
    process.env.DROP_MEDIA_SANITIZE_IMAGES = 'false';
    const service = new UploadMediaService(() => ({ send: jest.fn() }) as any);
    await expect(
      service.createSingedWaveMediaUploadUrl({
        file_name: 'image.png',
        content_type: 'image/png',
        author_id: 'author'
      })
    ).rejects.toThrow('file format can be validated');
  });
});
