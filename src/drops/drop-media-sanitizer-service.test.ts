import { Readable } from 'node:stream';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import Sharp from 'sharp';
import * as sanitizerModule from '@/drops/drop-media-sanitizer.service';
import {
  DropMediaSanitizerService,
  PermanentMediaSanitizationError,
  shouldStripImageMetadata
} from '@/drops/drop-media-sanitizer.service';
import {
  DropMediaUploadPurpose,
  DropMediaUploadStatus
} from '@/entities/IDropMediaUpload';
import { Logger } from '@/logging';
import * as pixelVerifiedStrip from '@/media/metadata-strip/pixel-verified-metadata-strip';
import { minimalOrientationTiff } from '@/media/metadata-strip/exif-orientation';
import {
  animatedGifFixture,
  IDENTIFYING_STRINGS,
  identifyingGif,
  identifyingJpeg,
  identifyingWebp
} from '@/media/metadata-strip/fixtures/identifying-image-fixtures';
import {
  largeGif,
  largeJpeg
} from '@/media/metadata-strip/fixtures/large-image-fixtures';
import { stripMetadataLosslessly } from '@/media/metadata-strip/lossless-metadata-strip';
import * as uploadImagePreviews from '@/media/upload-image-previews';
import * as mediaPlaceholder from './media-placeholder';

const ORIENTATION_6_EXIF = Buffer.concat([
  Buffer.from('Exif\0\0'),
  minimalOrientationTiff(6)
]);

async function orientedPixels(image: Buffer, animated = false) {
  const { data, info } = await Sharp(image, { animated })
    .rotate()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return `${info.width}x${info.height}:${createHash('sha256').update(data).digest('hex')}`;
}

function expectNoIdentifyingStrings(image: Buffer) {
  const text = image.toString('latin1');
  for (const value of IDENTIFYING_STRINGS) expect(text).not.toContain(value);
}

