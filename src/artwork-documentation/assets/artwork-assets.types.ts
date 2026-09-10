import type { ConnectionWrapper } from '@/sql-executor';

export const ARTWORK_ASSETS_TABLE = 'artwork_documentation_assets';
export const ARTWORK_ASSET_QUOTAS_TABLE = 'artwork_documentation_asset_quotas';

export const ARTWORK_ASSET_ROLES = [
  'artwork_final',
  'preservation_master',
  'camera_original',
  'working_file',
  'process_evidence',
  'display_derivative',
  'consent_instrument',
  'rights_instrument',
  'interview_recording',
  'interview_transcript',
  'other_supporting'
] as const;
export type ArtworkAssetRole = (typeof ARTWORK_ASSET_ROLES)[number];
export type AssetState =
  | 'created'
  | 'uploading'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'quarantined'
  | 'cancelled'
  | 'expired';
export type AssetVisibility = 'public_record' | 'restricted';
export type AssetClass = 'artwork' | 'rights_evidence';
export type AssetConnection = ConnectionWrapper<unknown>;

/** Derived by the context service after current actor authorization on EVERY call. */
export interface AssetAccess {
  actorProfileId: string;
  canEdit: boolean;
  canReadArchivalFiles: boolean;
  canReadRightsEvidence: boolean;
  canReadRestricted: boolean;
}

export interface StartArtworkUpload {
  filename: string;
  size_bytes: number;
  declared_mime: string;
  role: ArtworkAssetRole;
  intended_visibility: AssetVisibility;
}
export interface AssetPart {
  part_number: number;
  checksum_sha256: string;
}
export interface CompletedAssetPart extends AssetPart {
  etag: string;
}
export interface ReceivedAssetPart extends CompletedAssetPart {
  size_bytes: number;
}
export interface StoredAsset {
  id: string;
  context_id: string;
  uploader_profile_id: string;
  request_key: string;
  request_hash: string;
  filename: string;
  declared_mime: string;
  extension: string;
  role: ArtworkAssetRole;
  access_class: AssetClass;
  intended_visibility: AssetVisibility;
  state: AssetState;
  size_bytes: number;
  reserved_bytes: number;
  bucket: string;
  object_key: string;
  object_version: string | null;
  multipart_id: string | null;
  parts_json: string;
  sha256: string | null;
  detected_mime: string | null;
  inspection_status: 'pending' | 'verified' | 'unsupported' | 'failed';
  scan_status: string | null;
  preview_key: string | null;
  width: number | null;
  height: number | null;
  failure_code: string | null;
  referenced: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
  next_attempt_at: number;
  lease_until: number;
  attempts: number;
}
export interface ArtworkAssetManifest {
  id: string;
  filename: string;
  state: AssetState;
  role: ArtworkAssetRole;
  access_class: AssetClass;
  intended_visibility: AssetVisibility;
  size_bytes: number;
  sha256: string | null;
  detected_mime: string | null;
  inspection_status: StoredAsset['inspection_status'];
  width: number | null;
  height: number | null;
  has_preview: boolean;
  failure_code: string | null;
  expires_at: number | null;
}
