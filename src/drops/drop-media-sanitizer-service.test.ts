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
