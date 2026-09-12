import { randomUUID } from 'node:crypto';
import {
  AssetAccess,
  StoredAsset
} from '@/artwork-documentation/assets/artwork-assets.types';

export const artistAssetAccess: AssetAccess = {
  actorProfileId: 'artist-1',
  canEdit: true,
  canReadArchivalFiles: true,
  canReadRightsEvidence: true,
  canReadRestricted: true
};
export function anArtworkAsset(patch: Partial<StoredAsset> = {}): StoredAsset {
  const id = randomUUID();
  const now = Date.now();
  return {
    id,
    context_id: 'context-1',
    uploader_profile_id: artistAssetAccess.actorProfileId,
    request_key: randomUUID(),
    request_hash: 'a'.repeat(64),
    filename: 'work.png',
    declared_mime: 'image/png',
    extension: 'png',
    role: 'artwork_final',
    access_class: 'artwork',
    intended_visibility: 'public_record',
    state: 'uploading',
    size_bytes: 9,
    reserved_bytes: 9,
    bucket: 'private-test-archive',
    object_key: `originals/${id}`,
    object_version: null,
    multipart_id: 'multipart-id',
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
    expires_at: now + 86400000,
    next_attempt_at: 0,
    lease_until: 0,
    attempts: 0,
    ...patch
  };
}
