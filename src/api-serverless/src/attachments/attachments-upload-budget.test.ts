const mockBudget = {
  reserve: jest.fn(),
  release: jest.fn(),
  recordSize: jest.fn()
};
const mockUploads = {
  attachmentKey: jest.fn(
    ({ attachmentId }: { attachmentId: string }) =>
      `test/attachments/incoming/author_profile-1/${attachmentId}/original.pdf`
  ),
  createMultipartUpload: jest.fn(),
  completeMultipartUpload: jest.fn(),
  readObjectSize: jest.fn()
};
const mockAttachmentsDb = {
  createAttachment: jest.fn(),
  findAttachmentById: jest.fn(),
  updateAttachment: jest.fn()
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
jest.mock('@/api/media/media-upload-budget.service', () => ({
  mediaUploadBudgetService: mockBudget
}));
jest.mock('@/api/attachments/upload-attachments.service', () => ({
  uploadAttachmentsService: mockUploads
}));
jest.mock('@/attachments/attachments.db', () => ({
  attachmentsDb: mockAttachmentsDb
}));
jest.mock('@/attachments/attachments-status-notifier', () => ({
  attachmentsStatusNotifier: { notifyStatusTransition: jest.fn() }
}));

import express from 'express';
import { Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { customErrorMiddleware } from '@/api/api-error-middleware';
import attachmentsRoutes from './attachments.routes';

describe('attachment uploads and the upload budget', () => {
  let server: Server;
  let url: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/attachments', attachmentsRoutes);
    app.use(customErrorMiddleware());
    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockBudget.reserve.mockResolvedValue(undefined);
    mockBudget.release.mockResolvedValue(undefined);
    mockBudget.recordSize.mockResolvedValue(undefined);
    mockUploads.createMultipartUpload.mockImplementation(
      async ({ attachmentId }: { attachmentId: string }) => ({
        key: mockUploads.attachmentKey({ attachmentId }),
        upload_id: 'session'
      })
    );
    mockAttachmentsDb.createAttachment.mockResolvedValue(undefined);
  });

  const post = (path: string, body: Record<string, unknown>) =>
    fetch(`${url}/attachments/multipart-upload${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  const prepare = () =>
    post('', { content_type: 'application/pdf', file_name: 'report.pdf' });

  it('counts the attachment, pending at its key, before starting the upload', async () => {
    const response = await prepare();

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      attachment_id: string;
      key: string;
    };
    expect(mockBudget.reserve).toHaveBeenCalledWith({
      id: body.attachment_id,
      profileId: 'profile-1',
      source: 'attachment',
      objectKey: body.key,
      contentType: 'application/pdf'
    });
    expect(mockBudget.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      mockUploads.createMultipartUpload.mock.invocationCallOrder[0]
    );
    expect(mockBudget.release).not.toHaveBeenCalled();
  });

  it('starts nothing when the budget refuses the attachment', async () => {
    const { CustomApiCompliantException } = jest.requireActual(
      '@/exceptions'
    ) as typeof import('@/exceptions');
    mockBudget.reserve.mockRejectedValue(
      new CustomApiCompliantException(429, 'Upload limit reached')
    );

    expect((await prepare()).status).toBe(429);
    expect(mockUploads.createMultipartUpload).not.toHaveBeenCalled();
    expect(mockAttachmentsDb.createAttachment).not.toHaveBeenCalled();
  });

  it.each([
    [
      'starting the S3 upload',
      () =>
        mockUploads.createMultipartUpload.mockRejectedValue(
          new Error('S3 unavailable')
        )
    ],
    [
      'recording the attachment',
      () =>
        mockAttachmentsDb.createAttachment.mockRejectedValue(
          new Error('DB unavailable')
        )
    ]
  ])('gives the reservation back when %s fails', async (_, fail) => {
    fail();

    expect((await prepare()).status).toBe(500);

    const [{ id }] = mockBudget.reserve.mock.calls[0];
    expect(mockBudget.release).toHaveBeenCalledWith(id, 'profile-1');
  });

  describe('completion', () => {
    const key = 'test/attachments/incoming/author_profile-1/a-1/original.pdf';
    const complete = () =>
      post('/completion', {
        attachment_id: 'a-1',
        upload_id: 'session',
        key,
        parts: [{ etag: '"e"', part_no: 1 }]
      });

    beforeEach(() => {
      mockAttachmentsDb.findAttachmentById.mockResolvedValue({
        id: 'a-1',
        owner_profile_id: 'profile-1',
        original_key: key,
        kind: 'PDF',
        status: 'UPLOADING',
        declared_mime: 'application/pdf',
        original_file_name: 'report.pdf',
        created_at: 1,
        updated_at: 1
      });
      mockUploads.completeMultipartUpload.mockResolvedValue({
        bucket: 'b',
        key
      });
    });

    it('records the stored size', async () => {
      mockUploads.readObjectSize.mockResolvedValue({
        exists: true,
        bytes: 1234
      });

      expect((await complete()).status).toBe(201);

      expect(mockUploads.readObjectSize).toHaveBeenCalledWith(key);
      expect(mockBudget.recordSize).toHaveBeenCalledWith(
        'a-1',
        'profile-1',
        1234
      );
    });

    it.each([
      ['missing', async () => ({ exists: false })],
      [
        'inconclusive',
        async () => {
          throw new Error('Forbidden');
        }
      ]
    ])('leaves the entry pending when the read is %s', async (_, readSize) => {
      mockUploads.readObjectSize.mockImplementation(readSize);

      expect((await complete()).status).toBe(201);

      expect(mockBudget.recordSize).not.toHaveBeenCalled();
      expect(mockBudget.release).not.toHaveBeenCalled();
    });

    it('leaves the entry pending when completion fails', async () => {
      mockUploads.completeMultipartUpload.mockRejectedValue(
        Object.assign(new Error('gone'), { name: 'NoSuchUpload' })
      );

      expect((await complete()).status).toBe(400);

      expect(mockUploads.readObjectSize).not.toHaveBeenCalled();
      expect(mockBudget.recordSize).not.toHaveBeenCalled();
      expect(mockBudget.release).not.toHaveBeenCalled();
    });
  });
});
