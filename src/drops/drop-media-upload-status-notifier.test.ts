import { DropMediaUploadStatusNotifier } from '@/drops/drop-media-upload-status-notifier';
import type { DropMediaUploadsDb } from '@/drops/drop-media-uploads.db';
import type { DropsApiService } from '@/api/drops/drops.api.service';
import type { WsListenersNotifier } from '@/api/ws/ws-listeners-notifier';
import type { ApiDrop } from '@/api/generated/models/ApiDrop';
import { Logger } from '@/logging';

jest.mock('@/api/api-helpers', () => ({
  giveReadReplicaTimeToCatchUp: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('@/api/drops/drops.api.service', () => ({ dropsService: undefined }));
jest.mock('@/api/ws/ws-listeners-notifier', () => ({
  wsListenersNotifier: {}
}));
jest.mock('@/drops/drop-media-uploads.db', () => ({ dropMediaUploadsDb: {} }));

const CREATED_AT = 1794293960499;

function snapshot(
  serial: number | string,
  createdAt: number | string,
  updatedAt: number | string | null
): ApiDrop {
  return {
    id: 'image-drop',
    serial_no: serial,
    created_at: createdAt,
    updated_at: updatedAt,
    parts: [
      {
        part_id: 1,
        content: 'Image caption',
        media: [
          {
            url: 'https://example.com/image.png',
            mime_type: 'image/png',
            media_status: 'ready'
          }
        ]
      }
    ]
  } as unknown as ApiDrop;
}

describe('DropMediaUploadStatusNotifier numeric wire fields', () => {
  const findDropIds = jest.fn();
  const findDrop = jest.fn();
  const broadcast = jest.fn();
  let error: jest.SpyInstance;
  const notifier = new DropMediaUploadStatusNotifier(
    { findDropIdsByUploadId: findDropIds } as unknown as DropMediaUploadsDb,
    { notifyAboutDropUpdate: broadcast } as unknown as WsListenersNotifier,
    { findDropByIdOrThrow: findDrop } as unknown as DropsApiService
  );

  beforeEach(() => {
    jest.clearAllMocks();
    findDropIds.mockResolvedValue(['image-drop']);
    broadcast.mockResolvedValue(undefined);
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    snapshot('85038', String(CREATED_AT), String(CREATED_AT + 10)),
    snapshot(85038, CREATED_AT, CREATED_AT + 10),
    snapshot('85038', String(CREATED_AT), null)
  ])(
    'broadcasts numeric serials and millisecond timestamps without changing media',
    async (drop) => {
      findDrop.mockResolvedValue(drop);
      await notifier.notifyStatusTransition('upload-1');
      expect(broadcast).toHaveBeenCalledWith(
        expect.objectContaining({
          serial_no: 85038,
          created_at: CREATED_AT,
          updated_at: drop.updated_at === null ? null : CREATED_AT + 10,
          parts: drop.parts
        }),
        {},
        { reason: 'MEDIA_STATUS', useSystemBroadcastAudience: true }
      );
      expect(error).not.toHaveBeenCalled();
    }
  );

  it('preserves the service snapshot rather than mutating its numeric strings', async () => {
    const drop = Object.freeze(snapshot('85038', String(CREATED_AT), null));
    findDrop.mockResolvedValue(drop);
    await notifier.notifyStatusTransition('upload-1');
    expect(drop.created_at).toBe(String(CREATED_AT));
    expect(drop.serial_no).toBe('85038');
  });

  it.each([
    snapshot('not-a-serial', String(CREATED_AT), null),
    snapshot('85038', 'not-a-timestamp', null)
  ])(
    'does not publish invalid order fields and keeps notification failures best effort',
    async (drop) => {
      findDrop.mockResolvedValue(drop);
      await expect(
        notifier.notifyStatusTransition('upload-1')
      ).resolves.toBeUndefined();
      expect(broadcast).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalled();
    }
  );

  it('does not fetch or broadcast when an upload has no linked drops', async () => {
    findDropIds.mockResolvedValue([]);
    await notifier.notifyStatusTransition('upload-1');
    expect(findDrop).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});
