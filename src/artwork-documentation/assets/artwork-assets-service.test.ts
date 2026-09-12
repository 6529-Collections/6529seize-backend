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
import { characterizeAssetHeader } from './artwork-assets.characterization';

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
    listSummaries: jest.fn(async () => [asset])
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
    downloadValidationReport: jest.fn(
      async () => 'https://private.example/report'
    ),
    cancel: jest.fn(async () => undefined)
  };
  const service = new ArtworkAssetsService(
    db as unknown as ArtworkAssetsDb,
    storage as unknown as ArtworkAssetStorage
  );
  return { asset, db, storage, service };
}

describe('archive upload and access service', () => {
  it('keeps a thousand Unicode file list entries bounded and loads technical metadata separately', async () => {
    const full = characterizeAssetHeader(
      Buffer.alloc(0),
      'mp4',
      9,
      'a'.repeat(64)
    );
    full.warnings = ['x'.repeat(100000)];
    const { service, db, asset } = setup({
      filename: `${'測'.repeat(250)}.png`,
      technical_metadata_json: JSON.stringify(full),
      state: 'ready',
      scan_status: 'NO_THREATS_FOUND',
      sha256: 'a'.repeat(64)
    });
    db.listSummaries.mockResolvedValue(
      Array.from({ length: 1000 }, (_, index) => ({
        ...asset,
        id: `asset-${index}`
      }))
    );
    const list = await service.listAssets('context-1', artistAssetAccess);
    expect(list).toHaveLength(1000);
    expect(list.every((item) => item.technical_metadata === null)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(list))).toBeLessThan(
      1.4 * 1024 ** 2
    );
    expect(
      (await service.getUpload('context-1', asset.id, artistAssetAccess)).asset
        .technical_metadata
    ).toMatchObject({
      original_sha256: 'a'.repeat(64),
      properties: { technical_metadata_summary: true }
    });
  });
  it.each(['consent_instrument', 'rights_instrument'] as const)(
    'retains a v3 public %s without adding a private evidence requirement',
    async (role) => {
      const { service, asset, db } = setup({
        role,
        state: 'ready',
        sha256: 'a'.repeat(64),
        scan_status: 'NO_THREATS_FOUND'
      });
      const access = {
        ...artistAssetAccess,
        publicationOnly: true,
        publicationOnlyV3: true,
        canReadRightsEvidence: false
      };
      await service.updateDisclosure(
        'context-1',
        asset.id,
        access,
        { role, intended_visibility: 'public_record' },
        { connection: {} }
      );
      expect(asset.access_class).toBe('artwork');
      expect(
        (await service.validateReadyAsset('context-1', asset.id, access))
          .intended_visibility
      ).toBe('public_record');
      expect(db.update).toHaveBeenCalled();
    }
  );
  it('does not relabel previously restricted legacy evidence into a public v3 instrument', async () => {
    const { service, asset, db } = setup({
      role: 'consent_instrument',
      access_class: 'rights_evidence',
      intended_visibility: 'restricted',
      state: 'ready',
      sha256: 'a'.repeat(64),
      scan_status: 'NO_THREATS_FOUND'
    });
    await expect(
      service.updateDisclosure(
        'context-1',
        asset.id,
        {
          ...artistAssetAccess,
          publicationOnly: true,
          publicationOnlyV3: true
        },
        { role: 'consent_instrument', intended_visibility: 'public_record' },
        { connection: {} }
      )
    ).rejects.toMatchObject({ code: 'PUBLICATION_VISIBILITY_REQUIRED' });
    expect(db.update).not.toHaveBeenCalled();
    expect(asset.access_class).toBe('rights_evidence');
  });
  it('resumes a 512-part 8GiB upload across a lost response and rejects changed resumed bytes', async () => {
    const size = 8 * 1024 ** 3;
    const partSize = 16 * 1024 ** 2;
    const chunk = Buffer.alloc(partSize, 71);
    const partChecksum = createHash('sha256').update(chunk).digest('base64');
    const { service, asset, storage, db } = setup({
      size_bytes: size,
      reserved_bytes: size
    });
    const parts = Array.from({ length: 512 }, (_, index) => ({
      part_number: index + 1,
      checksum_sha256: partChecksum,
      etag: `etag-${index + 1}`
    }));
    for (let offset = 0; offset < parts.length; offset += 3)
      await service.signParts('context-1', asset.id, artistAssetAccess, {
        parts: parts.slice(offset, offset + 3)
      });
    storage.parts.mockResolvedValue(
      parts.slice(0, 257).map((part) => ({ ...part, size_bytes: partSize }))
    );
    const resumed = new ArtworkAssetsService(
      db as unknown as ArtworkAssetsDb,
      storage as unknown as ArtworkAssetStorage
    );
    expect(
      (await resumed.getUpload('context-1', asset.id, artistAssetAccess))
        .received_parts
    ).toHaveLength(257);
    await expect(
      resumed.signParts('context-1', asset.id, artistAssetAccess, {
        parts: [{ ...parts[257], checksum_sha256: checksum }]
      })
    ).rejects.toMatchObject({ code: 'UPLOAD_FILE_CHANGED' });
    const signed = await resumed.signParts(
      'context-1',
      asset.id,
      artistAssetAccess,
      { parts: parts.slice(-1) }
    );
    expect(signed.parts[0].size_bytes).toBe(partSize);
    storage.parts.mockResolvedValue(
      parts.map((part) => ({ ...part, size_bytes: partSize }))
    );
    storage.complete.mockResolvedValue({
      size,
      version: 'large-immutable-version'
    });
    await resumed.completeUpload('context-1', asset.id, artistAssetAccess, {
      parts
    });
    await resumed.completeUpload('context-1', asset.id, artistAssetAccess, {
      parts
    });
    expect(storage.complete).toHaveBeenCalledTimes(1);
    expect(asset.state).toBe('processing');
    expect(asset.object_version).toBe('large-immutable-version');
    expect(JSON.parse(asset.parts_json).checksums['512']).toBe(partChecksum);
  });
  it('offers passive media playback only with a clean scan and original-byte authorization', async () => {
    const { service, asset, storage } = setup({
      state: 'ready',
      detected_mime: 'video/mp4',
      scan_status: 'NO_THREATS_FOUND'
    });
    await service.download('context-1', asset.id, artistAssetAccess, {
      variant: 'media'
    });
    expect(storage.download).toHaveBeenCalledWith(asset, false, true);
    await expect(
      service.download(
        'context-1',
        asset.id,
        { ...artistAssetAccess, canReadArchivalFiles: false },
        { variant: 'media' }
      )
    ).rejects.toThrow('archival_download_forbidden');
    asset.scan_status = 'UNSUPPORTED';
    await expect(
      service.download('context-1', asset.id, artistAssetAccess, {
        variant: 'media'
      })
    ).rejects.toThrow('asset_not_ready');
  });
  it('never exposes HTML or SVG as an inline media preview', async () => {
    const { service, asset } = setup({
      state: 'ready',
      detected_mime: 'text/html',
      scan_status: 'NO_THREATS_FOUND'
    });
    await expect(
      service.download('context-1', asset.id, artistAssetAccess, {
        variant: 'media'
      })
    ).rejects.toThrow('media_preview_unavailable');
  });
  it('protects raw credential reports with the same archival permission as their source', async () => {
    const { service, asset, storage } = setup({
      state: 'ready',
      scan_status: 'NO_THREATS_FOUND',
      validation_report_key: 'validation-reports/test'
    });
    await service.download('context-1', asset.id, artistAssetAccess, {
      variant: 'c2pa_report'
    });
    expect(storage.downloadValidationReport).toHaveBeenCalledWith(asset);
    await expect(
      service.download(
        'context-1',
        asset.id,
        { ...artistAssetAccess, canReadArchivalFiles: false },
        { variant: 'c2pa_report' }
      )
    ).rejects.toThrow('archival_download_forbidden');
  });
  it('keeps upload metadata readable without borrowing viewer flags for mutation', async () => {
    const { service, asset, storage, db } = setup({
      intended_visibility: 'restricted'
    });
    const readAccess = { ...artistAssetAccess, actorProfileId: 'viewer' };
    const originalAccess = {
      ...readAccess,
      canReadArchivalFiles: false,
      canReadRightsEvidence: false,
      canReadRestricted: false
    };
    for (const canEdit of [false, true]) {
      const session = await service.getUpload(
        'context-1',
        asset.id,
        readAccess,
        {
          ...originalAccess,
          canEdit
        }
      );
      expect(session.asset.id).toBe(asset.id);
      expect(session.received_parts).toHaveLength(1);
      expect(session.can_mutate).toBe(false);
    }
    expect(storage.parts).toHaveBeenCalledTimes(2);
    expect(db.update).not.toHaveBeenCalled();
  });
  it.each(['uploading', 'ready'] as const)(
    'preserves an original uploader recovering their own %s unreferenced file',
    async (state) => {
      const { service, asset } = setup({
        state,
        intended_visibility: 'restricted'
      });
      const access = {
        ...artistAssetAccess,
        canReadArchivalFiles: false,
        canReadRightsEvidence: false,
        canReadRestricted: false
      };
      expect(
        (await service.getUpload('context-1', asset.id, access)).can_mutate
      ).toBe(true);
    }
  );
  it.each([
    { referenced: 1 },
    { state: 'cancelled' as const },
    { state: 'expired' as const },
    { expires_at: 1 }
  ])(
    'does not advertise mutation of an unavailable upload %j',
    async (patch) => {
      const { service, asset } = setup(patch);
      expect(
        (await service.getUpload('context-1', asset.id, artistAssetAccess))
          .can_mutate
      ).toBe(false);
    }
  );
  it('keeps missing and foreign-context upload sessions unavailable', async () => {
    const { service, asset, storage } = setup();
    await expect(
      service.getUpload('different-context', asset.id, artistAssetAccess)
    ).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' });
    expect(storage.parts).not.toHaveBeenCalled();
  });
  it('rejects excluded publication uploads before reserving storage', async () => {
    const { service, db, storage } = setup();
    await expect(
      service.startUpload(
        'context-1',
        { ...artistAssetAccess, publicationOnly: true },
        {
          filename: 'working.png',
          size_bytes: 9,
          declared_mime: 'image/png',
          role: 'working_file',
          intended_visibility: 'public_record'
        },
        '22222222-2222-4222-8222-222222222222'
      )
    ).rejects.toMatchObject({ code: 'PUBLICATION_ASSET_ROLE_REQUIRED' });
    expect(db.withLocked).not.toHaveBeenCalled();
    expect(storage.signPart).not.toHaveBeenCalled();
  });
  it('rejects restricted upload retries without reading or completing S3 parts', async () => {
    const { service, storage, asset } = setup({
      intended_visibility: 'restricted'
    });
    const access = { ...artistAssetAccess, publicationOnly: true };
    await expect(
      service.getUpload('context-1', asset.id, access)
    ).rejects.toMatchObject({ code: 'PUBLICATION_VISIBILITY_REQUIRED' });
    await expect(
      service.signParts('context-1', asset.id, access, {
        parts: [{ part_number: 1, checksum_sha256: checksum }]
      })
    ).rejects.toMatchObject({ code: 'PUBLICATION_VISIBILITY_REQUIRED' });
    await expect(
      service.completeUpload('context-1', asset.id, access, {
        parts: [{ part_number: 1, checksum_sha256: checksum, etag: 'etag' }]
      })
    ).rejects.toMatchObject({ code: 'PUBLICATION_VISIBILITY_REQUIRED' });
    expect(storage.parts).not.toHaveBeenCalled();
    expect(storage.signPart).not.toHaveBeenCalled();
    expect(storage.complete).not.toHaveBeenCalled();
    await service.cancelUpload('context-1', asset.id, access);
    expect(storage.cancel).toHaveBeenCalledTimes(1);
  });
  it('cannot attach a private source by relabeling or demote a public file', async () => {
    const { service, db, asset } = setup({
      role: 'working_file',
      state: 'ready',
      sha256: 'a'.repeat(64),
      scan_status: 'NO_THREATS_FOUND'
    });
    const access = { ...artistAssetAccess, publicationOnly: true };
    await expect(
      service.validateReadyAsset('context-1', asset.id, access)
    ).rejects.toMatchObject({ code: 'PUBLICATION_ASSET_ROLE_REQUIRED' });
    await expect(
      service.updateDisclosure(
        'context-1',
        asset.id,
        access,
        { role: 'artwork_final', intended_visibility: 'public_record' },
        { connection: {} }
      )
    ).rejects.toMatchObject({ code: 'PUBLICATION_ASSET_ROLE_REQUIRED' });
    asset.role = 'artwork_final';
    await expect(
      service.updateDisclosure(
        'context-1',
        asset.id,
        access,
        { intended_visibility: 'restricted' },
        { connection: {} }
      )
    ).rejects.toMatchObject({ code: 'PUBLICATION_VISIBILITY_REQUIRED' });
    expect(db.update).not.toHaveBeenCalled();
  });
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
