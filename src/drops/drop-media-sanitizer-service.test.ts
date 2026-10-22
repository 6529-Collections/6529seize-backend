import Sharp from 'sharp';
import {
  DropMediaSanitizerService,
  PermanentMediaSanitizationError
} from '@/drops/drop-media-sanitizer.service';
import { DropMediaUploadStatus } from '@/entities/IDropMediaUpload';

describe('DropMediaSanitizerService', () => {
  const service = new DropMediaSanitizerService({} as any);

  it('strips JPEG metadata while preserving dimensions', async () => {
    const input = await Sharp({
      create: {
        width: 3,
        height: 2,
        channels: 3,
        background: '#336699'
      }
    })
      .jpeg()
      .withMetadata({
        exif: {
          IFD0: {
            Make: 'Test Camera',
            Model: 'Metadata Phone'
          }
        }
      })
      .toBuffer();

    expect((await Sharp(input).metadata()).exif).toBeDefined();

    const sanitized = await service.sanitizeBuffer({
      input,
      declaredMimeType: 'image/jpeg'
    });
    const metadata = await Sharp(sanitized.buffer).metadata();

    expect(sanitized.contentType).toBe('image/jpeg');
    expect(metadata.width).toBe(3);
    expect(metadata.height).toBe(2);
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  it('converts still AVIF to WebP with orientation applied and metadata stripped', async () => {
    const input = await Sharp({
      create: { width: 30, height: 20, channels: 4, background: '#33669980' }
    })
      .avif()
      .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'Test Camera' } } })
      .toBuffer();
    expect((await Sharp(input).metadata()).exif).toBeDefined();
    const sanitized = await service.sanitizeBuffer({
      input,
      declaredMimeType: 'image/avif'
    });
    const metadata = await Sharp(sanitized.buffer).metadata();
    expect(sanitized.contentType).toBe('image/webp');
    expect(metadata).toMatchObject({
      format: 'webp',
      width: 20,
      height: 30,
      hasAlpha: true
    });
    for (const field of ['exif', 'xmp', 'icc', 'orientation'] as const) {
      expect(metadata[field]).toBeUndefined();
    }
  });

  it.each(['image/jpeg', 'image/png'])(
    'rejects AVIF bytes declared as %s',
    async (declaredMimeType) => {
      const input = await Sharp({
        create: { width: 2, height: 2, channels: 3, background: '#123456' }
      })
        .avif()
        .toBuffer();
      await expect(
        service.sanitizeBuffer({ input, declaredMimeType })
      ).rejects.toBeInstanceOf(PermanentMediaSanitizationError);
    }
  );

  it('rejects another image format declared as AVIF', async () => {
    const input = await Sharp({
      create: { width: 2, height: 2, channels: 3, background: '#123456' }
    })
      .png()
      .toBuffer();
    await expect(
      service.sanitizeBuffer({ input, declaredMimeType: 'image/avif' })
    ).rejects.toThrow('not an AVIF');
  });

  it('rejects corrupt and truncated AVIF permanently', async () => {
    const valid = await Sharp({
      create: { width: 2, height: 2, channels: 3, background: '#123456' }
    })
      .avif()
      .toBuffer();
    for (const input of [
      Buffer.from('not an image'),
      valid.subarray(0, valid.length - 20)
    ]) {
      await expect(
        service.sanitizeBuffer({ input, declaredMimeType: 'image/avif' })
      ).rejects.toBeInstanceOf(PermanentMediaSanitizationError);
    }
  });

  it.each([
    '00000018667479706176697300000000617669666d696631',
    '00000018667479706176696600000000617669736d696631'
  ])(
    'rejects AVIF sequences with major or compatible avis brands',
    async (header) => {
      const input = Buffer.from(header, 'hex');
      await expect(
        service.sanitizeBuffer({ input, declaredMimeType: 'image/avif' })
      ).rejects.toThrow('Animated AVIF is not supported');
    }
  );

  it('does not mistake the minor version for a sequence brand', async () => {
    const input = await Sharp({
      create: { width: 2, height: 2, channels: 3, background: '#123456' }
    })
      .avif()
      .toBuffer();
    input.write('avis', 12, 'ascii');
    await expect(
      service.sanitizeBuffer({ input, declaredMimeType: 'image/avif' })
    ).resolves.toMatchObject({ contentType: 'image/webp' });
  });

  it('rejects an AVIF wider than the WebP output limit', async () => {
    const input = await Sharp({
      create: { width: 16384, height: 1, channels: 3, background: '#123456' }
    })
      .avif()
      .toBuffer();
    await expect(
      service.sanitizeBuffer({ input, declaredMimeType: 'image/avif' })
    ).rejects.toThrow('16,383 pixels');
  });

  it('rejects an unbounded AVIF file-type box before decoding', async () => {
    const input = Buffer.from('ffffffff667479706176696600000000', 'hex');
    await expect(
      service.sanitizeBuffer({ input, declaredMimeType: 'image/avif' })
    ).rejects.toThrow('Invalid AVIF file-type header');
  });

  it('rejects mismatched declared MIME type and image content', async () => {
    const input = await Sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: '#ffffff'
      }
    })
      .png()
      .toBuffer();

    await expect(
      service.sanitizeBuffer({
        input,
        declaredMimeType: 'image/jpeg'
      })
    ).rejects.toBeInstanceOf(PermanentMediaSanitizationError);
  });

  it('claims processing uploads before publishing sanitized media', async () => {
    const uploadsDb = {
      findById: jest.fn().mockResolvedValue({
        id: 'media-upload-123',
        status: DropMediaUploadStatus.PROCESSING,
        updated_at: 100
      }),
      transitionStatus: jest.fn().mockResolvedValue(true)
    };
    const notifier = {
      notifyStatusTransition: jest.fn().mockResolvedValue(undefined)
    };
    const processService = new DropMediaSanitizerService(
      uploadsDb as any,
      jest.fn() as any,
      jest.fn() as any,
      notifier as any
    );
    jest
      .spyOn(processService as any, 'sanitizeAndPublish')
      .mockResolvedValue(undefined);

    await processService.processUpload({
      mediaUploadId: 'media-upload-123',
      approximateReceiveCount: 1
    });

    expect(uploadsDb.transitionStatus).toHaveBeenNthCalledWith(1, {
      id: 'media-upload-123',
      fromStatuses: [DropMediaUploadStatus.PROCESSING],
      toStatus: DropMediaUploadStatus.SANITIZING
    });
    expect(uploadsDb.transitionStatus).toHaveBeenNthCalledWith(2, {
      id: 'media-upload-123',
      fromStatuses: [DropMediaUploadStatus.SANITIZING],
      toStatus: DropMediaUploadStatus.READY,
      patch: expect.objectContaining({
        error_reason: null,
        completed_at: expect.any(Number)
      })
    });
    expect(notifier.notifyStatusTransition).toHaveBeenCalledWith(
      'media-upload-123'
    );
  });
});

