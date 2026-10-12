import { decode, encode } from 'jpeg-js';
import { imageSize } from 'image-size';
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

jest.mock('image-size', () => {
  const actual = jest.requireActual<typeof import('image-size')>('image-size');
  return { ...actual, imageSize: jest.fn(actual.imageSize) };
});

const mockWarn = jest
  .spyOn(Logger.get('DEVICE_VIDEO_POSTER'), 'warn')
  .mockImplementation(() => undefined);
beforeEach(() => {
  mockWarn.mockClear();
  jest.mocked(imageSize).mockClear();
});
afterAll(() => mockWarn.mockRestore());

const key = 'drops/author_owner/12345678-1234-1234-1234-123456789012/clip.MP4';
function jpeg(width = 36, height = 64): Buffer {
  return encode(
    { width, height, data: Buffer.alloc(width * height * 4, 200) },
    75
  ).data;
}
function orientedJpeg(orientation: number, littleEndian = true): Buffer {
  const exif = Buffer.alloc(32);
  exif.write('Exif\0\0');
  exif.write(littleEndian ? 'II' : 'MM', 6);
  const short = (value: number, offset: number) =>
    littleEndian
      ? exif.writeUInt16LE(value, offset)
      : exif.writeUInt16BE(value, offset);
  const long = (value: number, offset: number) =>
    littleEndian
      ? exif.writeUInt32LE(value, offset)
      : exif.writeUInt32BE(value, offset);
  short(42, 8);
  long(8, 10);
  short(1, 14);
  short(0x0112, 16);
  short(3, 18);
  long(1, 20);
  short(orientation, 24);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(exif.length + 2, 2);
  const bytes = jpeg();
  return Buffer.concat([bytes.subarray(0, 2), header, exif, bytes.subarray(2)]);
}

function malformedIcns(): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.write('icns');
  bytes.writeUInt32BE(16, 4);
  bytes.write('ic04', 8);
  // A zero entry length formerly caused image-size's ICNS parser to loop.
  return bytes;
}
function client(send: jest.Mock): S3Client {
  return { send } as unknown as S3Client;
}

it('decodes and re-encodes a bounded portrait JPEG without changing its dimensions', () => {
  const clean = sanitizeDeviceVideoPoster(jpeg().toString('base64'));
  expect(decode(clean)).toMatchObject({ width: 36, height: 64 });
});

it.each([
  Buffer.from('not an image'),
  malformedIcns(),
  Buffer.from([0xff, 0xd8])
])('rejects non-JPEG bytes before calling the size detector', (bytes) => {
  expect(() => sanitizeDeviceVideoPoster(bytes.toString('base64'))).toThrow(
    'must be a JPEG'
  );
  expect(imageSize).not.toHaveBeenCalled();
});

it.each([1, 2, 3, 4, 5, 6, 7, 8])(
  'rejects EXIF metadata with orientation %s before image parsing',
  (orientation) => {
    for (const littleEndian of [true, false]) {
      expect(() =>
        sanitizeDeviceVideoPoster(
          orientedJpeg(orientation, littleEndian).toString('base64')
        )
      ).toThrow('APP1 metadata');
    }
    expect(imageSize).not.toHaveBeenCalled();
  }
);

it('rejects conflicting duplicate APP1 blocks regardless of their order', () => {
  for (const orientations of [
    [6, 1],
    [1, 6]
  ]) {
    const first = orientedJpeg(orientations[0]!);
    const second = orientedJpeg(orientations[1]!);
    const duplicate = Buffer.concat([
      first.subarray(0, 38),
      second.subarray(2)
    ]);
    expect(() =>
      sanitizeDeviceVideoPoster(duplicate.toString('base64'))
    ).toThrow('APP1 metadata');
  }
  expect(imageSize).not.toHaveBeenCalled();
});

it('rejects APP1 metadata after the scan instead of relying on the size detector', () => {
  const bytes = jpeg();
  const app1 = orientedJpeg(6).subarray(2, 38);
  const lateMetadata = Buffer.concat([
    bytes.subarray(0, bytes.length - 2),
    app1,
    bytes.subarray(bytes.length - 2)
  ]);
  expect(() =>
    sanitizeDeviceVideoPoster(lateMetadata.toString('base64'))
  ).toThrow('APP1 metadata');
  expect(imageSize).not.toHaveBeenCalled();
});

