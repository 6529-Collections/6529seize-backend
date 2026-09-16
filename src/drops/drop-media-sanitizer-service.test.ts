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
