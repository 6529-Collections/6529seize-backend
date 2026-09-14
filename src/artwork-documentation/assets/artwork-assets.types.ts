import type { ConnectionWrapper } from '@/sql-executor';
import type { AssetC2paResult } from '@/artwork-documentation/assets/artwork-assets.c2pa';

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
  'print_output',
  'color_profile',
  'preset',
  'source_code',
  'dependency',
  'environment_package',
  'reference_capture',
  'captions',
  'notebook',
  'publication',
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
  publicationOnly?: boolean;
  /** Server-derived v3 publication-only intake; new rights evidence is explicitly public. */
  publicationOnlyV3?: boolean;
  canPublishInterviewRecording?: boolean;
  canPublishInterviewTranscript?: boolean;
  /** Validated active v3 profile selections; never supplied by upload request JSON. */
  mediaProfiles?: readonly string[];
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
  technical_metadata_json?: string | null;
  validation_report_key?: string | null;
}
export interface AssetTechnicalMetadata {
  version: 1;
  characterization: 'partial' | 'complete' | 'unsupported';
  method: string;
  detected_format: string;
  format_registry:
    | { status: 'unidentified'; authority: null; identifier: null }
    | {
        status: 'signature_match';
        authority: 'PRONOM';
        identifier: string;
        source_commit: string;
        source_sha256: string;
        signature_id: number;
        identification_scope: 'selected_pronom_signatures';
      };
  original_sha256: string;
  measured_at: string;
  properties: Record<string, string | number | boolean | null>;
  warnings: string[];
  c2pa: AssetC2paResult;
  archive?: {
    entries: number;
    expanded_bytes: number;
    inventory: { path: string; size_bytes: number; sha256: string }[];
  };
}
/** Fields needed for a file list; large multipart receipts and characterization payloads are loaded by file ID. */
export const ARTWORK_ASSET_LIST_COLUMNS = [
  'id',
  'context_id',
  'uploader_profile_id',
  'filename',
  'state',
  'role',
  'access_class',
  'intended_visibility',
  'size_bytes',
  'sha256',
  'detected_mime',
  'inspection_status',
  'width',
  'height',
  'preview_key',
  'validation_report_key',
  'scan_status',
  'failure_code',
  'referenced',
  'expires_at'
] as const;
export type ArtworkAssetListRow = Pick<
  StoredAsset,
  (typeof ARTWORK_ASSET_LIST_COLUMNS)[number]
>;
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
  technical_metadata?: AssetTechnicalMetadata | null;
  has_validation_report?: boolean;
  has_media_preview?: boolean;
}
