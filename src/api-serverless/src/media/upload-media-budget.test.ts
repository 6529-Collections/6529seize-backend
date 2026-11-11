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
const MIB = 1024 * 1024;

type Send = jest.Mock;

function setUp({
  publicSend,
  ingestSend,
  uploadsDb = {}
}: {
  publicSend?: Send;
  ingestSend?: Send;
  uploadsDb?: Record<string, jest.Mock>;
} = {}) {
  const publicS3Send: Send =
    publicSend ?? jest.fn(async () => ({ UploadId: 'session' }));
  const ingestS3Send: Send =
    ingestSend ?? jest.fn(async () => ({ UploadId: 'ingest-session' }));
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
    () => ({ send: publicS3Send }) as unknown as S3Client,
    () => ({ send: ingestS3Send }) as unknown as S3Client,
    db as unknown as DropMediaUploadsDb,
    jest.fn().mockResolvedValue(undefined),
    budget as unknown as MediaUploadBudget
  );
  return {
    service,
    budget,
    db,
    publicSend: publicS3Send,
    ingestSend: ingestS3Send
  };
}

function reservation(budget: ReturnType<typeof setUp>['budget']) {
  return budget.reserve.mock.calls[0][0] as Record<string, string>;
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

  it('counts a single-PUT drop upload, with its key and type, before signing it', async () => {
    const { service, budget, db } = setUp();

    const result = await service.createSingedDropMediaUploadUrl({
      content_type: 'video/mp4',
      file_name: 'clip.mp4',
      author_id: 'author'
    });

    expect(reservation(budget)).toEqual({
      id: expect.stringMatching(UUID),
      profileId: 'author',
      source: 'drop',
      objectKey: new URL(result.media_url).pathname.slice(1),
      contentType: 'video/mp4'
    });
    expect(db.createUpload).toHaveBeenCalledWith(
      expect.objectContaining({ id: reservation(budget).id })
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
    expect(reservation(budget)).toEqual({
      id: key.split('/')[2].replace('.mp4', ''),
      profileId: 'author',
      source: 'wave',
      objectKey: key,
      contentType: 'video/mp4'
    });
  });

  it.each([
    ['drop', 'video/mp4'],
    ['drop', 'image/png'],
    ['wave', 'video/mp4'],
    ['wave', 'image/png']
  ])(
    'counts a %s multipart upload of %s at its public key',
    async (source, content_type) => {
      const { service, budget, db } = setUp();
      const input = { content_type, file_name: 'file', author_id: 'author' };

      const started =
        source === 'drop'
          ? await service.getDropMediaMultipartUploadKeyAndUploadId(input)
          : await service.getWaveMediaMultipartUploadKeyAndUploadId(input);

      expect(reservation(budget)).toMatchObject({
        profileId: 'author',
        source,
        objectKey: started.key,
        contentType: content_type
      });
      expect(started.key).toContain(reservation(budget).id);
      if (db.createUpload.mock.calls.length)
        expect(db.createUpload.mock.calls[0][0].id).toBe(
          reservation(budget).id
        );
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

  describe('gives the reservation back when preparation fails', () => {
    const video = {
      content_type: 'video/mp4',
      file_name: 'clip.mp4',
      author_id: 'author'
    };
    const image = { ...video, content_type: 'image/png', file_name: 'a.png' };
    const failingS3: Send = jest.fn(async () => {
      throw new Error('S3 unavailable');
    });
    const failingDb = {
      createUpload: jest.fn().mockRejectedValue(new Error('DB unavailable'))
    };
    it.each([
      [
        'drop single-PUT, signing',
        { signing: true },
        (s: UploadMediaService) => s.createSingedDropMediaUploadUrl(video)
      ],
      [
        'drop single-PUT, upload record',
        { uploadsDb: failingDb },
        (s: UploadMediaService) => s.createSingedDropMediaUploadUrl(video)
      ],
      [
        'wave single-PUT, signing',
        { signing: true },
        (s: UploadMediaService) => s.createSingedWaveMediaUploadUrl(video)
      ],
      [
        'drop multipart video, S3',
        { publicSend: failingS3 },
        (s: UploadMediaService) =>
          s.getDropMediaMultipartUploadKeyAndUploadId(video)
      ],
      [
        'drop multipart video, upload record',
        { uploadsDb: failingDb },
        (s: UploadMediaService) =>
          s.getDropMediaMultipartUploadKeyAndUploadId(video)
      ],
      [
        'drop multipart image, ingest S3',
        { ingestSend: failingS3 },
        (s: UploadMediaService) =>
          s.getDropMediaMultipartUploadKeyAndUploadId(image)
      ],
      [
        'wave multipart image, upload record',
        { uploadsDb: failingDb },
        (s: UploadMediaService) =>
          s.getWaveMediaMultipartUploadKeyAndUploadId(image)
      ]
    ])('%s', async (_, failure, prepare) => {
      if ('signing' in failure)
        jest
          .mocked(getSignedUrl)
          .mockRejectedValueOnce(new Error('signing failed'));
      const { service, budget } = setUp(
        'signing' in failure ? {} : (failure as Parameters<typeof setUp>[0])
      );

      await expect(prepare(service)).rejects.toThrow(/unavailable|failed/);

      expect(budget.release).toHaveBeenCalledTimes(1);
      expect(budget.release).toHaveBeenCalledWith(
        reservation(budget).id,
        'author'
      );
    });
  });

  describe('directly published media completion', () => {
    const uploadId = '12345678-1234-1234-1234-123456789012';
    const key = `drops/${uploadId}/${uploadId}.mp4`;
    const tracked = {
      findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue({
        id: uploadId,
        profile_id: 'author',
        status: 'uploading',
        declared_mime_type: 'video/mp4',
        public_key: key,
        s3_upload_id: 'session'
      }),
      updateUpload: jest.fn()
    };
    const complete = (service: UploadMediaService, completionKey = key) =>
      service.completeMultipartUpload({
        key: completionKey,
        upload_id: 'session',
        parts: [{ etag: 'e', part_no: 1 }],
        authenticatedProfileId: 'author'
      });
    const sizedSend = (size: number): Send =>
      jest.fn(async (command: unknown) =>
        command instanceof HeadObjectCommand
          ? { ContentLength: size }
          : { Key: key }
      );

    it('records the completed size of a tracked upload', async () => {
      const publicSend = sizedSend(777);
      const { service, budget } = setUp({ publicSend, uploadsDb: tracked });

      await complete(service);

      expect(budget.recordSize).toHaveBeenCalledWith(uploadId, 'author', 777);
      expect(
        publicSend.mock.calls.map(([c]) => (c as object).constructor)
      ).toEqual([CompleteMultipartUploadCommand, HeadObjectCommand]);
    });

    it('does not count untracked legacy keys', async () => {
      const { service, budget } = setUp({ publicSend: sizedSend(777) });

      await complete(service, 'drops/author_author/old/video.mp4');

      expect(budget.recordSize).not.toHaveBeenCalled();
    });

    it('settles an oversized upload at its size before refusing it', async () => {
      const { service, budget } = setUp({
        publicSend: sizedSend(600 * MIB),
        uploadsDb: tracked
      });

      await expect(complete(service)).rejects.toMatchObject({
        code: 'MEDIA_TOO_LARGE'
      });

      expect(budget.recordSize).toHaveBeenCalledWith(
        uploadId,
        'author',
        600 * MIB
      );
      expect(budget.release).not.toHaveBeenCalled();
    });

    it('leaves the entry pending when completion fails and may be retried', async () => {
      const publicSend: Send = jest.fn(async () => {
        throw Object.assign(new Error('InvalidPart'), { name: 'InvalidPart' });
      });
      const { service, budget } = setUp({ publicSend, uploadsDb: tracked });

      await expect(complete(service)).rejects.toThrow('InvalidPart');

      expect(budget.recordSize).not.toHaveBeenCalled();
      expect(budget.release).not.toHaveBeenCalled();
    });
  });

  describe('private image completion', () => {
    const upload = () => ({
      id: 'image-upload',
      profile_id: 'author',
      status: 'uploading',
      declared_mime_type: 'image/png',
      ingest_bucket: 'ingest-bucket',
      ingest_key: 'staging/drop-media-ingest/drops/image.png',
      s3_upload_id: 'ingest-session',
      public_url: 'https://cdn.example/drops/image.png'
    });
    const complete = (service: UploadMediaService) =>
      service.completeMultipartUpload({
        key: 'drops/image.png',
        upload_id: 'ingest-session',
        parts: [{ etag: 'e', part_no: 1 }],
        authenticatedProfileId: 'author'
      });

    it('records the size of the completed ingest object', async () => {
      const ingestSend: Send = jest.fn(async (command: unknown) =>
        command instanceof HeadObjectCommand ? { ContentLength: 555 } : {}
      );
      const { service, budget } = setUp({
        ingestSend,
        uploadsDb: {
          findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue(upload())
        }
      });

      await complete(service);

      expect(budget.recordSize).toHaveBeenCalledWith(
        'image-upload',
        'author',
        555
      );
      expect((ingestSend.mock.calls[1][0] as HeadObjectCommand).input).toEqual({
        Bucket: 'ingest-bucket',
        Key: 'staging/drop-media-ingest/drops/image.png'
      });
    });

    it.each([
      ['forbidden', { $metadata: { httpStatusCode: 403 } }],
      ['missing', { name: 'NotFound', $metadata: { httpStatusCode: 404 } }]
    ])(
      'leaves the entry pending when the size read is %s, without failing completion',
      async (_, failure) => {
        const ingestSend: Send = jest.fn(async (command: unknown) => {
          if (command instanceof HeadObjectCommand)
            throw Object.assign(new Error('head failed'), failure);
          return {};
        });
        const { service, budget } = setUp({
          ingestSend,
          uploadsDb: {
            findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue(upload())
          }
        });

        await expect(complete(service)).resolves.toMatchObject({
          media_status: 'processing'
        });
        expect(budget.recordSize).not.toHaveBeenCalled();
      }
    );

    it('settles a failed completion at 0', async () => {
      const ingestSend: Send = jest.fn(async () => {
        throw new Error('NoSuchUpload');
      });
      const { service, budget, db } = setUp({
        ingestSend,
        uploadsDb: {
          findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue(upload())
        }
      });

      await expect(complete(service)).rejects.toThrow('NoSuchUpload');

      expect(db.transitionStatus).toHaveBeenCalledWith(
        expect.objectContaining({ toStatus: 'failed' })
      );
      expect(budget.recordSize).toHaveBeenCalledWith(
        'image-upload',
        'author',
        0
      );
    });
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