describe('DropMediaSanitizerService', () => {
  const service = new DropMediaSanitizerService({} as any);

  it('strips JPEG metadata losslessly while preserving dimensions and colour profile', async () => {
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

    const inputMetadata = await Sharp(input).metadata();
    expect(inputMetadata.exif).toBeDefined();

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
    // Lossless stripping keeps the embedded colour profile byte for byte.
    expect(metadata.icc).toEqual(inputMetadata.icc);
    expect(sanitized.buffer.toString('latin1')).not.toContain('Test Camera');
    expect(await orientedPixels(sanitized.buffer)).toBe(
      await orientedPixels(input)
    );
  });

  it('falls back to re-encoding when the lossless strip does not verify', async () => {
    jest
      .spyOn(pixelVerifiedStrip, 'stripMetadataWithPixelCheck')
      .mockResolvedValue({ kind: 'unverified', reason: 'synthetic failure' });
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { jpeg } = await identifyingJpeg();

    const sanitized = await service.sanitizeBuffer({
      input: jpeg,
      declaredMimeType: 'image/jpeg'
    });

    const metadata = await Sharp(sanitized.buffer).metadata();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expectNoIdentifyingStrings(sanitized.buffer);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining(
        'did not verify; re-encoding instead: synthetic failure'
      )
    );
    jest.restoreAllMocks();
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
    const memoryUsage = process.memoryUsage;
    jest.spyOn(process, 'memoryUsage').mockImplementation(
      Object.assign(() => ({ ...memoryUsage(), rss: 64 * 1024 * 1024 }), {
        rss: memoryUsage.rss
      })
    );
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
    policy: string | undefined = 'false',
    purpose: DropMediaUploadPurpose | null = null
  ) {
    const upload = {
      id: 'upload',
      status: DropMediaUploadStatus.PROCESSING,
      ingest_bucket: 'ingest-bucket',
      ingest_key: 'private/image.jpg',
      public_key: 'drops/author/image.jpg',
      declared_mime_type: declaredMimeType,
      purpose
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
    const transformToByteArray = jest.fn().mockResolvedValue(input);
    const readError: { value?: Error } = {};
    const makeBody = () =>
      Object.assign(
        Readable.from(
          (async function* () {
            if (readError.value) throw readError.value;
            yield input;
          })()
        ),
        { transformToByteArray }
      );
    const body = makeBody();
    const object = {
      Body: body,
      ContentLength: input.length,
      Metadata:
        policy === undefined ? {} : { 'sanitize-image-metadata': policy }
    };
    let reads = 0;
    const ingestSend = jest.fn(async (command) => {
      if (command instanceof DeleteObjectCommand) return {};
      return { ...object, Body: reads++ === 0 ? object.Body : makeBody() };
    });
    const publicSend = jest.fn(async (command) => {
      if (command.input.Body instanceof Readable) {
        const chunks: Buffer[] = [];
        for await (const chunk of command.input.Body)
          chunks.push(Buffer.from(chunk));
        command.input.Body = Buffer.concat(chunks);
      }
      return {};
    });
    const notifier = { notifyStatusTransition: jest.fn() };
    const service = new DropMediaSanitizerService(
      uploadsDb as any,
      () => ({ send: publicSend }) as any,
      () => ({ send: ingestSend }) as any,
      notifier as any
    );
    const process = (approximateReceiveCount = 1) =>
      service.processUpload({
        mediaUploadId: 'upload',
        approximateReceiveCount
      });
    return {
      process,
      publicSend,
      ingestSend,
      uploadsDb,
      object,
      body,
      readError,
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
      expect(p.body.transformToByteArray).not.toHaveBeenCalled();
      expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ toStatus: DropMediaUploadStatus.READY })
      );
    }
  );

  it.each(['jpeg', 'png', 'webp', 'gif'])(
    'records layout hints for a ready %s upload',
    async (format) => {
      const input = fixture(format);
      const metadata = await Sharp(input, { animated: true }).metadata();
      const p = pipeline(input, `image/${format}`);
      await p.process();
      const expected =
        (metadata.orientation ?? 1) >= 5
          ? {
              width: metadata.pageHeight ?? metadata.height,
              height: metadata.width
            }
          : {
              width: metadata.width,
              height: metadata.pageHeight ?? metadata.height
            };
      expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({
          toStatus: DropMediaUploadStatus.READY,
          patch: expect.objectContaining({
            ...expected,
            thumbhash: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/)
          })
        })
      );
    }
  );

  it('still publishes an image whose layout hints cannot be computed', async () => {
    jest
      .spyOn(mediaPlaceholder, 'describeImage')
      .mockRejectedValue(new Error('decoder unavailable'));
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const p = pipeline(fixture('png'), 'image/png');

    await p.process();

    const ready = p.uploadsDb.transitionStatus.mock.calls.at(-1)![0] as {
      toStatus: DropMediaUploadStatus;
      patch: Record<string, unknown>;
    };
    expect(ready.toStatus).toBe(DropMediaUploadStatus.READY);
    expect(ready.patch).not.toHaveProperty('width');
    expect(ready.patch).not.toHaveProperty('thumbhash');
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Could not compute layout hints')
    );
  });

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
      // Only the orientation survives, so the image stays upright.
      expect((await Sharp(published.Body).metadata()).exif).toEqual(
        ORIENTATION_6_EXIF
      );
      expect(published.Body.toString('latin1')).not.toContain(
        'Compatibility fixture'
      );
    }
  );

  it.each([
    [DropMediaUploadPurpose.CHAT, 'true'],
    [null, 'true']
  ])(
    'publishes %s identifying JPEGs stripped losslessly with policy %s',
    async (purpose, policy) => {
      const { jpeg } = await identifyingJpeg();
      const p = pipeline(jpeg, 'image/jpeg', policy, purpose);
      await p.process();
      const published = p.publicSend.mock.calls[0][0].input;
      expect(published.Metadata).toEqual({
        'privacy-sanitized': 'true',
        'format-validated': 'true'
      });
      expectNoIdentifyingStrings(published.Body);
      const [before, after] = await Promise.all([
        Sharp(jpeg).metadata(),
        Sharp(published.Body).metadata()
      ]);
      expect(after.icc).toEqual(before.icc);
      expect(after.exif).toEqual(ORIENTATION_6_EXIF);
      expect(after.xmp).toBeUndefined();
      expect(await orientedPixels(published.Body)).toBe(
        await orientedPixels(jpeg)
      );
    }
  );

  it.each([
    ['webp', identifyingWebp],
    ['gif', async () => identifyingGif()]
  ])(
    'keeps every frame of an animated chat %s while stripping it',
    async (format, make) => {
      const input = await make();
      const p = pipeline(
        input,
        `image/${format}`,
        'true',
        DropMediaUploadPurpose.CHAT
      );
      await p.process();
      const body = p.publicSend.mock.calls[0][0].input.Body as Buffer;
      expectNoIdentifyingStrings(body);
      const [before, after] = await Promise.all([
        Sharp(input, { animated: true }).metadata(),
        Sharp(body, { animated: true }).metadata()
      ]);
      expect(after).toMatchObject({
        pages: 2,
        loop: before.loop,
        delay: before.delay
      });
      expect(after.icc).toEqual(before.icc);
      expect(await orientedPixels(body, true)).toBe(
        await orientedPixels(input, true)
      );
      if (format === 'gif') expect(body).toEqual(animatedGifFixture());
    }
  );

  it.each([
    // 36 MP: the old pixel check gave up, and the re-encode fallback's own
    // decoded-work budget then rejected the upload.
    ['jpeg', () => largeJpeg(6_000)],
    ['gif', () => largeGif(400)]
  ] as const)(
    'publishes a large chat %s stripped losslessly instead of failing it',
    async (format, make) => {
      const input = await make();
      const p = pipeline(
        input,
        `image/${format}`,
        'true',
        DropMediaUploadPurpose.CHAT
      );
      await p.process();
      expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ toStatus: DropMediaUploadStatus.READY })
      );
      const body = p.publicSend.mock.calls[0][0].input.Body as Buffer;
      expect(body).toEqual(stripMetadataLosslessly(input, format).output);
      expectNoIdentifyingStrings(body);
    },
    120_000
  );

  it('frees the source and stripped buffers before rendering previews', async () => {
    const { jpeg } = await identifyingJpeg();
    const output = stripMetadataLosslessly(jpeg, 'jpeg').output;
    // Unpooled, like the large buffers this protects against.
    const stripped = Buffer.alloc(output.length);
    output.copy(stripped);
    let source: Buffer | undefined;
    jest
      .spyOn(pixelVerifiedStrip, 'stripMetadataWithPixelCheck')
      .mockImplementation(async (input) => {
        source = input;
        return { kind: 'lossless', buffer: stripped, removed: [] };
      });
    const render = uploadImagePreviews.prepareUploadImagePreviews;
    const lengthsAtPreview: number[] = [];
    jest
      .spyOn(uploadImagePreviews, 'prepareUploadImagePreviews')
      .mockImplementation(async (...args) => {
        lengthsAtPreview.push(source!.length, stripped.length);
        return render(...args);
      });
    const p = pipeline(jpeg, 'image/jpeg', 'true', DropMediaUploadPurpose.CHAT);
    await p.process();
    expect(p.publicSend.mock.calls[0][0].input.Body).toEqual(output);
    expect(lengthsAtPreview).toEqual([0, 0]);
  });

  it.each(['true', 'false'])(
    'publishes decision entry bytes unchanged with policy %s',
    async (policy) => {
      const { jpeg } = await identifyingJpeg();
      const p = pipeline(
        jpeg,
        'image/jpeg',
        policy,
        DropMediaUploadPurpose.DECISION_ENTRY
      );
      await p.process();
      const published = p.publicSend.mock.calls[0][0].input;
      expect(published.Body).toEqual(jpeg);
      expect(published.Metadata).toEqual({ 'format-validated': 'true' });
      expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ toStatus: DropMediaUploadStatus.READY })
      );
    }
  );

  it('publishes chat media unchanged while the privacy flag is off', async () => {
    const { jpeg } = await identifyingJpeg();
    const p = pipeline(
      jpeg,
      'image/jpeg',
      'false',
      DropMediaUploadPurpose.CHAT
    );
    await p.process();
    expect(p.publicSend.mock.calls[0][0].input.Body).toEqual(jpeg);
  });

  it('re-encodes, without loading it, a source above the lossless size limit', async () => {
    jest.replaceProperty(
      sanitizerModule,
      'LOSSLESS_STRIP_MAX_SOURCE_BYTES',
      100
    );
    const lossless = jest.spyOn(
      pixelVerifiedStrip,
      'stripMetadataWithPixelCheck'
    );
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { jpeg } = await identifyingJpeg();
    const p = pipeline(jpeg, 'image/jpeg', 'true', DropMediaUploadPurpose.CHAT);
    await p.process();
    expect(lossless).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('source is larger than the lossless strip limit')
    );
    const published = p.publicSend.mock.calls[0][0].input;
    expect((await Sharp(published.Body).metadata()).exif).toBeUndefined();
    expectNoIdentifyingStrings(published.Body);
  });

  it('re-encodes a file whose lossless strip does not verify and says why', async () => {
    jest
      .spyOn(pixelVerifiedStrip, 'stripMetadataWithPixelCheck')
      .mockResolvedValue({ kind: 'unverified', reason: 'synthetic failure' });
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { jpeg } = await identifyingJpeg();
    const p = pipeline(jpeg, 'image/jpeg', 'true', DropMediaUploadPurpose.CHAT);
    await p.process();
    const published = p.publicSend.mock.calls[0][0].input;
    expect((await Sharp(published.Body).metadata()).exif).toBeUndefined();
    expectNoIdentifyingStrings(published.Body);
    expect(warning).toHaveBeenCalledWith(
      'Lossless metadata strip of jpeg drop media upload upload did not verify; re-encoding instead: synthetic failure'
    );
  });

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
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation();
      const warningLog = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation();
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
      expect(warningLog).toHaveBeenCalledTimes(1);
      expect(errorLog).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['png', 'image/jpeg'],
    ['avif', 'image/png'],
    ['svg', 'image/jpeg'],
    ['tiff', 'image/jpeg']
  ])('rejects %s bytes labeled %s without publishing', async (format, mime) => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    const warningLog = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation();
    const p = pipeline(fixture(format), mime);
    await p.process();
    expect(p.publicSend).not.toHaveBeenCalled();
    expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ toStatus: DropMediaUploadStatus.FAILED })
    );
    expect(warningLog).toHaveBeenCalledTimes(1);
    expect(errorLog).not.toHaveBeenCalled();
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
      const errorLog = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation();
      const warningLog = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation();
      const p = pipeline(fixture('jpeg'));
      const error = new Error('synthetic infrastructure failure');
      if (failure === 'read') p.readError.value = error;
      if (failure === 'write') p.publicSend.mockRejectedValue(error);
      if (failure === 'short response') p.object.ContentLength++;
      const result = p.process();
      if (failure === 'short response')
        await expect(result).rejects.toThrow('RESIZE_SOURCE_LENGTH_MISMATCH');
      else await expect(result).rejects.toBe(error);
      expect(p.uploadsDb.transitionStatus.mock.calls).toHaveLength(1);
      expect(errorLog).not.toHaveBeenCalled();
      await p.process(3);
      expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ toStatus: DropMediaUploadStatus.FAILED })
      );
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('failed after retries'),
        expect.any(Error)
      );
      expect(warningLog).not.toHaveBeenCalled();
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
  it.each(['jpeg', 'gif'])(
    'marks %s ready only after both verified previews have been stored',
    async (format) => {
      const p = pipeline(fixture(format), `image/${format}`);
      const write = p.publicSend.getMockImplementation()!;
      let release!: () => void;
      let reached!: () => void;
      const paused = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        reached = resolve;
      });
      p.publicSend.mockImplementation(async (command) => {
        const result = await write(command);
        if (command.input.Key.includes('/AUTOx1080/')) {
          reached();
          await paused;
        }
        return result;
      });
      const processing = p.process();
      await started;
      expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ toStatus: DropMediaUploadStatus.SANITIZING })
      );
      release();
      await processing;
      const keys = p.publicSend.mock.calls.map(
        ([command]) => command.input.Key
      );
      expect(keys).toEqual([
        'drops/author/image.jpg',
        'drops/author/AUTOx450/image.jpg',
        'drops/author/AUTOx1080/image.jpg'
      ]);
      for (const [command] of p.publicSend.mock.calls.slice(1)) {
        expect(await Sharp(command.input.Body).metadata()).toMatchObject({
          format
        });
      }
      if (format === 'gif') {
        expect(p.publicSend.mock.calls[2][0].input.Body).toEqual(
          p.publicSend.mock.calls[1][0].input.Body
        );
      }
      expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ toStatus: DropMediaUploadStatus.READY })
      );
    }
  );

  it.each(['jpeg', 'gif'])(
    'keeps a partial %s derivative upload failure retryable without declaring ready',
    async (format) => {
      const p = pipeline(fixture(format), `image/${format}`);
      const write = p.publicSend.getMockImplementation()!;
      const error = new Error('preview storage unavailable');
      p.publicSend.mockImplementation(async (command) => {
        if (command.input.Key.includes('/AUTOx1080/')) throw error;
        return write(command);
      });
      await expect(p.process()).rejects.toBe(error);
      expect(p.uploadsDb.transitionStatus).toHaveBeenCalledTimes(1);
      expect(p.ingestSend).toHaveBeenCalledTimes(1);
      expect(p.notifier.notifyStatusTransition).not.toHaveBeenCalled();
    }
  );

  it('rejects corrupt PNG pixel data before publishing the original', async () => {
    const valid = fixture('png');
    const p = pipeline(
      valid.subarray(0, Math.floor(valid.length / 2)),
      'image/png'
    );
    await p.process();
    expect(p.publicSend).not.toHaveBeenCalled();
    expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ toStatus: DropMediaUploadStatus.FAILED })
    );
  });

  it('rejects images above the shared 256 MiB limit before buffering', async () => {
    const p = pipeline(fixture('jpeg'));
    p.object.ContentLength = 256 * 1024 * 1024 + 1;
    await p.process();
    expect(p.body.transformToByteArray).not.toHaveBeenCalled();
    expect(p.publicSend).not.toHaveBeenCalled();
    expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ toStatus: DropMediaUploadStatus.FAILED })
    );
  });
  it.each(['true', 'false'])(
    'preserves PNG privacy policy %s through original and preview publication',
    async (policy) => {
      const input = await Sharp({
        create: { width: 40, height: 20, channels: 4, background: '#33669980' }
      })
        .png()
        .withMetadata({ orientation: 6, exif: { IFD0: { Make: 'Synthetic' } } })
        .toBuffer();
      const p = pipeline(input, 'image/png', policy);
      await p.process();
      expect(p.publicSend).toHaveBeenCalledTimes(3);
      const original = p.publicSend.mock.calls[0][0].input;
      if (policy === 'false') expect(original.Body).toEqual(input);
      else {
        // Stored pixels are untouched; Orientation 6 still shows it upright.
        const metadata = await Sharp(original.Body).metadata();
        expect(metadata).toMatchObject({
          width: 40,
          height: 20,
          orientation: 6
        });
        // PNG eXIf holds the bare TIFF block.
        expect(metadata.exif).toEqual(minimalOrientationTiff(6));
        expect(original.Body.toString('latin1')).not.toContain('Synthetic');
        expect(await orientedPixels(original.Body)).toBe(
          await orientedPixels(input)
        );
      }
      for (const [command] of p.publicSend.mock.calls.slice(1)) {
        expect(await Sharp(command.input.Body).metadata()).toMatchObject({
          format: 'png',
          hasAlpha: true,
          width: 20,
          height: 40
        });
        expect(
          (await Sharp(command.input.Body).metadata()).exif
        ).toBeUndefined();
      }
      expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ toStatus: DropMediaUploadStatus.READY })
      );
    }
  );
  it('retains ingest data when committing ready fails, allowing a safe retry', async () => {
    const p = pipeline(fixture('jpeg'));
    const error = new Error('ready status write unavailable');
    p.uploadsDb.transitionStatus
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(error);
    await expect(p.process()).rejects.toBe(error);
    expect(p.publicSend).toHaveBeenCalledTimes(3);
    expect(p.ingestSend).toHaveBeenCalledTimes(1);
    expect(p.notifier.notifyStatusTransition).not.toHaveBeenCalled();
    await p.process();
    expect(p.publicSend).toHaveBeenCalledTimes(6);
    expect(p.ingestSend).toHaveBeenCalledTimes(3);
    expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ toStatus: DropMediaUploadStatus.READY })
    );
  });
  it('retries private ingest cleanup on ready redelivery without rendering again', async () => {
    const p = pipeline(fixture('jpeg'));
    const send = p.ingestSend.getMockImplementation()!;
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    p.ingestSend
      .mockImplementationOnce(send)
      .mockRejectedValueOnce(new Error('delete unavailable'));
    await p.process();
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('Failed to delete ingest'),
      expect.any(Error)
    );
    const transitions = p.uploadsDb.transitionStatus.mock.calls.length;
    await p.process();
    expect(p.publicSend).toHaveBeenCalledTimes(3);
    expect(p.uploadsDb.transitionStatus).toHaveBeenCalledTimes(transitions);
    expect(p.ingestSend.mock.calls.at(-1)![0]).toBeInstanceOf(
      DeleteObjectCommand
    );
  });

  it('rejects a non-stream SDK body as operational before publishing', async () => {
    const p = pipeline(fixture('png'), 'image/png');
    p.ingestSend.mockResolvedValueOnce({ ...p.object, Body: {} });
    const processing = p.process();
    await expect(processing).rejects.toThrow(TypeError);
    await expect(processing).rejects.toThrow('is not a Node stream');
    expect(p.publicSend).not.toHaveBeenCalled();
    expect(p.uploadsDb.transitionStatus).toHaveBeenCalledTimes(1);
  });

  it('preserves interlaced 16-bit PNG original bytes with privacy disabled', async () => {
    const input = await Sharp({
      create: { width: 80, height: 40, channels: 4, background: '#33669980' }
    })
      .toColourspace('rgb16')
      .png({ progressive: true })
      .toBuffer();
    expect(await Sharp(input).metadata()).toMatchObject({
      depth: 'ushort',
      isProgressive: true
    });
    const p = pipeline(input, 'image/png');
    await p.process();
    expect(p.publicSend.mock.calls[0][0].input.Body).toEqual(input);
    for (const [command] of p.publicSend.mock.calls.slice(1)) {
      expect(await Sharp(command.input.Body).metadata()).toMatchObject({
        format: 'png',
        hasAlpha: true
      });
      expect(command.input.CacheControl).toBe('public, max-age=86400');
    }
  });
  it.each(['jpeg', 'webp', 'gif'])(
    'keeps file-based %s privacy sanitization equivalent to the previous encoder',
    async (format) => {
      const input = fixture(format);
      const expected = await new DropMediaSanitizerService(
        {} as any
      ).sanitizeBuffer({ input, declaredMimeType: `image/${format}` });
      const p = pipeline(input, `image/${format}`, 'true');
      await p.process();
      expect(p.publicSend.mock.calls[0][0].input.Body).toEqual(expected.buffer);
      expect(p.body.transformToByteArray).not.toHaveBeenCalled();
      expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({ toStatus: DropMediaUploadStatus.READY })
      );
    }
  );

  it('retries worker memory failures and reports temporary processing failure after exhaustion', async () => {
    const errorLog = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.mocked(process.memoryUsage).mockReturnValue({
      ...process.memoryUsage(),
      rss: 2 * 1024 * 1024 * 1024
    });
    const p = pipeline(fixture('png'), 'image/png');
    await expect(p.process()).rejects.toThrow(
      'PNG_PREVIEW_MEMORY_BUDGET_EXCEEDED'
    );
    expect(p.uploadsDb.transitionStatus).toHaveBeenCalledTimes(1);
    await p.process(3);
    expect(p.uploadsDb.transitionStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        toStatus: DropMediaUploadStatus.FAILED,
        patch: expect.objectContaining({
          error_reason:
            'Preview processing is temporarily unavailable. Please try uploading again later.'
        })
      })
    );
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(p.publicSend).not.toHaveBeenCalled();
  });
});

describe('shouldStripImageMetadata', () => {
  it.each([
    ['image/jpeg', DropMediaUploadPurpose.CHAT, 'true', true],
    ['image/jpeg', DropMediaUploadPurpose.CHAT, 'false', false],
    ['image/jpeg', DropMediaUploadPurpose.CHAT, undefined, true],
    ['image/jpeg', null, 'true', true],
    ['image/jpeg', null, 'false', false],
    ['image/jpeg', null, undefined, true],
    ['image/png', DropMediaUploadPurpose.DECISION_ENTRY, 'true', false],
    ['image/png', DropMediaUploadPurpose.DECISION_ENTRY, undefined, false],
    ['image/avif', DropMediaUploadPurpose.DECISION_ENTRY, 'false', true],
    ['image/avif', DropMediaUploadPurpose.CHAT, 'false', true]
  ])(
    '%s with purpose %s and policy %s strips: %s',
    (declared_mime_type, purpose, policy, expected) => {
      expect(
        shouldStripImageMetadata({ declared_mime_type, purpose }, policy)
      ).toBe(expected);
    }
  );
});