it('rejects XMP APP1 display metadata without interpreting it', () => {
  const payload = Buffer.from(
    'http://ns.adobe.com/xap/1.0/\0<exif:Orientation>6</exif:Orientation>'
  );
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  const bytes = jpeg();
  const input = Buffer.concat([
    bytes.subarray(0, 2),
    header,
    payload,
    bytes.subarray(2)
  ]);
  expect(() => sanitizeDeviceVideoPoster(input.toString('base64'))).toThrow(
    'APP1 metadata'
  );
  expect(imageSize).not.toHaveBeenCalled();
});

it('rejects zero-length header segments without entering the size detector', () => {
  expect(() =>
    sanitizeDeviceVideoPoster(
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString('base64')
    )
  ).toThrow('Invalid JPEG segment');
  expect(imageSize).not.toHaveBeenCalled();
});

it('rejects a crafted scan marker whose claimed length would hide a later APP1', () => {
  const bytes = jpeg();
  const app1 = orientedJpeg(6).subarray(2, 38);
  const fakeMarker = Buffer.from([0xff, 0x02, 0, app1.length + 2]);
  const input = Buffer.concat([
    bytes.subarray(0, bytes.length - 2),
    fakeMarker,
    app1,
    bytes.subarray(bytes.length - 2)
  ]);
  expect(() => sanitizeDeviceVideoPoster(input.toString('base64'))).toThrow(
    'Invalid JPEG marker'
  );
  expect(imageSize).not.toHaveBeenCalled();
});

it('rejects truncated marker padding before entering the size detector', () => {
  const bytes = jpeg();
  const input = Buffer.concat([
    bytes.subarray(0, bytes.length - 2),
    Buffer.from([0xff, 0xff])
  ]);
  expect(() => sanitizeDeviceVideoPoster(input.toString('base64'))).toThrow(
    'Invalid JPEG marker'
  );
  expect(imageSize).not.toHaveBeenCalled();
});

it('does not interpret APP1-shaped bytes inside a different marker payload', () => {
  const bytes = jpeg();
  const payload = orientedJpeg(6).subarray(2, 38);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe0, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  const input = Buffer.concat([
    bytes.subarray(0, 2),
    header,
    payload,
    bytes.subarray(2)
  ]);
  const clean = sanitizeDeviceVideoPoster(input.toString('base64'));
  expect(decode(clean)).toMatchObject({ width: 36, height: 64 });
  expect(imageSize(clean).orientation).toBeUndefined();
});

it('strips client comments when publishing a canvas JPEG', () => {
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
  const original = encoded;
  const clean = sanitizeDeviceVideoPoster(original.toString('base64'));
  expect(original.includes(Buffer.from(comment))).toBe(true);
  expect(clean.includes(Buffer.from(comment))).toBe(false);
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
    let finishPoster!: () => void;
    const posterStored = new Promise<void>((resolve) => {
      finishPoster = resolve;
    });
    const send = jest
      .fn()
      .mockImplementation((command) =>
        command instanceof PutObjectCommand
          ? posterStored
          : Promise.resolve({ Key: key })
      );
    const completion = service(send).completeMultipartUpload({
      ...request,
      video_poster_base64: jpeg().toString('base64')
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      ListPartsCommand,
      PutObjectCommand
    ]);
    finishPoster();
    await completion;
    expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
      ListPartsCommand,
      PutObjectCommand,
      CompleteMultipartUploadCommand
    ]);
  });
  it.each([malformedIcns(), orientedJpeg(6)])(
    'completes the video without storing an unsafe or rotated poster',
    async (bytes) => {
      const send = jest.fn().mockResolvedValue({ Key: key });
      await expect(
        service(send).completeMultipartUpload({
          ...request,
          video_poster_base64: bytes.toString('base64')
        })
      ).resolves.toMatchObject({ media_status: 'ready' });
      expect(send.mock.calls.map(([command]) => command.constructor)).toEqual([
        CompleteMultipartUploadCommand
      ]);
      expect(mockWarn).toHaveBeenCalledWith(
        'Device poster unavailable; using backend frame capture',
        { event: 'device_video_poster_fallback', stage: 'validation' }
      );
    }
  );
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
