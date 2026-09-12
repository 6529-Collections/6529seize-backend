import { ContextRecord } from '../../artwork-documentation.types';
import { StoredAsset } from '../../assets/artwork-assets.types';

export interface DossierSnapshot {
  context: ContextRecord;
  museum_records: Record<string, unknown>[];
  assets: StoredAsset[];
  confirmation: 'unconfirmed' | 'current' | 'newer_draft';
  source_receipts: Record<string, unknown>[];
  confirmed_revision: Record<string, unknown> | null;
  artist_revisions?: Record<string, unknown>[];
  review_history?: Record<string, unknown>[];
}
export interface DossierIssue {
  code: string;
  path: string;
  severity: 'error' | 'warning' | 'information';
  message: string;
}
export interface DossierTextFile {
  path: string;
  media_type: string;
  bytes: Buffer;
  sha256: string;
}
export interface DossierExportRow {
  id: string;
  context_id: string;
  actor_profile_id: string;
  source_sha256: string;
  state: 'queued' | 'processing' | 'ready' | 'failed';
  snapshot_json: unknown;
  object_version: string | null;
  sha256: string | null;
  size_bytes: number | null;
  failure_code: string | null;
  created_at: number;
  expires_at: number;
  lease_until: number;
  attempts: number;
}
