import {
  CompleteMultipartUploadCommand,
  HeadObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadMediaService } from './upload-media.service';
import { MediaUploadBudget } from './media-upload-budget.service';
import { CustomApiCompliantException } from '@/exceptions';
import { DropMediaUploadsDb } from '@/drops/drop-media-uploads.db';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async () => 'https://signed.example')
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORIGINAL_ENV = { ...process.env };

function setUp({
  publicSend = jest.fn(
    async (..._args: unknown[]): Promise<any> => ({
      UploadId: 'session'
    })
  ),
  ingestSend = jest.fn(
    async (..._args: unknown[]): Promise<any> => ({
      UploadId: 'ingest-session'
    })
  ),
  uploadsDb = {} as Record<string, jest.Mock>
} = {}) {
  const budget = {
    reserve: jest.fn(async (..._args: unknown[]) => undefined),
    release: jest.fn(async (..._args: unknown[]) => undefined),
    recordSize: jest.fn(async (..._args: unknown[]) => undefined)
  };
  const db = {
    createUpload: jest.fn(),
    findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue(null),
    updateUpload: jest.fn(),
    transitionStatus: jest.fn().mockResolvedValue(true),
    claimSanitizerEnqueue: jest.fn().mockResolvedValue(true),
    ...uploadsDb
  };
  const service = new UploadMediaService(
    () => ({ send: publicSend }) as unknown as S3Client,
    () => ({ send: ingestSend }) as unknown as S3Client,
    db as unknown as DropMediaUploadsDb,
    jest.fn().mockResolvedValue(undefined),
    budget as unknown as MediaUploadBudget
  );
  return { service, budget, db, publicSend, ingestSend };
}

