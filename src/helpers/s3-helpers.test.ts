const sendMock = jest.fn();
jest.mock('@/s3.client', () => ({ getS3: () => ({ send: sendMock }) }));
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ warn: jest.fn(), info: jest.fn() }) }
}));

import { s3ObjectExists } from './s3_helpers';

beforeEach(() => jest.clearAllMocks());

it('marks a zero-byte object for replacement even when its transaction ID matches', async () => {
  sendMock.mockResolvedValue({ ContentLength: 0, Metadata: { 'tx-id': 'tx' } });
  await expect(
    s3ObjectExists('bucket', 'images/original/558.JPG', 'tx', {
      requireNonEmpty: true
    })
  ).resolves.toEqual({ exists: false, invalidate: true });
});

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
