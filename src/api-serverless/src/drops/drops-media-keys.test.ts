const mockPublicS3 = { send: jest.fn() };
const mockIngestS3 = { send: jest.fn() };
const mockUploadsDb = {
  findByPublicKeyAndS3UploadId: jest.fn(),
  updateUpload: jest.fn()
};

jest.mock('../auth/auth', () => ({
  needsAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  maybeAuthenticatedUser:
    () => (_req: unknown, _res: unknown, next: () => void) =>
      next(),
  getAuthenticatedProfileIdOrNull: jest.fn(async () => 'profile-1')
}));
// Upload budget accounting is covered in upload-media-budget.test.ts.
jest.mock('@/api/media/media-upload-budget.service', () => ({
  mediaUploadBudgetService: {
    reserve: jest.fn(),
    release: jest.fn(),
    recordSize: jest.fn()
  }
}));
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async () => 'https://signed-part-url.example')
}));
// The real service, with stand-ins for S3 and the uploads table.
jest.mock('../media/upload-media.service', () => {
  const actual = jest.requireActual('../media/upload-media.service');
  return {
    ...actual,
    uploadMediaService: new actual.UploadMediaService(
      () => mockPublicS3,
      () => mockIngestS3,
      {
        findByPublicKeyAndS3UploadId: (...args: unknown[]) =>
          mockUploadsDb.findByPublicKeyAndS3UploadId(...args),
        updateUpload: (...args: unknown[]) =>
          mockUploadsDb.updateUpload(...args)
      },
      jest.fn()
    )
  };
});

import express from 'express';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { customErrorMiddleware } from '@/api/api-error-middleware';
import dropsMediaRoutes from './drops-media.routes';

describe('drop-media multipart keys', () => {
  let server: Server;
  let url: string;
  const originalBucket = process.env.S3_BUCKET;

  beforeAll(async () => {
    process.env.S3_BUCKET = 'media-bucket';
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
    if (originalBucket === undefined) delete process.env.S3_BUCKET;
    else process.env.S3_BUCKET = originalBucket;
  });

  beforeEach(() => {
    mockPublicS3.send.mockReset();
    mockIngestS3.send.mockReset();
    mockUploadsDb.findByPublicKeyAndS3UploadId.mockReset();
    mockUploadsDb.updateUpload.mockReset();
    jest.mocked(getSignedUrl).mockClear();
  });

  const post = (path: string, body: Record<string, unknown>) =>
    fetch(`${url}/drop-media/multipart-upload${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  const parts = [{ etag: '"etag-1"', part_no: 1 }];

  it.each([
    'smoke/not-issued.wav',
    'distribution/test/0xabc/1-x.jpg',
    'attachments/other/file.pdf'
  ])(
    'refuses to complete %s, a key it never issued, before any S3 call',
    async (key) => {
      mockUploadsDb.findByPublicKeyAndS3UploadId.mockResolvedValue(null);

      const response = await post('/completion', {
        upload_id: 'upload-1',
        key,
        parts
      });

      expect(response.status).toBe(403);
      expect(mockPublicS3.send).not.toHaveBeenCalled();
      expect(mockIngestS3.send).not.toHaveBeenCalled();
    }
  );

  it('refuses a part URL for a key it never issued, without signing one', async () => {
    mockUploadsDb.findByPublicKeyAndS3UploadId.mockResolvedValue(null);

    const response = await post('/part', {
      upload_id: 'upload-1',
      key: 'smoke/not-issued.wav',
      part_no: 1
    });

    expect(response.status).toBe(403);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('refuses another author’s untracked key', async () => {
    mockUploadsDb.findByPublicKeyAndS3UploadId.mockResolvedValue(null);

    const response = await post('/completion', {
      upload_id: 'upload-1',
      key: 'waves/author_profile-2/clip.mp4',
      parts
    });

    expect(response.status).toBe(403);
    expect(mockPublicS3.send).not.toHaveBeenCalled();
  });

  it('completes a tracked upload of this profile, then answers a repeat from its READY state', async () => {
    const upload = {
      id: 'media-upload-1',
      profile_id: 'profile-1',
      declared_mime_type: 'audio/wav',
      status: 'uploading',
      public_key: 'drops/abc/clip.wav',
      public_url: 'https://cdn.example/drops/abc/clip.wav',
      s3_upload_id: 'upload-1'
    };
    mockUploadsDb.findByPublicKeyAndS3UploadId.mockResolvedValue(upload);
    mockUploadsDb.updateUpload.mockImplementation(async ({ patch }) => {
      Object.assign(upload, patch);
    });
    mockPublicS3.send.mockResolvedValue({
      Key: 'drops/abc/clip.wav',
      ContentLength: 1000
    });

    const first = await post('/completion', {
      upload_id: 'upload-1',
      key: 'drops/abc/clip.wav',
      parts
    });
    expect(first.status).toBe(200);
    // Completion, then the size check of the completed object.
    expect(mockPublicS3.send).toHaveBeenCalledTimes(2);
    expect(mockPublicS3.send.mock.calls[0][0].input).toMatchObject({
      Bucket: 'media-bucket',
      Key: 'drops/abc/clip.wav',
      UploadId: 'upload-1'
    });

    const repeat = await post('/completion', {
      upload_id: 'upload-1',
      key: 'drops/abc/clip.wav',
      parts
    });
    expect(repeat.status).toBe(200);
    const repeated = (await repeat.json()) as { media_status: string };
    expect(repeated.media_status).toBe('ready');
    expect(mockPublicS3.send).toHaveBeenCalledTimes(2);
  });

  it('still completes this author’s untracked (legacy) drop media key', async () => {
    mockUploadsDb.findByPublicKeyAndS3UploadId.mockResolvedValue(null);
    mockPublicS3.send.mockResolvedValue({
      Key: 'drops/author_profile-1/clip.mp4',
      ContentLength: 1000
    });

    const response = await post('/completion', {
      upload_id: 'upload-1',
      key: 'drops/author_profile-1/clip.mp4',
      parts
    });

    expect(response.status).toBe(200);
    expect(mockPublicS3.send).toHaveBeenCalledTimes(2);
  });
});
