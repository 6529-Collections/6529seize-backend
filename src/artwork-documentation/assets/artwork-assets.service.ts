import { createHash, randomUUID } from 'node:crypto';
import {
  artworkAssetsDb,
  ArtworkAssetsDb
} from '@/artwork-documentation/assets/artwork-assets.db';
import {
  artworkAssetStorage,
  ArtworkAssetStorage
} from '@/artwork-documentation/assets/artwork-assets.storage';
import { artworkArchiveBucket } from '@/artwork-documentation/assets/artwork-assets.config';
import {
  ARTWORK_UPLOAD_POLICY,
  assetClass,
  assetError,
  canReadAsset,
  canReadOriginal,
  expectedPartSize,
  requireAssetWrite,
  validateAssetParts,
  validateStartUpload
} from '@/artwork-documentation/assets/artwork-assets.policy';
import {
  AssetAccess,
  AssetConnection,
  AssetPart,
  AssetVisibility,
  ArtworkAssetRole,
  ArtworkAssetManifest,
  CompletedAssetPart,
  StartArtworkUpload,
  StoredAsset
} from '@/artwork-documentation/assets/artwork-assets.types';

type PartState = {
  checksums: Record<string, string>;
  completion_hash?: string;
};
function partState(asset: StoredAsset): PartState {
  return JSON.parse(asset.parts_json) as PartState;
}
function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function manifest(
  asset: StoredAsset,
  includeDigest = true
): ArtworkAssetManifest {
  return {
    id: asset.id,
    filename: asset.filename,
    state: asset.state,
    role: asset.role,
    access_class: asset.access_class,
    intended_visibility: asset.intended_visibility,
    size_bytes: Number(asset.size_bytes),
    sha256: includeDigest ? asset.sha256 : null,
    detected_mime: asset.detected_mime,
    inspection_status: asset.inspection_status,
    width: asset.width,
    height: asset.height,
    has_preview: Boolean(asset.preview_key),
    failure_code: asset.failure_code,
    expires_at: asset.referenced ? null : Number(asset.expires_at)
  };
}
function requireTransferAccess(asset: StoredAsset, access: AssetAccess): void {
  if (!canReadAsset(asset, access)) assetError(404, 'ASSET_NOT_FOUND');
  if (
    asset.uploader_profile_id !== access.actorProfileId &&
    !canReadOriginal(asset, access)
  )
    assetError(403, 'UPLOAD_ACCESS_FORBIDDEN');
}
function requireUploading(asset: StoredAsset): void {
  if (asset.state !== 'uploading' || Number(asset.expires_at) <= Date.now())
    assetError(409, 'UPLOAD_NOT_ACTIVE');
}
function validateCompletionParts(
  asset: StoredAsset,
  parts: CompletedAssetPart[]
): string {
  validateAssetParts(parts, Number(asset.size_bytes), true);
  const state = partState(asset);
  for (const part of parts) {
    if (
      state.checksums[part.part_number] !== part.checksum_sha256 ||
      typeof part.etag !== 'string' ||
      part.etag.length > 150
    )
      assetError(409, 'UPLOAD_PART_MISMATCH');
  }
  const hash = hashJson(
    parts.map((p) => [p.part_number, p.etag, p.checksum_sha256])
  );
  if (state.completion_hash && state.completion_hash !== hash)
    assetError(409, 'IDEMPOTENCY_MISMATCH');
  return hash;
}

/** Authorization is deliberately supplied by the core service, never by request JSON. */
export class ArtworkAssetsService {
  constructor(
    private readonly db: ArtworkAssetsDb,
    private readonly storage: ArtworkAssetStorage
  ) {}

