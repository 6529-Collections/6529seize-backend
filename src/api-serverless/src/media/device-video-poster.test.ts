import { decode, encode } from 'jpeg-js';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import {
  sanitizeDeviceVideoPoster,
  storeDeviceVideoPoster
} from './device-video-poster';
import { UploadMediaService } from './upload-media.service';
import { DropMediaUploadsDb } from '@/drops/drop-media-uploads.db';
import {
  getDeviceVideoPosterKey,
  MAX_DEVICE_POSTER_BYTES
} from '@/media/chat-video-poster';
import { Logger } from '@/logging';

const mockWarn = jest
  .spyOn(Logger.get('DEVICE_VIDEO_POSTER'), 'warn')
  .mockImplementation(() => undefined);
beforeEach(() => mockWarn.mockClear());
afterAll(() => mockWarn.mockRestore());

const key = 'drops/author_owner/12345678-1234-1234-1234-123456789012/clip.MP4';
function jpeg(width = 36, height = 64): Buffer {
  return encode(
    { width, height, data: Buffer.alloc(width * height * 4, 200) },
    75
  ).data;
}
function client(send: jest.Mock): S3Client {
  return { send } as unknown as S3Client;
}

it('decodes and re-encodes a bounded portrait JPEG without changing its dimensions', () => {
  const clean = sanitizeDeviceVideoPoster(jpeg().toString('base64'));
  expect(decode(clean)).toMatchObject({ width: 36, height: 64 });
});

it('strips client comments and EXIF segments when publishing the JPEG', () => {
  const comment = 'private-client-comment';
  const encoded = encode(
    {
      width: 36,
      height: 64,
      data: Buffer.alloc(36 * 64 * 4, 200),
      comments: [comment]
    },
    75
  ).data;
  const exif = Buffer.from('Exif\0\0private-client-metadata');
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(exif.length + 2, 2);
  const original = Buffer.concat([
    encoded.subarray(0, 2),
    header,
    exif,
    encoded.subarray(2)
  ]);
  const clean = sanitizeDeviceVideoPoster(original.toString('base64'));
  expect(original.includes(Buffer.from(comment))).toBe(true);
  expect(clean.includes(Buffer.from(comment))).toBe(false);
  expect(clean.includes(exif)).toBe(false);
  expect(decode(clean)).toMatchObject({ width: 36, height: 64 });
});

it.each([
  'invalid',
  '',
  Buffer.from('<svg/>').toString('base64'),
  'a'.repeat(174765)
])('rejects invalid or oversized poster data (%s)', (base64) => {
  expect(() => sanitizeDeviceVideoPoster(base64)).toThrow();
});
it('rejects oversized dimensions before allocating decoded pixels', () => {
  expect(() =>
    sanitizeDeviceVideoPoster(jpeg(641, 1).toString('base64'))
  ).toThrow('640');
});
it('rejects truncated JPEG pixels even when headers contain valid dimensions', () => {
  const bytes = jpeg();
  expect(() =>
    sanitizeDeviceVideoPoster(
      bytes.subarray(0, bytes.length - 100).toString('base64')
    )
  ).toThrow();
});

it('checks the pending upload and stores sanitized bytes with a validation marker', async () => {
  const send = jest.fn().mockResolvedValue({});
  await storeDeviceVideoPoster({
    s3: client(send),
    bucket: 'bucket',
    key,
    uploadId: 'id',
    base64: jpeg().toString('base64')
  });
  expect(send.mock.calls[0][0]).toBeInstanceOf(ListPartsCommand);
  expect(send.mock.calls[0][0].input).toMatchObject({
    Key: key,
    UploadId: 'id'
  });
  expect(send.mock.calls[1][0]).toBeInstanceOf(PutObjectCommand);
  expect(send.mock.calls[1][0].input).toMatchObject({
    Key: 'renditions/drops/author_owner/12345678-1234-1234-1234-123456789012/clip/poster/clip_device.jpg',
    ContentType: 'image/jpeg',
    Metadata: { 'chat-video-poster': 'validated-v1' }
  });
  expect(send.mock.calls[1][0].input.Body.length).toBeLessThanOrEqual(
    MAX_DEVICE_POSTER_BYTES
  );
});
it('does not publish a poster for an invalid pending upload', async () => {
  const send = jest.fn().mockRejectedValue(new Error('NoSuchUpload'));
  await storeDeviceVideoPoster({
    s3: client(send),
    bucket: 'bucket',
    key,
    uploadId: 'id',
    base64: jpeg().toString('base64')
  });
  expect(send).toHaveBeenCalledTimes(1);
});
it.each([
  'waves/author_owner/clip.mp4',
  'distribution/clip.mp4',
  'drops/clip.mp4',
  'drops/author_owner/clip.mp4',
  'drops/author_owner/not-a-uuid/clip.mp4',
  key.replace('.MP4', '.jpg')
])('ignores posters for non-drop-video key %s', async (mediaKey) => {
  const send = jest.fn();
  await storeDeviceVideoPoster({
    s3: client(send),
    bucket: 'bucket',
    key: mediaKey,
    uploadId: 'id',
    base64: jpeg().toString('base64')
  });
  expect(send).not.toHaveBeenCalled();
});

