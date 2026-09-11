import { RequestContext } from '@/request.context';

export const MODULE_IDS = [
  'identity',
  'artwork',
  'files',
  'context',
  'process',
  'rights',
  'preservation',
  'interview'
] as const;
export type ModuleId = (typeof MODULE_IDS)[number];
export const REVIEW_LANES = ['curatorial', 'technical', 'rights'] as const;
export type ReviewLane = (typeof REVIEW_LANES)[number];
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export type Answer = {
  status:
    | 'provided'
    | 'unknown'
    | 'withheld'
    | 'unavailable'
    | 'not_applicable';
  value?: Json;
  explanation?: string;
  intended_visibility: 'public_record' | 'restricted';
};
export type Answers = Record<string, Answer>;
export type Modules = Record<ModuleId, Answers>;
export type Operation = { op: 'set' | 'unset'; field: string; answer?: Answer };
export type Capabilities = {
  read_context: boolean;
  edit_modules: ModuleId[];
  read_archival_files: boolean;
  read_rights_evidence: boolean;
  read_source_receipts: boolean;
  read_contact: boolean;
  read_restricted_fields: boolean;
  confirm_as_artist: boolean;
  review_lanes: ReviewLane[];
  manage_assignments: boolean;
  manage_context: boolean;
};
export type ValueSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  enum?: (string | number | boolean)[];
  properties?: Record<string, ValueSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ValueSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  format?: string;
  oneOf?: ValueSchema[];
  description?: string;
};
export type FieldDefinition = {
  id: string;
  value_schema: ValueSchema;
  allowed_statuses: Answer['status'][];
  default_visibility: Answer['intended_visibility'];
  locked_restricted: boolean;
};
export type DocumentationProfile = {
  profile_id: string;
  version: number;
  intake_mode?: 'publication_only';
  program_id: string | null;
  wave_id: string | null;
  required_for_review: string[];
  review_lanes: ReviewLane[];
  modules: { id: ModuleId; version: number; fields: FieldDefinition[] }[];
  guidance_version: string;
  confirmation_copy_version: string;
  confirmation_copy: string;
  interview_instrument: {
    id: string;
    version: number;
    language: string;
    prompts: { id: string; text: string }[];
  };
  limits: Record<string, number>;
  [key: string]: unknown;
};
export type AssetLink = {
  id: string;
  asset_id: string;
  role: string;
  label: string;
  description: string;
  intended_visibility: Answer['intended_visibility'];
  source_of_asset: string;
  source_credit: string;
  derived_from_asset_ids: string[];
  deposit_note: string;
  intended_terms: { kind: string; license_uri?: string; note?: string };
  manifest: Record<string, unknown>;
};
export type ContextRecord = {
  id: string;
  work_id: string;
  owner_profile_id: string;
  program_id: string | null;
  profile: DocumentationProfile;
  draft_version: number;
  artist_record_revision_id: string | null;
  latest_revision_id: string | null;
  lifecycle: 'active' | 'archived';
  modules: Modules;
  asset_links: AssetLink[];
  restricted_paths: string[];
  created_at: number;
  updated_at: number;
};
export type ContextAccess = {
  context: ContextRecord;
  capabilities: Capabilities;
  isArtist: boolean;
  actorProfileId: string;
};
export type Mutation = {
  key: string;
  route: string;
  body: unknown;
  expectedVersion?: number;
};
export type Issue = { field: string; code: string; lane: ReviewLane };
export type AssetGateway = {
  listAssets(
    contextId: string,
    access: ContextAccess,
    ctx: RequestContext
  ): Promise<unknown[]>;
  validateReadyAsset(
    contextId: string,
    assetId: string,
    access: ContextAccess,
    ctx: RequestContext
  ): Promise<Record<string, unknown>>;
  markReferenced(
    contextId: string,
    assetIds: string[],
    ctx: RequestContext
  ): Promise<void>;
};
