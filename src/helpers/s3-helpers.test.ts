const sendMock = jest.fn();
jest.mock('@/s3.client', () => ({ getS3: () => ({ send: sendMock }) }));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ warn: jest.fn(), info: jest.fn() }) }
}));

import { s3ObjectExists } from './s3_helpers';
import { HeadObjectCommand } from '@aws-sdk/client-s3';

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