describe('video upload completion ordering', () => {
  const oldBucket = process.env.S3_BUCKET;
  beforeEach(() => {
    process.env.S3_BUCKET = 'bucket';
  });
  afterEach(() => {
    process.env.S3_BUCKET = oldBucket;
  });
  function service(send: jest.Mock): UploadMediaService {
    const db = {
      findByPublicKeyAndS3UploadId: jest.fn().mockResolvedValue(null)
    } as unknown as DropMediaUploadsDb;
    return new UploadMediaService(() => client(send), undefined, db);
  }
  const request = {
    key,
    upload_id: 'id',
    parts: [{ etag: 'etag', part_no: 1 }],
    authenticatedProfileId: 'owner'
  };
  it('publishes a device poster for the real drop-upload key and completes that upload', async () => {
    const send = jest.fn().mockResolvedValue({ UploadId: 'active-upload' });
    const uploads = service(send);
    const started = await uploads.getDropMediaMultipartUploadKeyAndUploadId({
      author_id: 'owner',
      content_type: 'video/mp4',
      file_name: 'My holiday.MP4'
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(started.key).toMatch(
      /^drops\/author_owner\/[0-9a-f-]{36}\/My-holiday\.MP4$/
    );
    send.mockClear();
    send.mockResolvedValue({ Key: started.key });
    await uploads.completeMultipartUpload({
      ...request,
      key: started.key,
      upload_id: started.upload_id,
      video_poster_base64: jpeg().toString('base64')
    });
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      ListPartsCommand,
      PutObjectCommand,
      CompleteMultipartUploadCommand
    ]);
    expect(send.mock.calls[0][0].input).toMatchObject({
      Key: started.key,
      UploadId: started.upload_id
    });
    expect(send.mock.calls[1][0].input.Key).toBe(
      getDeviceVideoPosterKey(started.key)
    );
    expect(send.mock.calls[2][0].input).toMatchObject({
      Key: started.key,
      UploadId: started.upload_id
    });
  });
  it('stores the poster before completing the video and triggering conversion', async () => {
    const send = jest.fn().mockResolvedValue({ Key: key });
    await service(send).completeMultipartUpload({
      ...request,
      video_poster_base64: jpeg().toString('base64')
    });
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      ListPartsCommand,
      PutObjectCommand,
      CompleteMultipartUploadCommand
    ]);
  });
  it.each([
    { failure: 'invalid', stage: 'validation' },
    { failure: 'lookup failure', stage: 'pending-upload' },
    { failure: 'storage failure', stage: 'storage' }
  ])(
    'still completes the video when poster preparation fails: $failure',
    async ({ failure, stage }) => {
      const send = jest.fn().mockResolvedValue({ Key: key });
      if (failure === 'lookup failure')
        send.mockRejectedValueOnce(new Error('AccessDenied'));
      if (failure === 'storage failure')
        send
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new Error('S3 unavailable'));
      await expect(
        service(send).completeMultipartUpload({
          ...request,
          video_poster_base64:
            failure === 'invalid' ? 'invalid' : jpeg().toString('base64')
        })
      ).resolves.toMatchObject({ media_status: 'ready' });
      expect(send.mock.lastCall?.[0]).toBeInstanceOf(
        CompleteMultipartUploadCommand
      );
      if (failure === 'lookup failure') {
        expect(send.mock.calls.map(([command]) => command.constructor)).toEqual(
          [ListPartsCommand, CompleteMultipartUploadCommand]
        );
      }
      expect(mockWarn).toHaveBeenCalledWith(
        'Device poster unavailable; using backend frame capture',
        { event: 'device_video_poster_fallback', stage }
      );
    }
  );
  it('checks ownership before any poster or video storage call', async () => {
    const send = jest.fn();
    await expect(
      service(send).completeMultipartUpload({
        ...request,
        authenticatedProfileId: 'other',
        video_poster_base64: jpeg().toString('base64')
      })
    ).rejects.toThrow('Cannot write');
    expect(send).not.toHaveBeenCalled();
  });
});