describe('image format validation before publication', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env.S3_BUCKET = 'public-bucket';
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });
  const fixture = (format: string) =>
    require('node:fs').readFileSync(
      require('node:path').join(
        __dirname,
        '../../scripts/media-fixtures',
        format
      )
    ) as Buffer;

  function pipeline(
    input: Buffer,
    declaredMimeType = 'image/jpeg',
    policy: string | undefined = 'false'
  ) {
    const upload = {
      id: 'upload',
      status: DropMediaUploadStatus.PROCESSING,
      ingest_bucket: 'ingest-bucket',
      ingest_key: 'private/image.jpg',
      public_key: 'drops/author/image.jpg',
      declared_mime_type: declaredMimeType
    };
    let status = upload.status;
    const uploadsDb = {
      findById: jest.fn(async () => ({ ...upload, status })),
      transitionStatus: jest.fn(
        async ({ toStatus }: { toStatus: DropMediaUploadStatus }) => {
          status = toStatus;
          return true;
        }
      )
    };
    const body = { transformToByteArray: jest.fn().mockResolvedValue(input) };
    const object = {
      Body: body,
      ContentLength: input.length,
      Metadata:
        policy === undefined ? {} : { 'sanitize-image-metadata': policy }
    };
    const ingestSend = jest.fn().mockResolvedValue(object);
    const publicSend = jest.fn().mockResolvedValue({});
    const notifier = { notifyStatusTransition: jest.fn() };
    const service = new DropMediaSanitizerService(
      uploadsDb as any,
      () => ({ send: publicSend }) as any,
      () => ({ send: ingestSend }) as any,
      notifier as any
    );
    const process = () =>
      service.processUpload({
        mediaUploadId: 'upload',
        approximateReceiveCount: 1
      });
    return {
      process,
      publicSend,
      ingestSend,
      uploadsDb,
      object,
      body,
      notifier
    };
  }

  it.each(['jpeg', 'png', 'webp', 'gif'])(
    'validates and preserves exact %s bytes when privacy stripping is disabled',
    async (format) => {
      const input = fixture(format);
      const p = pipeline(input, `image/${format}`);
      await p.process();
      expect(p.publicSend.mock.calls[0][0].input).toMatchObject({
        Body: input,
        ContentType: `image/${format}`,
        Metadata: { 'format-validated': 'true' },
        CacheControl: 'public, max-age=31536000, immutable'
      });
      expect(p.publicSend.mock.calls[0][0].input.Metadata).not.toHaveProperty(
        'privacy-sanitized'
      );
      expect(p.body.transformToByteArray).toHaveBeenCalledTimes(1);
      expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ toStatus: DropMediaUploadStatus.READY })
      );
    }
  );

  it.each(['true', 'legacy'])(
    'retains privacy sanitization for policy %s',
    async (policy) => {
      const input = fixture('jpeg');
      const p = pipeline(
        input,
        'image/jpeg',
        policy === 'legacy' ? undefined : policy
      );
      // The default argument models new uploads; remove metadata to model legacy.
      if (policy === 'legacy') p.object.Metadata = {};
      await p.process();
      const published = p.publicSend.mock.calls[0][0].input;
      expect(published.Body).not.toEqual(input);
      expect(published.Metadata).toEqual({
        'privacy-sanitized': 'true',
        'format-validated': 'true'
      });
      expect((await Sharp(published.Body).metadata()).exif).toBeUndefined();
    }
  );

  it('preserves JPEG metadata and orientation exactly with stripping disabled', async () => {
    const input = fixture('jpeg');
    expect((await Sharp(input).metadata()).exif).toBeDefined();
    const p = pipeline(input, 'image/jpg');
    await p.process();
    expect(p.publicSend.mock.calls[0][0].input.Body).toEqual(input);
    expect(p.publicSend.mock.calls[0][0].input.ContentType).toBe('image/jpeg');
  });

  it.each(['true', 'false'])(
    'rejects mislabeled HEIC before publishing with privacy policy %s',
    async (policy) => {
      const p = pipeline(fixture('heic'), 'image/jpeg', policy);
      await p.process();
      await p.process();
      expect(p.publicSend).not.toHaveBeenCalled();
      expect(p.ingestSend).toHaveBeenCalledTimes(1);
      expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({
          toStatus: DropMediaUploadStatus.FAILED,
          patch: expect.objectContaining({
            error_reason: expect.stringContaining(
              'changing its filename does not convert it'
            )
          })
        })
      );
      expect(p.notifier.notifyStatusTransition).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    ['png', 'image/jpeg'],
    ['avif', 'image/png'],
    ['svg', 'image/jpeg'],
    ['tiff', 'image/jpeg']
  ])('rejects %s bytes labeled %s without publishing', async (format, mime) => {
    const p = pipeline(fixture(format), mime);
    await p.process();
    expect(p.publicSend).not.toHaveBeenCalled();
    expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ toStatus: DropMediaUploadStatus.FAILED })
    );
  });

  it('continues converting AVIF when privacy stripping is disabled', async () => {
    const p = pipeline(fixture('avif'), 'image/avif');
    await p.process();
    const published = p.publicSend.mock.calls[0][0].input;
    expect(published.ContentType).toBe('image/webp');
    expect(published.Metadata['privacy-sanitized']).toBe('true');
    expect((await Sharp(published.Body).metadata()).format).toBe('webp');
  });

  it.each(['read', 'write', 'short response'])(
    'keeps %s failures operational without marking media ready or invalid',
    async (failure) => {
      const p = pipeline(fixture('jpeg'));
      const error = new Error('synthetic infrastructure failure');
      if (failure === 'read')
        p.body.transformToByteArray.mockRejectedValue(error);
      if (failure === 'write') p.publicSend.mockRejectedValue(error);
      if (failure === 'short response') p.object.ContentLength++;
      const result = p.process();
      if (failure === 'short response')
        await expect(result).rejects.toThrow('source length mismatch');
      else await expect(result).rejects.toBe(error);
      expect(p.uploadsDb.transitionStatus.mock.calls).toHaveLength(1);
    }
  );

  it('rejects an oversized object before buffering its body', async () => {
    const p = pipeline(fixture('jpeg'));
    p.object.ContentLength = 500 * 1024 * 1024 + 1;
    await p.process();
    expect(p.body.transformToByteArray).not.toHaveBeenCalled();
    expect(p.publicSend).not.toHaveBeenCalled();
    expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ toStatus: DropMediaUploadStatus.FAILED })
    );
  });
});
