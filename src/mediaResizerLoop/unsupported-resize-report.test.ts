import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { reportUnsupportedResizeOnce } from './unsupported-resize-report';

const mockError = jest.fn();
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ error: (...args: unknown[]) => mockError(...args) }) }
}));
const mockSend = jest.fn();
const client = { send: mockSend } as unknown as S3Client;
const conflict = (status: number) => ({
  $metadata: { httpStatusCode: status }
});
beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockReset();
});

it('reports once across concurrent requests, with a private source fingerprint and no image data', async () => {
  const seen = new Set<string>();
  mockSend.mockImplementation(async (command: PutObjectCommand) => {
    const key = command.input.Key!;
    if (seen.has(key)) throw conflict(412);
    seen.add(key);
  });
  await Promise.all(
    Array.from({ length: 8 }, () =>
      reportUnsupportedResizeOnce(
        client,
        'bucket',
        'private/source.webp',
        'etag-1'
      )
    )
  );
  expect(mockError).toHaveBeenCalledTimes(1);
  const command = mockSend.mock.calls[0][0] as PutObjectCommand;
  expect(command.input).toMatchObject({
    IfNoneMatch: '*',
    Body: '',
    CacheControl: 'no-store'
  });
  expect(command.input.Key).toMatch(/^_resize-rejections\/v1\/[a-f0-9]{64}$/);
  expect(mockError.mock.calls[0][0]).not.toContain('private/source');
  expect(mockError.mock.calls[0][1].name).toBe('MediaResize.UnsupportedCodec');
});

it('gives replacement revisions, different sources and buckets separate report identities', async () => {
  mockSend.mockResolvedValue({});
  for (const [bucket, key, revision] of [
    ['bucket', 'a', 'v1'],
    ['bucket', 'a', 'v2'],
    ['bucket', 'b', 'v1'],
    ['other', 'a', 'v1']
  ]) {
    await reportUnsupportedResizeOnce(client, bucket, key, revision);
  }
  expect(
    new Set(mockSend.mock.calls.map(([command]) => command.input.Key)).size
  ).toBe(4);
  expect(mockError).toHaveBeenCalledTimes(4);
});

it('retries a conditional conflict and suppresses only a confirmed existing marker', async () => {
  mockSend
    .mockRejectedValueOnce(conflict(409))
    .mockRejectedValueOnce(conflict(412));
  await reportUnsupportedResizeOnce(client, 'bucket', 'key', 'etag');
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(mockError).not.toHaveBeenCalled();
});

it.each([403, 500, 409])(
  'reports marker failure %s instead of silently suppressing it',
  async (status) => {
    mockSend.mockRejectedValue(conflict(status));
    await reportUnsupportedResizeOnce(client, 'bucket', 'key', 'etag');
    expect(mockError).toHaveBeenCalledTimes(1);
    expect(mockError.mock.calls[0][1].name).toBe(
      'MediaResize.RejectionReportFailed'
    );
    expect(mockSend).toHaveBeenCalledTimes(status === 409 ? 3 : 1);
  }
);

it('reports missing source identity rather than deduplicating unrelated versions', async () => {
  await reportUnsupportedResizeOnce(client, 'bucket', 'key', undefined);
  expect(mockSend).not.toHaveBeenCalled();
  expect(mockError.mock.calls[0][1].name).toBe(
    'MediaResize.RejectionReportFailed'
  );
});
