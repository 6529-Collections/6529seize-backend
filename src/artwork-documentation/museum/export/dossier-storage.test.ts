import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  S3Client,
  UploadPartCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { DossierStorage } from './dossier.storage';
import { DossierExportRow } from './dossier.types';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async () => 'https://private.example/immutable')
}));

function fixture() {
  const calls: unknown[] = [];
  const send = jest.fn(async (command: unknown) => {
    calls.push(command);
    if (command instanceof CreateMultipartUploadCommand)
      return { UploadId: 'upload-1' };
    if (command instanceof UploadPartCommand)
      return { ETag: `etag-${command.input.PartNumber}` };
    if (command instanceof CompleteMultipartUploadCommand)
      return { VersionId: 'immutable-v1' };
    return {};
  });
  const client = { send } as unknown as S3Client;
  return { storage: new DossierStorage(() => client), send, client, calls };
}

afterEach(() => jest.clearAllMocks());

it('streams exact source bytes into bounded multipart parts and records the immutable completed version', async () => {
  const f = fixture();
  const chunks = [
    Buffer.alloc(13 * 1024 ** 2, 5),
    Buffer.alloc(5 * 1024 ** 2 + 7, 9)
  ];
  async function* source() {
    yield* chunks;
  }
  const result = await f.storage.upload(
    'export-1',
    source(),
    new AbortController().signal
  );
  const uploaded = f.calls.filter(
    (command): command is UploadPartCommand =>
      command instanceof UploadPartCommand
  );
  expect(uploaded.map((part) => part.input.ContentLength)).toEqual([
    16 * 1024 ** 2,
    2 * 1024 ** 2 + 7
  ]);
  expect(
    Buffer.concat(uploaded.map((part) => part.input.Body as Buffer))
  ).toEqual(Buffer.concat(chunks));
  expect(result).toEqual({
    object_version: 'immutable-v1',
    size_bytes: chunks.reduce((size, chunk) => size + chunk.length, 0),
    sha256: createHash('sha256')
      .update(chunks[0])
      .update(chunks[1])
      .digest('hex')
  });
  const started = f.calls.find(
    (command): command is CreateMultipartUploadCommand =>
      command instanceof CreateMultipartUploadCommand
  );
  expect(started?.input).toMatchObject({
    ContentType: 'application/octet-stream',
    CacheControl: 'private, no-store',
    ServerSideEncryption: 'AES256'
  });
});

it('aborts an incomplete multipart upload when source verification fails', async () => {
  const f = fixture();
  async function* source() {
    yield Buffer.alloc(16 * 1024 ** 2);
    throw new Error('Synthetic fixity failure');
  }
  await expect(
    f.storage.upload('export-1', source(), new AbortController().signal)
  ).rejects.toThrow('Synthetic fixity failure');
  expect(
    f.calls.some((command) => command instanceof AbortMultipartUploadCommand)
  ).toBe(true);
  expect(
    f.calls.some((command) => command instanceof CompleteMultipartUploadCommand)
  ).toBe(false);
});

it('rejects completion without an S3 object version', async () => {
  const f = fixture();
  f.send.mockImplementation(async (command: unknown) => {
    if (command instanceof CreateMultipartUploadCommand)
      return { UploadId: 'upload-1' };
    if (command instanceof UploadPartCommand) return { ETag: 'etag-1' };
    return {};
  });
  async function* source() {
    yield Buffer.from('Synthetic package');
  }
  await expect(
    f.storage.upload('export-1', source(), new AbortController().signal)
  ).rejects.toThrow('immutable object version');
});

it('signs only the exact immutable object version as a short-lived attachment', async () => {
  const f = fixture();
  const row = {
    id: 'export-1',
    object_version: 'immutable-v1'
  } as DossierExportRow;
  await f.storage.download(row);
  const [client, command, options] = jest.mocked(getSignedUrl).mock.calls[0];
  expect(client).toBe(f.client);
  expect((command as GetObjectCommand).input).toMatchObject({
    VersionId: 'immutable-v1',
    ResponseContentType: 'application/octet-stream',
    ResponseCacheControl: 'private, no-store'
  });
  expect(options).toMatchObject({ expiresIn: 60 });
  await expect(
    f.storage.download({ ...row, object_version: null })
  ).rejects.toThrow('version is unavailable');
  expect(getSignedUrl).toHaveBeenCalledTimes(1);
});
