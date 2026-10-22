import {
  HeadObjectCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
const decoder: { HEIC_DECODER_POLICY: string } = jest.requireActual(
  '@/mediaResizerLoop/heic-preview'
);
import {
  withHeicResizeRejection,
  hasHeicResizeRejection
} from '@/mediaResizerLoop/heic-resize-rejection';
import { UnprocessableResizeInput } from '@/mediaResizerLoop/resize-resource-safety';

const mockError = jest.fn();
jest.mock('@/logging', () => ({
  Logger: { get: () => ({ error: (...args: unknown[]) => mockError(...args) }) }
}));
const mockSend = jest.fn();
const client = { send: mockSend } as unknown as S3Client;
const stored = new Map<string, Record<string, string>>();
const missing = () =>
  Object.assign(new Error('missing'), {
    name: 'NotFound',
    $metadata: { httpStatusCode: 404 }
  });
beforeEach(() => {
  jest.clearAllMocks();
  stored.clear();
  mockSend
    .mockReset()
    .mockImplementation(
      async (command: HeadObjectCommand | PutObjectCommand) => {
        const key = command.input.Key!;
        if (command instanceof HeadObjectCommand) {
          if (!stored.has(key)) throw missing();
          return { Metadata: stored.get(key) };
        }
        if (stored.has(key)) throw { $metadata: { httpStatusCode: 412 } };
        stored.set(key, (command as PutObjectCommand).input.Metadata!);
        return {};
      }
    );
});
afterEach(() => jest.restoreAllMocks());

it('decodes a permanently rejected revision once across subsequent resize requests', async () => {
  const convert = jest.fn(async () => {
    throw new UnprocessableResizeInput('HEIC_DECODE_FAILED');
  });
  for (let index = 0; index < 3; index++) {
    await expect(
      withHeicResizeRejection(
        client,
        'bucket',
        'private/key.jpg',
        'etag',
        convert
      )
    ).rejects.toMatchObject({ code: 'HEIC_DECODE_FAILED' });
  }
  expect(convert).toHaveBeenCalledTimes(1);
  expect(mockError).toHaveBeenCalledTimes(1);
  expect(
    mockSend.mock.calls.filter(([c]) => c instanceof PutObjectCommand)
  ).toHaveLength(1);
  const command = mockSend.mock.calls.find(
    ([c]) => c instanceof PutObjectCommand
  )![0];
  expect(command.input).toMatchObject({
    Body: '',
    IfNoneMatch: '*',
    CacheControl: 'no-store'
  });
  expect(command.input.Key).toMatch(/^_resize-rejections\/v2\/[a-f0-9]{64}$/);
  expect(JSON.stringify(command.input)).not.toContain('private/key');
  expect(mockError.mock.calls[0][1].name).toBe(
    'MediaResize.HeicDecodeRejected'
  );
});

it('deduplicates reports from concurrent decoders for one source revision', async () => {
  const convert = async () => {
    throw new UnprocessableResizeInput('HEIC_DECODE_FAILED');
  };
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      withHeicResizeRejection(client, 'bucket', 'key', 'etag', convert)
    )
  );
  expect(results.every((r) => r.status === 'rejected')).toBe(true);
  expect(mockError).toHaveBeenCalledTimes(1);
});

it('retries changed source revisions and decoder policies', async () => {
  const reject = async () => {
    throw new UnprocessableResizeInput('HEIC_DECODE_FAILED');
  };
  await expect(
    withHeicResizeRejection(client, 'bucket', 'key', 'v1', reject)
  ).rejects.toThrow();
  const convert = jest.fn(async () => 'jpeg');
  await expect(
    withHeicResizeRejection(client, 'bucket', 'key', 'v2', convert)
  ).resolves.toBe('jpeg');
  jest.replaceProperty(decoder, 'HEIC_DECODER_POLICY', 'next-decoder-policy');
  await expect(
    withHeicResizeRejection(client, 'bucket', 'key', 'v1', convert)
  ).resolves.toBe('jpeg');
  expect(convert).toHaveBeenCalledTimes(2);
});

it.each([
  new Error('HEIC_CONVERSION_WORKER_FAILED'),
  new Error('HEIC_CONVERSION_DEADLINE_EXCEEDED'),
  new Error('S3 transport failure'),
  new UnprocessableResizeInput('DECODED_IMAGE_TOO_LARGE')
])('does not persist transient or budget failures: %s', async (error) => {
  const convert = jest.fn(async () => {
    throw error;
  });
  await expect(
    withHeicResizeRejection(client, 'bucket', 'key', 'etag', convert)
  ).rejects.toBe(error);
  expect(stored.size).toBe(0);
  expect(mockError).not.toHaveBeenCalled();
});

it.each([403, 500])(
  'propagates rejection lookup failure %s before decoding',
  async (status) => {
    const error = { $metadata: { httpStatusCode: status } };
    mockSend.mockRejectedValue(error);
    const convert = jest.fn();
    await expect(
      withHeicResizeRejection(client, 'bucket', 'key', 'etag', convert)
    ).rejects.toBe(error);
    expect(convert).not.toHaveBeenCalled();
  }
);

it('does not treat arbitrary 404 errors or malformed markers as known rejections', async () => {
  const error = { name: 'OtherFailure', $metadata: { httpStatusCode: 404 } };
  mockSend.mockRejectedValueOnce(error).mockResolvedValueOnce({ Metadata: {} });
  await expect(
    hasHeicResizeRejection(client, 'bucket', 'key', 'etag')
  ).rejects.toBe(error);
  await expect(
    hasHeicResizeRejection(client, 'bucket', 'key', 'etag')
  ).rejects.toThrow('Invalid HEIC');
});

it('propagates marker-write failures and retries only conditional conflicts', async () => {
  const error = { $metadata: { httpStatusCode: 403 } };
  mockSend.mockRejectedValueOnce(missing()).mockRejectedValueOnce(error);
  const reject = async () => {
    throw new UnprocessableResizeInput('HEIC_DECODE_FAILED');
  };
  await expect(
    withHeicResizeRejection(client, 'bucket', 'key', 'etag', reject)
  ).rejects.toBe(error);
  mockSend
    .mockRejectedValueOnce(missing())
    .mockRejectedValueOnce({ $metadata: { httpStatusCode: 409 } });
  await expect(
    withHeicResizeRejection(client, 'bucket', 'key', 'etag', reject)
  ).rejects.toMatchObject({ code: 'HEIC_DECODE_FAILED' });
  expect(mockError).toHaveBeenCalledTimes(1);
});
