import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { readObjectSize } from './object-size';

function s3(result: () => Promise<unknown>) {
  const send = jest.fn(async (..._args: unknown[]) => result());
  return { s3: { send } as never, send };
}

function failure(name: string, status?: number): Error {
  return Object.assign(new Error(name), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } })
  });
}

describe('readObjectSize', () => {
  it('reads the stored size with a HEAD of the object', async () => {
    const { s3: client, send } = s3(async () => ({ ContentLength: 1234 }));

    await expect(readObjectSize(client, 'bucket', 'key')).resolves.toEqual({
      exists: true,
      bytes: 1234
    });
    expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
    expect((send.mock.calls[0][0] as HeadObjectCommand).input).toEqual({
      Bucket: 'bucket',
      Key: 'key'
    });
  });

  it.each([
    ['NotFound', failure('NotFound', 404)],
    ['NoSuchKey', failure('NoSuchKey')],
    ['a 404 status', failure('Unknown', 404)]
  ])('reports a missing object for %s', async (_, error) => {
    const { s3: client } = s3(async () => {
      throw error;
    });

    await expect(readObjectSize(client, 'bucket', 'key')).resolves.toEqual({
      exists: false
    });
  });

  it.each([
    ['403', failure('Forbidden', 403)],
    ['throttling', failure('SlowDown', 503)],
    ['a network error', new Error('socket hang up')]
  ])('throws on %s: the answer is inconclusive', async (_, error) => {
    const { s3: client } = s3(async () => {
      throw error;
    });

    await expect(readObjectSize(client, 'bucket', 'key')).rejects.toBe(error);
  });

  it('throws when S3 reports no size', async () => {
    const { s3: client } = s3(async () => ({}));

    await expect(readObjectSize(client, 'bucket', 'key')).rejects.toThrow(
      'S3 reported no size for key'
    );
  });
});