describe('UploadMediaService upload budget', () => {
  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      S3_BUCKET: 'public-bucket',
      DROP_MEDIA_INGEST_S3_BUCKET: 'ingest-bucket'
    };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('counts a single-PUT drop upload, with its key, before signing it', async () => {
    const { service, budget, db } = setUp();

    const result = await service.createSingedDropMediaUploadUrl({
      content_type: 'video/mp4',
      file_name: 'clip.mp4',
      author_id: 'author'
    });

    const [reservation] = budget.reserve.mock.calls[0] as [Record<string, any>];
    expect(reservation).toMatchObject({
      profileId: 'author',
      source: 'drop',
      pendingObjectKey: new URL(result.media_url).pathname.slice(1)
    });
    expect(reservation.id).toMatch(UUID);
    expect(db.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({ id: reservation.id })
    );
    expect(budget.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      jest.mocked(getSignedUrl).mock.invocationCallOrder.at(-1)!
    );
  });

  it('counts single-PUT wave media under its wave key', async () => {
    const { service, budget } = setUp();

    const result = await service.createSingedWaveMediaUploadUrl({
      content_type: 'video/mp4',
      file_name: 'clip.mp4',
      author_id: 'author'
    });

    const key = new URL(result.media_url).pathname.slice(1);
    expect(budget.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'author',
        source: 'wave',
        pendingObjectKey: key,
        id: key.split('/')[2].replace('.mp4', '')
      })
    );
  });

  it.each([
    ['drop', 'video/mp4'],
    ['drop', 'image/png'],
    ['wave', 'video/mp4'],
    ['wave', 'image/png']
  ])(
    'counts a %s multipart upload of %s by its upload id',
    async (source, content_type) => {
      const { service, budget, db } = setUp();
      const input = { content_type, file_name: 'file', author_id: 'author' };

      const started =
        source === 'drop'
          ? await service.getDropMediaMultipartUploadKeyAndUploadId(input)
          : await service.getWaveMediaMultipartUploadKeyAndUploadId(input);

      const [reservation] = budget.reserve.mock.calls[0] as [
        Record<string, any>
      ];
      expect(reservation).toMatchObject({ profileId: 'author', source });
      expect(reservation.pendingObjectKey).toBeUndefined();
      expect(started.key).toContain(reservation.id);
      if (db.createUpload.mock.calls.length)
        expect(db.createUpload.mock.calls[0][0].id).toBe(reservation.id);
    }
  );

  it('prepares nothing when the budget refuses the upload', async () => {
    const { service, budget, publicSend, db } = setUp();
    budget.reserve.mockRejectedValue(
      new CustomApiCompliantException(429, 'Upload limit reached')
    );

    await expect(
      service.getDropMediaMultipartUploadKeyAndUploadId({
        content_type: 'video/mp4',
        file_name: 'clip.mp4',
        author_id: 'author'
      })
    ).rejects.toThrow('Upload limit reached');
    await expect(
      service.createSingedDropMediaUploadUrl({
        content_type: 'audio/mpeg',
        file_name: 'a.mp3',
        author_id: 'author'
      })
    ).rejects.toThrow('Upload limit reached');

    expect(publicSend).not.toHaveBeenCalled();
    expect(db.createUpload).not.toHaveBeenCalled();
    expect(budget.release).not.toHaveBeenCalled();
  });

  it('gives the reservation back when preparing the upload fails', async () => {
    const { service, budget, publicSend } = setUp();
    publicSend.mockRejectedValue(new Error('S3 unavailable'));

    await expect(
      service.getDropMediaMultipartUploadKeyAndUploadId({
        content_type: 'video/mp4',
        file_name: 'clip.mp4',
        author_id: 'author'
      })
    ).rejects.toThrow('S3 unavailable');

    const [{ id }] = budget.reserve.mock.calls[0] as [{ id: string }];
    expect(budget.release).toHaveBeenCalledWith(id, 'author');
  });

  it('reads single-PUT sizes from the public bucket, missing objects as null', async () => {
    const { service, budget, publicSend } = setUp();
    await service.createSingedDropMediaUploadUrl({
      content_type: 'audio/mpeg',
      file_name: 'a.mp3',
      author_id: 'author'
    });
    const [{ readObjectSize }] = budget.reserve.mock.calls[0] as [
      { readObjectSize: (key: string) => Promise<number | null> }
    ];

    publicSend.mockResolvedValueOnce({ ContentLength: 1234 });
    await expect(readObjectSize('drops/x/x.mp3')).resolves.toBe(1234);
    expect(publicSend.mock.lastCall?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect((publicSend.mock.lastCall?.[0] as HeadObjectCommand).input).toEqual({
      Bucket: 'public-bucket',
      Key: 'drops/x/x.mp3'
    });
    for (const status of [404, 403]) {
      publicSend.mockRejectedValueOnce(
        Object.assign(new Error('missing'), {
          $metadata: { httpStatusCode: status }
        })
      );
      await expect(readObjectSize('drops/x/x.mp3')).resolves.toBeNull();
    }
    publicSend.mockRejectedValueOnce(new Error('throttled'));
    await expect(readObjectSize('drops/x/x.mp3')).rejects.toThrow('throttled');
  });

  it('records the size of completed directly published media', async () => {
    const uploadId = '12345678-1234-1234-1234-123456789012';
    const publicSend = jest.fn(async (command: unknown) =>
      command instanceof HeadObjectCommand
        ? { ContentLength: 777 }
        : { Key: 'k' }
    );
    const key = `drops/${uploadId}/${uploadId}.mp4`;
    const { service, budget } = setUp({
      publicSend,
      uploadsDb: {
        findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue({
          id: uploadId,
          profile_id: 'author',
          status: 'uploading',
          declared_mime_type: 'video/mp4',
          public_key: key,
          s3_upload_id: 'session'
        })
      }
    });

    await service.completeMultipartUpload({
      key,
      upload_id: 'session',
      parts: [{ etag: 'e', part_no: 1 }],
      authenticatedProfileId: 'author'
    });

    expect(budget.recordSize).toHaveBeenCalledWith(uploadId, 'author', 777);
    expect(
      publicSend.mock.calls.map(([c]) => (c as object).constructor)
    ).toEqual([CompleteMultipartUploadCommand, HeadObjectCommand]);

    // Untracked legacy keys were never counted.
    budget.recordSize.mockClear();
    const untracked = setUp({ publicSend });
    await untracked.service.completeMultipartUpload({
      key: 'drops/author_author/old/video.mp4',
      upload_id: 'session',
      parts: [{ etag: 'e', part_no: 1 }],
      authenticatedProfileId: 'author'
    });
    expect(untracked.budget.recordSize).not.toHaveBeenCalled();
  });

  it('records the size of a completed private image upload', async () => {
    const upload = {
      id: 'image-upload',
      profile_id: 'author',
      status: 'uploading',
      declared_mime_type: 'image/png',
      ingest_bucket: 'ingest-bucket',
      ingest_key: 'staging/drop-media-ingest/drops/image.png',
      s3_upload_id: 'ingest-session',
      public_url: 'https://cdn.example/drops/image.png'
    };
    const ingestSend = jest.fn(async (command: unknown) =>
      command instanceof HeadObjectCommand ? { ContentLength: 555 } : {}
    );
    const { service, budget } = setUp({
      ingestSend,
      uploadsDb: {
        findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue(upload)
      }
    });

    await service.completeMultipartUpload({
      key: 'drops/image.png',
      upload_id: 'ingest-session',
      parts: [{ etag: 'e', part_no: 1 }],
      authenticatedProfileId: 'author'
    });

    expect(budget.recordSize).toHaveBeenCalledWith(
      'image-upload',
      'author',
      555
    );
    expect((ingestSend.mock.calls[1][0] as HeadObjectCommand).input).toEqual({
      Bucket: 'ingest-bucket',
      Key: 'staging/drop-media-ingest/drops/image.png'
    });

    // A failed size read never fails the completion.
    ingestSend.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadObjectCommand) throw new Error('denied');
      return {};
    });
    budget.recordSize.mockClear();
    await expect(
      service.completeMultipartUpload({
        key: 'drops/image.png',
        upload_id: 'ingest-session',
        parts: [{ etag: 'e', part_no: 1 }],
        authenticatedProfileId: 'author'
      })
    ).resolves.toMatchObject({ media_status: 'processing' });
    expect(budget.recordSize).not.toHaveBeenCalled();
  });

  it('does not count distribution photos', async () => {
    const { service, budget } = setUp();

    await service.getDistributionPhotoMultipartUploadKeyAndUploadId({
      content_type: 'image/png',
      file_name: 'photo.png',
      contract: '0xabc',
      card_id: 1
    });

    expect(budget.reserve).not.toHaveBeenCalled();
  });
});
