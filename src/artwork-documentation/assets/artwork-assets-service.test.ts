import { createHash } from 'node:crypto';
import { ArtworkAssetsDb } from '@/artwork-documentation/assets/artwork-assets.db';
import { ArtworkAssetsService } from '@/artwork-documentation/assets/artwork-assets.service';
import { ArtworkAssetStorage } from '@/artwork-documentation/assets/artwork-assets.storage';
import {
  anArtworkAsset,
  artistAssetAccess
} from '@/artwork-documentation/assets/artwork-assets.test-support';
import {
  AssetConnection,
  StoredAsset
} from '@/artwork-documentation/assets/artwork-assets.types';

const checksum = createHash('sha256').update('original').digest('base64');
function setup(patch: Partial<StoredAsset> = {}) {
  const asset = anArtworkAsset(patch);
  const db = {
    find: jest.fn(async (_id: string, contextId: string) =>
      contextId === asset.context_id ? asset : null
    ),
    withLocked: jest.fn(
      async (
        _id: string,
        _contextId: string,
        fn: (row: StoredAsset, connection: AssetConnection) => Promise<unknown>
      ) => fn(asset, { connection: {} })
    ),
    update: jest.fn(async (_id: string, value: Partial<StoredAsset>) =>
      Object.assign(asset, value)
    ),
    list: jest.fn(async () => [asset])
  };
  const storage = {
    signPart: jest.fn(async () => 'https://private.example/part'),
    parts: jest.fn(async () => [
      { part_number: 1, checksum_sha256: checksum, etag: 'etag', size_bytes: 9 }
    ]),
    head: jest.fn(
      async (): Promise<{ size: number; version: string } | null> => null
    ),
    complete: jest.fn(async () => ({ size: 9, version: 'version-1' })),
    download: jest.fn(async () => 'https://private.example/download'),
    cancel: jest.fn(async () => undefined)
  };
  const service = new ArtworkAssetsService(
    db as unknown as ArtworkAssetsDb,
    storage as unknown as ArtworkAssetStorage
  );
  return { asset, db, storage, service };
}

describe('archive upload and access service', () => {
  it('does not reuse already issued part numbers for changed bytes', async () => {
    const { service, storage } = setup();
    await service.signParts('context-1', 'asset', artistAssetAccess, {
      parts: [{ part_number: 1, checksum_sha256: checksum }]
    });
    const changed = createHash('sha256').update('changed').digest('base64');
    await expect(
      service.signParts('context-1', 'asset', artistAssetAccess, {
        parts: [{ part_number: 1, checksum_sha256: changed }]
      })
    ).rejects.toMatchObject({ code: 'UPLOAD_FILE_CHANGED' });
    expect(storage.signPart).toHaveBeenCalledTimes(1);
  });
  it('checks S3 byte count and checksum including the short final part', async () => {
    const { service, storage } = setup({
      parts_json: JSON.stringify({ checksums: { 1: checksum } })
    });
    storage.parts.mockResolvedValue([
      { part_number: 1, checksum_sha256: checksum, etag: 'etag', size_bytes: 8 }
    ]);
    await expect(
      service.completeUpload('context-1', 'asset', artistAssetAccess, {
        parts: [{ part_number: 1, checksum_sha256: checksum, etag: 'etag' }]
      })
    ).rejects.toMatchObject({ code: 'UPLOAD_PART_MISMATCH' });
    expect(storage.complete).not.toHaveBeenCalled();
  });
  it('recovers response loss after S3 completion and is idempotent afterward', async () => {
    const { service, storage, asset } = setup({
      parts_json: JSON.stringify({ checksums: { 1: checksum } })
    });
    storage.head.mockResolvedValue({ size: 9, version: 'version-1' });
    const input = {
      parts: [{ part_number: 1, checksum_sha256: checksum, etag: 'etag' }]
    };
    await service.completeUpload(
      'context-1',
      'asset',
      artistAssetAccess,
      input
    );
    expect(asset.state).toBe('processing');
    expect(asset.object_version).toBe('version-1');
    await service.completeUpload(
      'context-1',
      'asset',
      artistAssetAccess,
      input
    );
    expect(storage.complete).not.toHaveBeenCalled();
    await expect(
      service.completeUpload('context-1', 'asset', artistAssetAccess, {
        parts: [{ ...input.parts[0], etag: 'other' }]
      })
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_MISMATCH' });
  });
  it('does not expose rights evidence or issue unauthorized archival links', async () => {
    const { service, storage, asset } = setup({
      state: 'ready',
      scan_status: 'NO_THREATS_FOUND',
      sha256: 'a'.repeat(64),
      access_class: 'rights_evidence',
      intended_visibility: 'restricted'
    });
    const reader = {
      ...artistAssetAccess,
      canReadRightsEvidence: false,
      canReadArchivalFiles: false
    };
    expect(await service.listAssets('context-1', reader)).toEqual([]);
    await expect(
      service.download('context-1', asset.id, reader, { variant: 'original' })
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    asset.access_class = 'artwork';
    asset.intended_visibility = 'public_record';
    await expect(
      service.download('context-1', asset.id, reader, { variant: 'original' })
    ).rejects.toMatchObject({ code: 'ARCHIVAL_DOWNLOAD_FORBIDDEN' });
    expect(storage.download).not.toHaveBeenCalled();
  });
  it('scopes lookup by context and prohibits confirmation before actual malware/fixity checks', async () => {
    const { service, asset } = setup({ state: 'processing' });
    await expect(
      service.validateReadyAsset('context-2', asset.id, artistAssetAccess)
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    await expect(
      service.validateReadyAsset('context-1', asset.id, artistAssetAccess)
    ).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
    asset.state = 'ready';
    asset.sha256 = 'b'.repeat(64);
    await expect(
      service.validateReadyAsset('context-1', asset.id, artistAssetAccess)
    ).rejects.toMatchObject({ code: 'ASSET_NOT_READY' });
  });
  it('cannot cancel a retained original or bypass current revoked edit permission', async () => {
    const { service, storage, asset } = setup({
      referenced: 1,
      state: 'ready'
    });
    await expect(
      service.cancelUpload('context-1', asset.id, artistAssetAccess)
    ).rejects.toMatchObject({ code: 'ASSET_CANNOT_CANCEL' });
    await expect(
      service.signParts(
        'context-1',
        asset.id,
        { ...artistAssetAccess, canEdit: false },
        { parts: [{ part_number: 1, checksum_sha256: checksum }] }
      )
    ).rejects.toMatchObject({ code: 'ASSET_EDIT_FORBIDDEN' });
    expect(storage.cancel).not.toHaveBeenCalled();
  });
});
