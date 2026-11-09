jest.mock('../auth/auth', () => ({
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  maybeAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getAuthenticatedProfileIdOrNull: jest.fn(async () => 'profile-1')
}));
jest.mock('../media/upload-media.service', () => ({
  uploadMediaService: { completeMultipartUpload: jest.fn() }
}));

import express from 'express';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { customErrorMiddleware } from '@/api/api-error-middleware';
import { uploadMediaService } from '../media/upload-media.service';
import dropsMediaRoutes from './drops-media.routes';

/** An error shaped like the AWS SDK v3 S3 service exceptions. */
function s3Error(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('POST /drop-media/multipart-upload/completion', () => {
  let server: Server;
  let url: string;
  const complete = jest.mocked(uploadMediaService.completeMultipartUpload);

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/drop-media', dropsMediaRoutes);
    app.use(customErrorMiddleware());
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => complete.mockReset());

  const completion = () =>
    fetch(`${url}/drop-media/multipart-upload/completion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        upload_id: 'upload-1',
        key: 'drops/author_1/file.mp4',
        parts: [{ etag: '"etag-1"', part_no: 1 }]
      })
    });

  it('answers 400 when S3 no longer has the upload (NoSuchUpload)', async () => {
    complete.mockRejectedValue(
      s3Error('NoSuchUpload', 'The specified upload does not exist.')
    );

    const response = await completion();

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'The specified upload does not exist.'
    });
  });

  it('answers 400 for NoSuchUpload reported only through Code', async () => {
    complete.mockRejectedValue(
      Object.assign(new Error('gone'), { name: '', Code: 'NoSuchUpload' })
    );

    expect((await completion()).status).toBe(400);
  });

  it('still answers 500 for other S3 errors', async () => {
    complete.mockRejectedValue(s3Error('InternalError', 'We hit a snag.'));

    const response = await completion();

    expect(response.status).toBe(500);
  });

  it('returns the completed upload unchanged', async () => {
    complete.mockResolvedValue({
      media_url: 'https://media.example/file.mp4',
      media_status: 'READY'
    } as never);

    const response = await completion();

    expect(response.status).toBe(200);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        upload_id: 'upload-1',
        authenticatedProfileId: 'profile-1'
      })
    );
  });
});