  async startUpload(
    contextId: string,
    access: AssetAccess,
    input: StartArtworkUpload,
    idempotencyKey: string
  ) {
    requireAssetWrite(access, input.role);
    const extension = validateStartUpload(input);
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        idempotencyKey
      )
    )
      assetError(422, 'INVALID_IDEMPOTENCY_KEY');
    const now = Date.now();
    const id = randomUUID();
    const row: StoredAsset = {
      id,
      context_id: contextId,
      uploader_profile_id: access.actorProfileId,
      request_key: idempotencyKey,
      request_hash: hashJson([
        input.filename,
        input.size_bytes,
        input.declared_mime,
        input.role,
        input.intended_visibility
      ]),
      ...input,
      extension,
      access_class: assetClass(input.role),
      state: 'created',
      reserved_bytes: input.size_bytes,
      bucket: artworkArchiveBucket(),
      object_key: `originals/${id}`,
      object_version: null,
      multipart_id: null,
      parts_json: JSON.stringify({ checksums: {} }),
      sha256: null,
      detected_mime: null,
      inspection_status: 'pending',
      scan_status: null,
      preview_key: null,
      width: null,
      height: null,
      failure_code: null,
      referenced: 0,
      created_at: now,
      updated_at: now,
      expires_at: now + ARTWORK_UPLOAD_POLICY.upload_lifetime_ms,
      next_attempt_at: 0,
      lease_until: 0,
      attempts: 0
    };
    const reserved = await this.db.reserve(row);
    await this.db.withLocked(
      reserved.id,
      contextId,
      async (asset, connection) => {
        requireTransferAccess(asset, access);
        if (asset.state !== 'created') return;
        if (Number(asset.expires_at) <= Date.now())
          assetError(409, 'UPLOAD_NOT_ACTIVE');
        const multipartId = await this.storage.create(asset);
        await this.db.update(
          asset.id,
          {
            multipart_id: multipartId,
            state: 'uploading',
            updated_at: Date.now()
          },
          connection
        );
      }
    );
    return this.getUpload(contextId, reserved.id, access);
  }

  async getUpload(contextId: string, uploadId: string, access: AssetAccess) {
    const asset = await this.getAsset(contextId, uploadId, access);
    requireTransferAccess(asset, access);
    const parts =
      asset.state === 'uploading' ? await this.storage.parts(asset) : [];
    return {
      asset: manifest(asset),
      upload_id: asset.id,
      policy: ARTWORK_UPLOAD_POLICY,
      received_parts: parts,
      expires_at: Number(asset.expires_at)
    };
  }

  async signParts(
    contextId: string,
    uploadId: string,
    access: AssetAccess,
    input: { parts: AssetPart[] }
  ) {
    requireAssetWrite(access);
    return this.db.withLocked(
      uploadId,
      contextId,
      async (asset, connection) => {
        requireTransferAccess(asset, access);
        requireUploading(asset);
        validateAssetParts(input.parts, Number(asset.size_bytes));
        const state = partState(asset);
        for (const part of input.parts) {
          const prior = state.checksums[part.part_number];
          if (prior && prior !== part.checksum_sha256)
            assetError(409, 'UPLOAD_FILE_CHANGED');
          state.checksums[part.part_number] = part.checksum_sha256;
        }
        await this.db.update(
          asset.id,
          { parts_json: JSON.stringify(state), updated_at: Date.now() },
          connection
        );
        const parts = await Promise.all(
          input.parts.map(async (part) => ({
            ...part,
            url: await this.storage.signPart(asset, part),
            size_bytes: expectedPartSize(
              part.part_number,
              Number(asset.size_bytes)
            ),
            headers: { 'x-amz-checksum-sha256': part.checksum_sha256 },
            expires_at:
              Date.now() + ARTWORK_UPLOAD_POLICY.part_url_seconds * 1000
          }))
        );
        return { upload_id: asset.id, parts };
      }
    );
  }

  async completeUpload(
    contextId: string,
    uploadId: string,
    access: AssetAccess,
    input: { parts: CompletedAssetPart[] }
  ) {
    requireAssetWrite(access);
    return this.db.withLocked(
      uploadId,
      contextId,
      async (asset, connection) => {
        requireTransferAccess(asset, access);
        const completionHash = validateCompletionParts(asset, input.parts);
        if (asset.state === 'processing' || asset.state === 'ready')
          return { asset: manifest(asset) };
        requireUploading(asset);
        const existing = await this.storage.head(asset);
        if (!existing) await this.verifyReceivedParts(asset, input.parts);
        const completed =
          existing ?? (await this.storage.complete(asset, input.parts));
        if (
          completed.size !== Number(asset.size_bytes) ||
          completed.size > ARTWORK_UPLOAD_POLICY.max_asset_bytes
        )
          assetError(422, 'UPLOAD_SIZE_MISMATCH');
        const now = Date.now();
        const patch: Partial<StoredAsset> = {
          state: 'processing',
          object_version: completed.version,
          parts_json: JSON.stringify({
            ...partState(asset),
            completion_hash: completionHash
          }),
          updated_at: now,
          next_attempt_at: now,
          expires_at: now + ARTWORK_UPLOAD_POLICY.orphan_lifetime_ms
        };
        await this.db.update(asset.id, patch, connection);
        return { asset: manifest({ ...asset, ...patch }) };
      }
    );
  }

  private async verifyReceivedParts(
    asset: StoredAsset,
    expected: CompletedAssetPart[]
  ): Promise<void> {
    const received = await this.storage.parts(asset);
    if (received.length !== expected.length)
      assetError(409, 'UPLOAD_PARTS_MISSING');
    for (let index = 0; index < expected.length; index++) {
      const part = expected[index];
      const actual = received[index];
      if (
        actual.part_number !== part.part_number ||
        actual.etag !== part.etag ||
        actual.checksum_sha256 !== part.checksum_sha256 ||
        actual.size_bytes !==
          expectedPartSize(part.part_number, Number(asset.size_bytes))
      )
        assetError(409, 'UPLOAD_PART_MISMATCH');
    }
  }

  async cancelUpload(
    contextId: string,
    uploadId: string,
    access: AssetAccess
  ): Promise<void> {
    requireAssetWrite(access);
    await this.db.withLocked(uploadId, contextId, async (asset, connection) => {
      requireTransferAccess(asset, access);
      if (asset.state === 'cancelled' || asset.state === 'expired') return;
      if (
        !['created', 'uploading', 'failed', 'quarantined'].includes(
          asset.state
        ) ||
        asset.referenced
      )
        assetError(409, 'ASSET_CANNOT_CANCEL');
      await this.storage.cancel(asset);
      await this.db.update(
        asset.id,
        { state: 'cancelled', reserved_bytes: 0, updated_at: Date.now() },
        connection
      );
    });
  }

  async listAssets(
    contextId: string,
    access: AssetAccess
  ): Promise<ArtworkAssetManifest[]> {
    return (await this.db.list(contextId))
      .filter((asset) => canReadAsset(asset, access))
      .map((asset) => manifest(asset, canReadOriginal(asset, access)));
  }

  async validateReadyAsset(
    contextId: string,
    assetId: string,
    access: AssetAccess,
    connection?: AssetConnection
  ): Promise<ArtworkAssetManifest> {
    const asset = await this.getAsset(
      contextId,
      assetId,
      access,
      connection,
      Boolean(connection)
    );
    if (
      asset.state !== 'ready' ||
      !asset.sha256 ||
      asset.inspection_status === 'failed' ||
      asset.scan_status !== 'NO_THREATS_FOUND'
    )
      assetError(409, 'ASSET_NOT_READY');
    if (!asset.referenced && Number(asset.expires_at) <= Date.now())
      assetError(409, 'ASSET_EXPIRED');
    return manifest(asset);
  }

  async markReferenced(
    contextId: string,
    assetIds: string[],
    connection: AssetConnection
  ): Promise<void> {
    return this.db.markReferenced(contextId, assetIds, connection);
  }

  async updateDisclosure(
    contextId: string,
    assetId: string,
    access: AssetAccess,
    input: { intended_visibility: AssetVisibility; role?: ArtworkAssetRole },
    connection: AssetConnection
  ): Promise<void> {
    requireAssetWrite(access, input.role);
    const asset = await this.getAsset(
      contextId,
      assetId,
      access,
      connection,
      true
    );
    const role = input.role ?? asset.role;
    validateStartUpload({
      filename: asset.filename,
      size_bytes: Number(asset.size_bytes),
      declared_mime: asset.declared_mime,
      role,
      intended_visibility: input.intended_visibility
    });
    const nextClass = assetClass(role);
    if (
      asset.access_class === 'rights_evidence' &&
      (nextClass !== 'rights_evidence' ||
        input.intended_visibility !== 'restricted')
    )
      assetError(422, 'RIGHTS_EVIDENCE_IS_RESTRICTED');
    if (nextClass === 'rights_evidence' && !access.canReadRightsEvidence)
      assetError(403, 'RIGHTS_EVIDENCE_FORBIDDEN');
    await this.db.update(
      asset.id,
      {
        intended_visibility: input.intended_visibility,
        access_class: nextClass,
        updated_at: Date.now()
      },
      connection
    );
  }

  async download(
    contextId: string,
    assetId: string,
    access: AssetAccess,
    input: { variant: 'original' | 'preview' }
  ) {
    const asset = await this.getAsset(contextId, assetId, access);
    if (!['original', 'preview'].includes(input.variant))
      assetError(422, 'INVALID_DOWNLOAD_VARIANT');
    const preview = input.variant === 'preview';
    if (
      asset.state !== 'ready' ||
      (!asset.referenced && Number(asset.expires_at) <= Date.now())
    )
      assetError(409, 'ASSET_NOT_READY');
    if (!preview && !canReadOriginal(asset, access))
      assetError(403, 'ARCHIVAL_DOWNLOAD_FORBIDDEN');
    if (preview && !asset.preview_key) assetError(404, 'PREVIEW_UNAVAILABLE');
    return {
      url: await this.storage.download(asset, preview),
      expires_at: Date.now() + ARTWORK_UPLOAD_POLICY.download_url_seconds * 1000
    };
  }

  private async getAsset(
    contextId: string,
    id: string,
    access: AssetAccess,
    connection?: AssetConnection,
    lock = false
  ): Promise<StoredAsset> {
    const asset = await this.db.find(id, contextId, connection, lock);
    if (!asset || !canReadAsset(asset, access))
      assetError(404, 'ASSET_NOT_FOUND');
    return asset;
  }
}
export const artworkAssetsService = new ArtworkAssetsService(
  artworkAssetsDb,
  artworkAssetStorage
);
