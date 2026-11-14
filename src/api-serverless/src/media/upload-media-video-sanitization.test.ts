import { encode } from 'jpeg-js';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { CLOUDFRONT_LINK } from '@/constants';
import { UploadMediaService } from '@/api/media/upload-media.service';
import { ApiDropMediaStatus } from '@/api/generated/models/ApiDropMediaStatus';
import { DropMediaUploadsDb } from '@/drops/drop-media-uploads.db';
import {
  DropMediaUploadEntity,
  DropMediaUploadPurpose,
  DropMediaUploadStatus
} from '@/entities/IDropMediaUpload';
import { getDeviceVideoPosterKey } from '@/media/chat-video-poster';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn()
}));
// Upload budget accounting is covered in upload-media-budget.test.ts.
jest.mock('@/api/media/media-upload-budget.service', () => ({
  mediaUploadBudgetService: {
    reserve: jest.fn(),
    release: jest.fn(),
    recordSize: jest.fn()
  }
}));

const ORIGINAL_ENV = { ...process.env };

function setUp() {
  const publicS3 = {
    send: jest.fn(async (command: unknown) =>
      command instanceof CreateMultipartUploadCommand
        ? { UploadId: 'public-session' }
        : {}
    )
  };
  const ingestS3 = {
    send: jest.fn(async (command: unknown) =>
      command instanceof CreateMultipartUploadCommand
        ? { UploadId: 'ingest-session' }
        : {}
    )
  };
  let record: DropMediaUploadEntity | null = null;
  const uploadsDb = {
    createUpload: jest.fn(async (value: DropMediaUploadEntity) => {
      record = { ...value };
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
          ? { ...record }
          : null
    ),
    transitionStatus: jest.fn(
      async ({
        fromStatuses,
        toStatus
      }: {
        fromStatuses: DropMediaUploadStatus[];
        toStatus: DropMediaUploadStatus;
      }) => {
        if (!record || !fromStatuses.includes(record.status)) return false;
        record = { ...record, status: toStatus };
        return true;
      }
    ),
    claimSanitizerEnqueue: jest.fn().mockResolvedValue(true),
    updateUpload: jest.fn()
  };
  const enqueue = jest.fn().mockResolvedValue(undefined);
  const service = new UploadMediaService(
    () => publicS3 as unknown as S3Client,
    () => ingestS3 as unknown as S3Client,
    uploadsDb as unknown as DropMediaUploadsDb,
    enqueue
  );
  return {
    service,
    publicS3,
    ingestS3,
    uploadsDb,
    enqueue,
    record: () => record
  };
}

function inputs(
  mock: { send: jest.Mock },
  type: new (...args: any[]) => unknown
) {
  return mock.send.mock.calls
    .map(([command]) => command)
    .filter((command) => command instanceof type)
    .map((command) => (command as { input: Record<string, unknown> }).input);
}

function devicePoster(): string {
  return encode(
    { width: 32, height: 18, data: Buffer.alloc(32 * 18 * 4, 90) },
    75
  ).data.toString('base64');
}

describe('chat video metadata sanitization routing', () => {
  beforeEach(() => {
    jest.mocked(getSignedUrl).mockResolvedValue('https://signed.example');
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      S3_BUCKET: 'public-bucket',
      DROP_MEDIA_INGEST_S3_BUCKET: 'ingest-bucket',
      DROP_MEDIA_SANITIZE_VIDEOS: 'true'
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it.each(['video/mp4', 'video/quicktime'])(
    'sends a chat %s upload to private ingest to be stripped',
    async (contentType) => {
      const { service, publicS3, ingestS3, record } = setUp();
      const started = await service.getDropMediaMultipartUploadKeyAndUploadId({
        content_type: contentType,
        file_name: 'IMG_0042.MOV',
        author_id: 'author'
      });
      expect(started).toMatchObject({
        upload_id: 'ingest-session',
        media_status: ApiDropMediaStatus.Uploading,
        media_upload_id: record()!.id
      });
      expect(inputs(ingestS3, CreateMultipartUploadCommand)).toEqual([
        expect.objectContaining({
          Bucket: 'ingest-bucket',
          ContentType: contentType,
          Metadata: { 'sanitize-image-metadata': 'true' }
        })
      ]);
      expect(publicS3.send).not.toHaveBeenCalled();
      expect(record()).toMatchObject({
        purpose: DropMediaUploadPurpose.CHAT,
        public_key: started.key,
        ingest_bucket: 'ingest-bucket'
      });
      expect(record()!.ingest_key).not.toBe(started.key);
      expect(started.key).not.toContain('IMG_0042');
    }
  );

  it.each([
    ['the switch is off', 'video/mp4', DropMediaUploadPurpose.CHAT, 'false'],
    [
      'a decision entry',
      'video/mp4',
      DropMediaUploadPurpose.DECISION_ENTRY,
      'true'
    ],
    ['an AVI video', 'video/x-msvideo', DropMediaUploadPurpose.CHAT, 'true'],
    ['audio', 'audio/mpeg', DropMediaUploadPurpose.CHAT, 'true']
  ])(
    'publishes %s directly, byte for byte',
    async (_, contentType, purpose, flag) => {
      process.env.DROP_MEDIA_SANITIZE_VIDEOS = flag;
      const { service, publicS3, ingestS3, record } = setUp();
      const started = await service.getDropMediaMultipartUploadKeyAndUploadId({
        content_type: contentType,
        file_name: 'clip.bin',
        author_id: 'author',
        purpose
      });
      expect(started.upload_id).toBe('public-session');
      expect(inputs(publicS3, CreateMultipartUploadCommand)).toHaveLength(1);
      expect(ingestS3.send).not.toHaveBeenCalled();
      expect(record()!.ingest_key).toBe(started.key);
    }
  );

  it('refuses single-PUT chat videos while stripping is on, but not decision entries', async () => {
    const { service } = setUp();
    await expect(
      service.createSingedDropMediaUploadUrl({
        content_type: 'video/mp4',
        file_name: 'clip.mp4',
        author_id: 'author'
      })
    ).rejects.toThrow('Chat videos must use multipart upload');
    await expect(
      service.createSingedDropMediaUploadUrl({
        content_type: 'video/mp4',
        file_name: 'clip.mp4',
        author_id: 'author',
        purpose: DropMediaUploadPurpose.DECISION_ENTRY
      })
    ).resolves.toMatchObject({ upload_url: 'https://signed.example' });
  });

  it('completes a private chat video, stores its device poster first and queues the sanitizer', async () => {
    const { service, publicS3, ingestS3, enqueue, record } = setUp();
    const started = await service.getDropMediaMultipartUploadKeyAndUploadId({
      content_type: 'video/mp4',
      file_name: 'clip.mp4',
      author_id: 'author'
    });
    const ingestKey = record()!.ingest_key;
    // The switch may change before completion; the upload's start decides.
    process.env.DROP_MEDIA_SANITIZE_VIDEOS = 'false';

    await service.getSignedUrlForPartOfMultipartUpload({
      ...started,
      part_no: 1,
      authenticatedProfileId: 'author'
    });
    expect(jest.mocked(getSignedUrl).mock.lastCall?.[0]).toBe(ingestS3);

    const completed = await service.completeMultipartUpload({
      ...started,
      parts: [{ etag: '"etag"', part_no: 1 }],
      authenticatedProfileId: 'author',
      video_poster_base64: devicePoster()
    });

    expect(completed).toEqual({
      media_url: `${CLOUDFRONT_LINK}/${started.key}`,
      mime_type: 'video/mp4',
      media_upload_id: record()!.id,
      media_status: ApiDropMediaStatus.Processing
    });
    expect(inputs(ingestS3, ListPartsCommand)).toEqual([
      { Bucket: 'ingest-bucket', Key: ingestKey, UploadId: 'ingest-session' }
    ]);
    expect(inputs(publicS3, PutObjectCommand)).toEqual([
      expect.objectContaining({
        Bucket: 'public-bucket',
        Key: getDeviceVideoPosterKey(started.key),
        ContentType: 'image/jpeg'
      })
    ]);
    const order = ingestS3.send.mock.calls.map(
      ([command]) => (command as object).constructor.name
    );
    expect(order.indexOf('ListPartsCommand')).toBeLessThan(
      order.indexOf('CompleteMultipartUploadCommand')
    );
    expect(inputs(ingestS3, CompleteMultipartUploadCommand)).toEqual([
      expect.objectContaining({ Bucket: 'ingest-bucket', Key: ingestKey })
    ]);
    expect(enqueue).toHaveBeenCalledWith({ mediaUploadId: record()!.id });
    expect(record()!.status).toBe(DropMediaUploadStatus.PROCESSING);
  });

  it.each([
    ['the pending-upload check fails', devicePoster(), true],
    ['the poster is malformed', 'not-a-jpeg', false]
  ])(
    'still completes and queues a chat video when %s',
    async (_, poster, failListParts) => {
      const { service, publicS3, ingestS3, enqueue, record } = setUp();
      const started = await service.getDropMediaMultipartUploadKeyAndUploadId({
        content_type: 'video/mp4',
        file_name: 'clip.mp4',
        author_id: 'author'
      });
      const send = ingestS3.send.getMockImplementation()!;
      ingestS3.send.mockImplementation(async (command: unknown) => {
        if (failListParts && command instanceof ListPartsCommand) {
          throw Object.assign(new Error('SlowDown'), { name: 'SlowDown' });
        }
        return send(command);
      });

      await expect(
        service.completeMultipartUpload({
          ...started,
          parts: [{ etag: '"etag"', part_no: 1 }],
          authenticatedProfileId: 'author',
          video_poster_base64: poster
        })
      ).resolves.toMatchObject({ media_status: ApiDropMediaStatus.Processing });
      expect(inputs(publicS3, PutObjectCommand)).toEqual([]);
      expect(inputs(ingestS3, CompleteMultipartUploadCommand)).toHaveLength(1);
      expect(enqueue).toHaveBeenCalledWith({ mediaUploadId: record()!.id });
    }
  );
});
