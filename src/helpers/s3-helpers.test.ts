const sendMock = jest.fn();
const mockUploadDone = jest.fn();
jest.mock('@/s3.client', () => ({ getS3: () => ({ send: sendMock }) }));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ warn: jest.fn(), info: jest.fn() }) }
}));
jest.mock('@aws-sdk/lib-storage', () => ({
  Upload: jest.fn(() => ({ done: mockUploadDone }))
}));

import { s3ObjectExists, s3UploadObject } from './s3_helpers';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'node:stream';

beforeEach(() => jest.clearAllMocks());

it('marks a zero-byte object for replacement even when its transaction ID matches', async () => {
  sendMock.mockResolvedValue({ ContentLength: 0, Metadata: { 'tx-id': 'tx' } });
  await expect(
    s3ObjectExists('bucket', 'images/original/558.JPG', 'tx', {
      requireNonEmpty: true
    })
  ).resolves.toEqual({ exists: false, invalidate: true });
  expect(sendMock.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
  expect(sendMock.mock.calls[0][0].input).toEqual({
    Bucket: 'bucket',
    Key: 'images/original/558.JPG'
  });
});

it.each([
  Object.assign(new Error('Missing'), { name: 'NoSuchKey' }),
  new Error('Transient connection failure'),
  Object.assign(new Error('Forbidden'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 }
  })
])(
  'does not classify a failed HEAD request as a confirmed empty object: %s',
  async (error) => {
    sendMock.mockRejectedValueOnce(error);
    await expect(
      s3ObjectExists('bucket', 'images/original/558.JPG', 'tx', {
        requireNonEmpty: true
      })
    ).resolves.toEqual({ exists: false });
  }
);

it('preserves a nonempty object with matching transaction metadata', async () => {
  sendMock.mockResolvedValue({
    ContentLength: 123,
    Metadata: { 'tx-id': 'tx' }
  });
  await expect(s3ObjectExists('bucket', 'image', 'tx')).resolves.toEqual({
    exists: true
  });
});

it('preserves generic existence semantics for callers that do not require media bytes', async () => {
  sendMock.mockResolvedValue({ ContentLength: 0, Metadata: { 'tx-id': 'tx' } });
  await expect(
    s3ObjectExists('bucket', 'non-media-object', 'tx')
  ).resolves.toEqual({ exists: true });
});

it('still replaces an object belonging to an older media transaction', async () => {
  sendMock.mockResolvedValue({
    ContentLength: 123,
    Metadata: { 'tx-id': 'old' }
  });
  await expect(s3ObjectExists('bucket', 'image', 'new')).resolves.toEqual({
    exists: false,
    invalidate: true
  });
});

describe('s3UploadObject cache control', () => {
  const upload = {
    bucket: 'bucket',
    key: 'images/original/558.JPG',
    contentType: 'image/jpeg',
    txId: 'tx'
  };

  it('stores the requested Cache-Control on buffered uploads', async () => {
    sendMock.mockResolvedValue({});
    await s3UploadObject({
      ...upload,
      body: Buffer.from('image'),
      cacheControl: 'public, max-age=86400'
    });
    const command = sendMock.mock.calls[0][0];
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({
      Bucket: 'bucket',
      Key: upload.key,
      ContentType: 'image/jpeg',
      CacheControl: 'public, max-age=86400',
      Metadata: { 'tx-id': 'tx' }
    });
  });

  it('stores the requested Cache-Control on streamed uploads', async () => {
    mockUploadDone.mockResolvedValue({});
    await s3UploadObject({
      ...upload,
      body: Readable.from([Buffer.from('video')]),
      cacheControl: 'public, max-age=86400'
    });
    expect(jest.mocked(Upload).mock.calls[0][0].params).toMatchObject({
      Key: upload.key,
      CacheControl: 'public, max-age=86400'
    });
  });

  it('leaves Cache-Control unset for callers that do not request it', async () => {
    sendMock.mockResolvedValue({});
    mockUploadDone.mockResolvedValue({});
    await s3UploadObject({ ...upload, body: Buffer.from('csv') });
    await s3UploadObject({ ...upload, body: Readable.from(['csv']) });
    expect(sendMock.mock.calls[0][0].input).not.toHaveProperty('CacheControl');
    expect(jest.mocked(Upload).mock.calls[0][0].params).not.toHaveProperty(
      'CacheControl'
    );
  });
});
