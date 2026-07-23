import { mock } from 'ts-jest-mocker';
import { AttachmentsStatusNotifier } from './attachments-status-notifier';
import { AttachmentsDb } from '@/attachments/attachments.db';
import { WsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import {
  AttachmentEntity,
  AttachmentKind,
  AttachmentStatus
} from '@/entities/IAttachment';
import { ApiAttachmentKind } from '@/api/generated/models/ApiAttachmentKind';
import { ApiAttachmentSafetyStatus } from '@/api/generated/models/ApiAttachmentSafetyStatus';
import { ApiAttachmentStatus } from '@/api/generated/models/ApiAttachmentStatus';
import type { ConnectionWrapper } from '@/sql-executor';

describe('AttachmentsStatusNotifier', () => {
  let attachmentsDb: AttachmentsDb;
  let wsListenersNotifier: WsListenersNotifier;
  let notifier: AttachmentsStatusNotifier;
  const connection = {} as ConnectionWrapper<unknown>;

  const baseAttachment: AttachmentEntity = {
    id: 'att-1',
    owner_profile_id: 'profile-1',
    original_file_name: 'doc.pdf',
    kind: AttachmentKind.PDF,
    declared_mime: 'application/pdf',
    detected_mime: null,
    status: AttachmentStatus.PROCESSING,
    original_bucket: 'bucket',
    original_key: 'key',
    size_bytes: null,
    sha256: null,
    guardduty_status: null,
    verdict: null,
    ipfs_cid: null,
    ipfs_url: null,
    error_reason: null,
    created_at: 1,
    updated_at: 1
  };

  beforeEach(() => {
    attachmentsDb = mock();
    wsListenersNotifier = mock();
    notifier = new AttachmentsStatusNotifier(
      attachmentsDb,
      wsListenersNotifier
    );

    (
      attachmentsDb.executeNativeQueriesInTransaction as jest.Mock
    ).mockImplementation(
      async (
        callback: (connection: ConnectionWrapper<unknown>) => Promise<unknown>
      ) => callback(connection)
    );

    (attachmentsDb.findAttachmentWaveIds as jest.Mock).mockResolvedValue([
      'wave-1',
      'wave-2'
    ]);
    (
      wsListenersNotifier.notifyAboutAttachmentStatusUpdate as jest.Mock
    ).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('broadcasts the mapped api attachment with owner and wave ids', async () => {
    await notifier.notifyStatusTransition(baseAttachment);

    expect(attachmentsDb.findAttachmentWaveIds).toHaveBeenCalledWith(
      baseAttachment.id,
      connection
    );
    expect(
      wsListenersNotifier.notifyAboutAttachmentStatusUpdate
    ).toHaveBeenCalledWith(
      {
        attachment: {
          attachment_id: baseAttachment.id,
          file_name: baseAttachment.original_file_name,
          mime_type: baseAttachment.declared_mime,
          kind: ApiAttachmentKind.Pdf,
          status: ApiAttachmentStatus.Processing,
          url: null,
          error_reason: null,
          safety: {
            status: ApiAttachmentSafetyStatus.Pending,
            scanner: null,
            validation: null,
            size_bytes: null,
            sha256: null
          }
        },
        ownerProfileId: baseAttachment.owner_profile_id,
        waveIds: ['wave-1', 'wave-2']
      },
      {}
    );
  });

  it('does not broadcast a competing full drop update', async () => {
    await notifier.notifyStatusTransition(baseAttachment);

    expect(wsListenersNotifier.notifyAboutDropUpdate).not.toHaveBeenCalled();
  });

  it('reuses a caller connection without opening another transaction', async () => {
    await notifier.notifyStatusTransition(baseAttachment, { connection });

    expect(
      attachmentsDb.executeNativeQueriesInTransaction
    ).not.toHaveBeenCalled();
    expect(attachmentsDb.findAttachmentWaveIds).toHaveBeenCalledWith(
      baseAttachment.id,
      connection
    );
  });

  it('maps BLOCKED to bad and surfaces error_reason and ipfs_url', async () => {
    (attachmentsDb.findAttachmentWaveIds as jest.Mock).mockResolvedValue([]);
    await notifier.notifyStatusTransition({
      ...baseAttachment,
      status: AttachmentStatus.BLOCKED,
      error_reason: 'PDF contains blocked feature /JS',
      ipfs_url: 'https://ipfs/foo.pdf'
    });

    expect(
      wsListenersNotifier.notifyAboutAttachmentStatusUpdate
    ).toHaveBeenCalledWith(
      {
        attachment: expect.objectContaining({
          status: ApiAttachmentStatus.Bad,
          error_reason: 'PDF contains blocked feature /JS',
          url: 'https://ipfs/foo.pdf',
          safety: expect.objectContaining({
            status: ApiAttachmentSafetyStatus.Blocked,
            scanner: null
          })
        }),
        ownerProfileId: baseAttachment.owner_profile_id,
        waveIds: []
      },
      {}
    );
  });

  it('swallows errors thrown while broadcasting', async () => {
    (
      wsListenersNotifier.notifyAboutAttachmentStatusUpdate as jest.Mock
    ).mockRejectedValue(new Error('boom'));

    await expect(
      notifier.notifyStatusTransition(baseAttachment)
    ).resolves.toBeUndefined();
  });
});
