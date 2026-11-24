import express from 'express';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { customErrorMiddleware } from '@/api/api-error-middleware';
import { ApiDropMediaStatus } from '@/api/generated/models/ApiDropMediaStatus';
import { uploadMediaService } from '@/api/media/upload-media.service';
import waveMediaRoutes from './wave-media.routes';

jest.mock('@/api/auth/auth', () => ({
  getAuthenticatedProfileIdOrNull: jest.fn(async () => 'profile-1'),
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next()
}));
jest.mock('@/api/media/upload-media.service', () => ({
  uploadMediaService: { getWaveMediaMultipartUploadKeyAndUploadId: jest.fn() }
}));

describe('POST /wave-media/multipart-upload', () => {
  const startUpload = jest.mocked(
    uploadMediaService.getWaveMediaMultipartUploadKeyAndUploadId
  );
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/wave-media', waveMediaRoutes);
    app.use(customErrorMiddleware());
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/wave-media/multipart-upload`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => startUpload.mockReset());

  it('accepts WebP and ignores a client-supplied decision-entry purpose', async () => {
    const upload = {
      key: 'waves/author_profile-1/media-1.webp',
      upload_id: 'upload-1',
      media_upload_id: 'media-1',
      media_status: ApiDropMediaStatus.Uploading
    };
    startUpload.mockResolvedValue(upload);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        content_type: 'image/webp',
        file_name: 'picture.webp',
        purpose: 'decision_entry'
      })
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(upload);
    expect(startUpload).toHaveBeenCalledWith({
      content_type: 'image/webp',
      file_name: 'picture.webp',
      author_id: 'profile-1'
    });
  });
});
