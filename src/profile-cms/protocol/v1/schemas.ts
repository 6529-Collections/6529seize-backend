import { z } from 'zod';

import {
  CMS_AGENT_PATCH_SCHEMA,
  CMS_AGENT_PATCH_MAX_OPERATIONS,
  CMS_ASSET_KINDS,
  CMS_ASSET_ROLES,
  CMS_BLOCK_TYPES,
  CMS_CANONICALIZATION,
  CMS_DISPLAY_VARIANT_ROLES,
  CMS_HASH_ALGORITHM,
  CMS_HYDRATION_POLICIES,
  CMS_PACKAGE_SCHEMA,
  CMS_PAGE_TYPES,
  CMS_PAYLOAD_SCHEMA,
  CMS_ROUTE_KINDS,
  CMS_SIGNATURE_TYPES,
  CMS_SOURCE_PACKET_TYPES,
  CMS_STORAGE_PROVIDERS,
  CMS_VALIDATION_RESULT_SCHEMA
} from './constants';

const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,127}$/);
const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/);
const cmsPathSchema = z
  .string()
  .regex(/^\/[a-zA-Z0-9._~!$&'()*+,;=:@/-]+\/index\.html$/);
const uriSchema = z.string().min(1).max(2048);
const hashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const localeSchema = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/);
const ethereumAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const dateTimeSchema = z.string().datetime({ offset: true });

export type CmsBlockTypeV1 = (typeof CMS_BLOCK_TYPES)[number];
export type CmsPageTypeV1 = (typeof CMS_PAGE_TYPES)[number];
export type CmsRouteKindV1 = (typeof CMS_ROUTE_KINDS)[number];
export type CmsAssetKindV1 = (typeof CMS_ASSET_KINDS)[number];
export type CmsAssetRoleV1 = (typeof CMS_ASSET_ROLES)[number];
export type CmsHydrationPolicyV1 = (typeof CMS_HYDRATION_POLICIES)[number];
export type CmsDisplayVariantRoleV1 =
  (typeof CMS_DISPLAY_VARIANT_ROLES)[number];
export type CmsSignatureTypeV1 = (typeof CMS_SIGNATURE_TYPES)[number];
export type CmsStorageProviderV1 = (typeof CMS_STORAGE_PROVIDERS)[number];
export type CmsSourcePacketTypeV1 = (typeof CMS_SOURCE_PACKET_TYPES)[number];
export type CmsBlockValueV1 =
  | string
  | number
  | boolean
  | null
  | CmsBlockValueV1[]
  | { [key: string]: CmsBlockValueV1 };

export interface CmsProfileRefV1 {
  handle: string;
  profile_id?: string;
  primary_wallet?: string;
}

export interface CmsThemeV1 {
  mode: 'light' | 'dark' | 'system';
  accent: string;
  tokens?: Record<string, string | number | boolean>;
}

export interface CmsPageMetadataPartialV1 {
  title?: string;
  description?: string;
  locale?: string;
  canonical_url?: string;
  social_image_asset_id?: string;
  square_social_image_asset_id?: string;
  navigation_label?: string;
  search?: 'include' | 'exclude';
  robots?: 'index' | 'noindex';
  last_updated?: string;
}

export interface CmsPageMetadataV1 extends CmsPageMetadataPartialV1 {
  title: string;
  description: string;
  locale: string;
  canonical_url: string;
}

export interface CmsMetadataDefaultV1 {
  scope: {
    collection?: string;
    path_prefix?: string;
    page_type?: string;
  };
  values: CmsPageMetadataPartialV1;
}

export interface CmsSearchConfigV1 {
  enabled?: boolean;
  manifest_asset_id?: string;
}

export interface CmsSiteManifestV1 {
  title: string;
  description?: string;
  base_path: string;
  default_locale: string;
  direction?: 'ltr' | 'rtl';
  theme: CmsThemeV1;
  navigation_id: string;
  metadata_defaults?: CmsMetadataDefaultV1[];
  search?: CmsSearchConfigV1;
  required_renderer_capabilities?: string[];
}

export interface CmsInteractivePolicyV1 {
  hydration: CmsHydrationPolicyV1;
  requires_user_activation?: boolean;
  fallback_asset_id?: string;
  sandbox_permissions?: string[];
  performance_budget?: Record<string, number | string>;
}

export interface CmsBlockV1 {
  id: string;
  block_type: CmsBlockTypeV1;
  interactive_policy?: CmsInteractivePolicyV1;
  [key: string]: unknown;
}

export interface CmsSourceRefV1 {
  source_packet_id?: string;
  field_sources?: Record<string, string>;
}

export interface CmsPageV1 {
  id: string;
  type: CmsPageTypeV1;
  path: string;
  metadata: CmsPageMetadataV1;
  blocks: CmsBlockV1[];
  source?: CmsSourceRefV1;
}

export interface CmsRouteV1 {
  path: string;
  kind: CmsRouteKindV1;
  page_id?: string;
  target?: string;
}

export interface CmsAssetV1 {
  id: string;
  kind: CmsAssetKindV1;
  uri: string;
  content_hash: string;
  mime_type: string;
  width?: number;
  height?: number;
  duration_seconds?: number;
  file_size_bytes?: number;
  roles?: CmsAssetRoleV1[];
  alt_text?: string;
  decorative?: boolean;
  rights?: string;
}

export interface CmsDisplayVariantV1 {
  asset_id: string;
  role: CmsDisplayVariantRoleV1;
  crop_mode?: 'preserve' | 'cover' | 'contain';
  background?: string;
  source_asset_id?: string;
}

export interface CmsSnapshotV1 {
  owner?: string;
  block_number?: number;
  captured_at?: string;
}

export interface CmsNftMediaProfileV1 {
  id: string;
  chain_id: number;
  contract: string;
  token_id: string;
  metadata_uri?: string;
  metadata_hash?: string;
  original_asset_ids?: string[];
  display_variants: CmsDisplayVariantV1[];
  poster_asset_id?: string;
  snapshot?: CmsSnapshotV1;
}

export interface CmsDeepZoomManifestV1 {
  id: string;
  source_asset_id: string;
  tile_size: number;
  levels: number;
  format: 'jpg' | 'png' | 'webp' | 'avif';
  tile_uri_template?: string;
  content_hash?: string;
}

export interface CmsArtworkPlacementV1 {
  id: string;
  asset_id: string;
  nft_media_profile_id?: string;
  detail_page_id: string;
  position?: [number, number, number];
  rotation?: [number, number, number];
  size?: [number, number];
  display_mode: 'faithful' | 'gallery';
  label?: string;
}

export interface CmsExhibitionRoomV1 {
  id: string;
  title: string;
  room_type: 'wall' | 'salon' | 'white_cube' | 'dark_room';
  poster_asset_id?: string;
  fallback_page_id: string;
  navigation_mode?: 'orbit' | 'guided_hotspots' | 'walk';
  placements: CmsArtworkPlacementV1[];
}

export interface CmsNavigationItemShape {
  label: string;
  page_id?: string;
  url?: string;
  children?: CmsNavigationItemShape[];
}

export type CmsNavigationItemV1 = CmsNavigationItemShape;

export interface CmsNavigationV1 {
  id: string;
  items: CmsNavigationItemV1[];
}

export interface CmsTaxonomyV1 {
  id: string;
  name: string;
  terms: Array<{
    slug: string;
    label: string;
    page_id?: string;
  }>;
}

export interface CmsSourcePacketV1 {
  id: string;
  source_type: CmsSourcePacketTypeV1;
  captured_at: string;
  content_hash?: string;
  [key: string]: unknown;
}

export interface CmsBuildManifestV1 {
  renderer?: string;
  renderer_version?: string;
  route_count?: number;
  asset_count?: number;
  warnings?: string[];
}

export interface CmsPayloadV1 {
  schema: typeof CMS_PAYLOAD_SCHEMA;
  routes: CmsRouteV1[];
  pages: CmsPageV1[];
  assets: CmsAssetV1[];
  nft_media_profiles?: CmsNftMediaProfileV1[];
  deep_zoom_manifests?: CmsDeepZoomManifestV1[];
  exhibition_rooms?: CmsExhibitionRoomV1[];
  navigation: CmsNavigationV1[];
  taxonomies?: CmsTaxonomyV1[];
  source_packets?: CmsSourcePacketV1[];
  build_manifest?: CmsBuildManifestV1;
}

export interface CmsIntegrityV1 {
  canonicalization: typeof CMS_CANONICALIZATION;
  hash_algorithm: typeof CMS_HASH_ALGORITHM;
  payload_hash: string;
  package_hash: string;
  note?: string;
}

export interface CmsSignatureEnvelopeV1 {
  type: CmsSignatureTypeV1;
  signer: string;
  signature: string;
  signed_at: string;
  domain?: Record<string, unknown>;
}

export interface CmsStorageReceiptV1 {
  provider: CmsStorageProviderV1;
  uri: string;
  content_hash: string;
  provider_content_id?: string;
  pinned?: boolean;
  canonical?: boolean;
  recorded_at: string;
}

export interface CmsPackageProvenanceV1 {
  builder: string;
  builder_version?: string;
  created_at: string;
  notes?: string;
}

export interface CmsPackageV1 {
  schema: typeof CMS_PACKAGE_SCHEMA;
  package_id: string;
  profile: CmsProfileRefV1;
  site: CmsSiteManifestV1;
  payload: CmsPayloadV1;
  integrity: CmsIntegrityV1;
  signatures: CmsSignatureEnvelopeV1[];
  storage: CmsStorageReceiptV1[];
  provenance: CmsPackageProvenanceV1;
}

export interface CmsValidationIssueV1 {
  severity: 'error' | 'warning' | 'note';
  code: string;
  message: string;
  path: string;
  page_id?: string;
  block_id?: string;
  suggested_fix?: string;
}

export interface CmsValidationResultV1 {
  schema: typeof CMS_VALIDATION_RESULT_SCHEMA;
  valid: boolean;
  checked_at: string;
  validator?: string;
  validator_version?: string;
  target?: {
    package_hash?: string;
    draft_id?: string;
    package_id?: string;
  };
  issues: CmsValidationIssueV1[];
}

export interface CmsAgentPatchOperationV1 {
  op:
    | 'add_page'
    | 'remove_page'
    | 'update_page_metadata'
    | 'add_block'
    | 'update_block'
    | 'remove_block'
    | 'reorder_blocks'
    | 'update_navigation'
    | 'update_theme'
    | 'update_share_metadata'
    | 'attach_source_packet'
    | 'set_taxonomy_terms';
  path: string;
  value?: unknown;
  reason?: string;
  source_packet_ids?: string[];
}

export interface CmsAgentPatchV1 {
  schema: typeof CMS_AGENT_PATCH_SCHEMA;
  patch_id: string;
  target: {
    draft_id: string;
    base_version: number;
    base_package_hash: string;
  };
  operations: CmsAgentPatchOperationV1[];
  provenance: {
    created_at: string;
    author_type: 'user_agent' | 'local_tool' | 'human';
    agent_name?: string;
    agent_version?: string;
    notes?: string;
  };
}

const blockValueSchema: z.ZodType<CmsBlockValueV1> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(blockValueSchema),
    z.record(blockValueSchema)
  ])
) as z.ZodType<CmsBlockValueV1>;

export const profileRefSchema = z
  .object({
    handle: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{1,63}$/),
    profile_id: z.string().optional(),
    primary_wallet: ethereumAddressSchema.optional()
  })
  .strict();

export const themeSchema = z
  .object({
    mode: z.enum(['light', 'dark', 'system']),
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    tokens: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
  })
  .strict();

export const pageMetadataPartialSchema = z
  .object({
    title: z.string().min(1).max(160).optional(),
    description: z.string().max(300).optional(),
    locale: localeSchema.optional(),
    canonical_url: uriSchema.optional(),
    social_image_asset_id: idSchema.optional(),
    square_social_image_asset_id: idSchema.optional(),
    navigation_label: z.string().max(80).optional(),
    search: z.enum(['include', 'exclude']).optional(),
    robots: z.enum(['index', 'noindex']).optional(),
    last_updated: dateTimeSchema.optional()
  })
  .strict();

export const pageMetadataSchema = pageMetadataPartialSchema
  .extend({
    title: z.string().min(1).max(160),
    description: z.string().max(300),
    locale: localeSchema,
    canonical_url: uriSchema
  })
  .strict();

export const metadataDefaultSchema = z
  .object({
    scope: z
      .object({
        collection: z.string().optional(),
        path_prefix: z.string().optional(),
        page_type: z.string().optional()
      })
      .strict(),
    values: pageMetadataPartialSchema
  })
  .strict();

export const searchConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    manifest_asset_id: idSchema.optional()
  })
  .strict();

export const siteManifestSchema = z
  .object({
    title: z.string().min(1).max(160),
    description: z.string().max(300).optional(),
    base_path: cmsPathSchema,
    default_locale: localeSchema,
    direction: z.enum(['ltr', 'rtl']).optional(),
    theme: themeSchema,
    navigation_id: idSchema,
    metadata_defaults: z.array(metadataDefaultSchema).optional(),
    search: searchConfigSchema.optional(),
    required_renderer_capabilities: z.array(z.string()).optional()
  })
  .strict();

export const interactivePolicySchema = z
  .object({
    hydration: z.enum(CMS_HYDRATION_POLICIES),
    requires_user_activation: z.boolean().optional(),
    fallback_asset_id: idSchema.optional(),
    sandbox_permissions: z.array(z.string()).optional(),
    performance_budget: z.record(z.union([z.number(), z.string()])).optional()
  })
  .strict();

export const blockSchema: z.ZodType<CmsBlockV1> = z
  .object({
    id: idSchema,
    block_type: z.enum(CMS_BLOCK_TYPES),
    interactive_policy: interactivePolicySchema.optional()
  })
  .catchall(blockValueSchema) as z.ZodType<CmsBlockV1>;

export const sourceRefSchema = z
  .object({
    source_packet_id: idSchema.optional(),
    field_sources: z.record(z.string()).optional()
  })
  .strict();

export const pageSchema: z.ZodType<CmsPageV1> = z
  .object({
    id: idSchema,
    type: z.enum(CMS_PAGE_TYPES),
    path: cmsPathSchema,
    metadata: pageMetadataSchema,
    blocks: z.array(blockSchema),
    source: sourceRefSchema.optional()
  })
  .strict() as z.ZodType<CmsPageV1>;

export const routeSchema: z.ZodType<CmsRouteV1> = z
  .object({
    path: cmsPathSchema,
    kind: z.enum(CMS_ROUTE_KINDS),
    page_id: idSchema.optional(),
    target: z.string().optional()
  })
  .strict() as z.ZodType<CmsRouteV1>;

export const assetSchema: z.ZodType<CmsAssetV1> = z
  .object({
    id: idSchema,
    kind: z.enum(CMS_ASSET_KINDS),
    uri: uriSchema,
    content_hash: hashSchema,
    mime_type: z.string(),
    width: z.number().int().min(1).optional(),
    height: z.number().int().min(1).optional(),
    duration_seconds: z.number().min(0).optional(),
    file_size_bytes: z.number().int().min(0).optional(),
    roles: z.array(z.enum(CMS_ASSET_ROLES)).optional(),
    alt_text: z.string().optional(),
    decorative: z.boolean().optional(),
    rights: z.string().optional()
  })
  .strict() as z.ZodType<CmsAssetV1>;

export const displayVariantSchema: z.ZodType<CmsDisplayVariantV1> = z
  .object({
    asset_id: idSchema,
    role: z.enum(CMS_DISPLAY_VARIANT_ROLES),
    crop_mode: z.enum(['preserve', 'cover', 'contain']).optional(),
    background: z.string().optional(),
    source_asset_id: idSchema.optional()
  })
  .strict() as z.ZodType<CmsDisplayVariantV1>;

export const snapshotSchema: z.ZodType<CmsSnapshotV1> = z
  .object({
    owner: z.string().optional(),
    block_number: z.number().int().min(0).optional(),
    captured_at: dateTimeSchema.optional()
  })
  .strict() as z.ZodType<CmsSnapshotV1>;

export const nftMediaProfileSchema: z.ZodType<CmsNftMediaProfileV1> = z
  .object({
    id: idSchema,
    chain_id: z.number().int().min(1),
    contract: ethereumAddressSchema,
    token_id: z.string().min(1),
    metadata_uri: uriSchema.optional(),
    metadata_hash: hashSchema.optional(),
    original_asset_ids: z.array(idSchema).optional(),
    display_variants: z.array(displayVariantSchema),
    poster_asset_id: idSchema.optional(),
    snapshot: snapshotSchema.optional()
  })
  .strict() as z.ZodType<CmsNftMediaProfileV1>;

export const deepZoomManifestSchema: z.ZodType<CmsDeepZoomManifestV1> = z
  .object({
    id: idSchema,
    source_asset_id: idSchema,
    tile_size: z.number().int().min(128),
    levels: z.number().int().min(1),
    format: z.enum(['jpg', 'png', 'webp', 'avif']),
    tile_uri_template: uriSchema.optional(),
    content_hash: hashSchema.optional()
  })
  .strict() as z.ZodType<CmsDeepZoomManifestV1>;

const vector3Schema = z.tuple([
  z.number(),
  z.number(),
  z.number()
]) as unknown as z.ZodType<[number, number, number]>;

const positiveSize2Schema = z.tuple([
  z.number().positive(),
  z.number().positive()
]) as unknown as z.ZodType<[number, number]>;

export const artworkPlacementSchema: z.ZodType<CmsArtworkPlacementV1> = z
  .object({
    id: idSchema,
    asset_id: idSchema,
    nft_media_profile_id: idSchema.optional(),
    detail_page_id: idSchema,
    position: vector3Schema.optional(),
    rotation: vector3Schema.optional(),
    size: positiveSize2Schema.optional(),
    display_mode: z.enum(['faithful', 'gallery']),
    label: z.string().optional()
  })
  .strict() as z.ZodType<CmsArtworkPlacementV1>;

export const exhibitionRoomSchema: z.ZodType<CmsExhibitionRoomV1> = z
  .object({
    id: idSchema,
    title: z.string().min(1),
    room_type: z.enum(['wall', 'salon', 'white_cube', 'dark_room']),
    poster_asset_id: idSchema.optional(),
    fallback_page_id: idSchema,
    navigation_mode: z.enum(['orbit', 'guided_hotspots', 'walk']).optional(),
    placements: z.array(artworkPlacementSchema)
  })
  .strict() as z.ZodType<CmsExhibitionRoomV1>;

const createNavigationItemSchema = (): z.ZodType<CmsNavigationItemShape> =>
  z
    .object({
      label: z.string(),
      page_id: idSchema.optional(),
      url: uriSchema.optional(),
      children: z.array(navigationItemSchema).optional()
    })
    .strict() as z.ZodType<CmsNavigationItemShape>;

export const navigationItemSchema: z.ZodType<CmsNavigationItemShape> = z.lazy(
  createNavigationItemSchema
);

export const navigationSchema: z.ZodType<CmsNavigationV1> = z
  .object({
    id: idSchema,
    items: z.array(navigationItemSchema)
  })
  .strict() as z.ZodType<CmsNavigationV1>;

export const taxonomySchema: z.ZodType<CmsTaxonomyV1> = z
  .object({
    id: idSchema,
    name: z.string(),
    terms: z.array(
      z
        .object({
          slug: slugSchema,
          label: z.string(),
          page_id: idSchema.optional()
        })
        .strict()
    )
  })
  .strict() as z.ZodType<CmsTaxonomyV1>;

export const sourcePacketSchema: z.ZodType<CmsSourcePacketV1> = z
  .object({
    id: idSchema,
    source_type: z.enum(CMS_SOURCE_PACKET_TYPES),
    captured_at: dateTimeSchema,
    content_hash: hashSchema.optional()
  })
  .catchall(blockValueSchema) as z.ZodType<CmsSourcePacketV1>;

export const buildManifestSchema: z.ZodType<CmsBuildManifestV1> = z
  .object({
    renderer: z.string().optional(),
    renderer_version: z.string().optional(),
    route_count: z.number().int().min(0).optional(),
    asset_count: z.number().int().min(0).optional(),
    warnings: z.array(z.string()).optional()
  })
  .strict() as z.ZodType<CmsBuildManifestV1>;

export const cmsPayloadSchema: z.ZodType<CmsPayloadV1> = z
  .object({
    schema: z.literal(CMS_PAYLOAD_SCHEMA),
    routes: z.array(routeSchema),
    pages: z.array(pageSchema),
    assets: z.array(assetSchema),
    nft_media_profiles: z.array(nftMediaProfileSchema).optional(),
    deep_zoom_manifests: z.array(deepZoomManifestSchema).optional(),
    exhibition_rooms: z.array(exhibitionRoomSchema).optional(),
    navigation: z.array(navigationSchema),
    taxonomies: z.array(taxonomySchema).optional(),
    source_packets: z.array(sourcePacketSchema).optional(),
    build_manifest: buildManifestSchema.optional()
  })
  .strict() as z.ZodType<CmsPayloadV1>;

export const integritySchema: z.ZodType<CmsIntegrityV1> = z
  .object({
    canonicalization: z.literal(CMS_CANONICALIZATION),
    hash_algorithm: z.literal(CMS_HASH_ALGORITHM),
    payload_hash: hashSchema,
    package_hash: hashSchema,
    note: z.string().optional()
  })
  .strict() as z.ZodType<CmsIntegrityV1>;

export const signatureEnvelopeSchema: z.ZodType<CmsSignatureEnvelopeV1> = z
  .object({
    type: z.enum(CMS_SIGNATURE_TYPES),
    signer: z.string(),
    signature: z.string(),
    signed_at: dateTimeSchema,
    domain: z.record(z.unknown()).optional()
  })
  .strict() as z.ZodType<CmsSignatureEnvelopeV1>;

export const storageReceiptSchema: z.ZodType<CmsStorageReceiptV1> = z
  .object({
    provider: z.enum(CMS_STORAGE_PROVIDERS),
    uri: uriSchema,
    content_hash: hashSchema,
    provider_content_id: z.string().optional(),
    pinned: z.boolean().optional(),
    canonical: z.boolean().optional(),
    recorded_at: dateTimeSchema
  })
  .strict() as z.ZodType<CmsStorageReceiptV1>;

export const packageProvenanceSchema: z.ZodType<CmsPackageProvenanceV1> = z
  .object({
    builder: z.string(),
    builder_version: z.string().optional(),
    created_at: dateTimeSchema,
    notes: z.string().optional()
  })
  .strict() as z.ZodType<CmsPackageProvenanceV1>;

export const cmsPackageSchema: z.ZodType<CmsPackageV1> = z
  .object({
    schema: z.literal(CMS_PACKAGE_SCHEMA),
    package_id: idSchema,
    profile: profileRefSchema,
    site: siteManifestSchema,
    payload: cmsPayloadSchema,
    integrity: integritySchema,
    signatures: z.array(signatureEnvelopeSchema).min(1),
    storage: z.array(storageReceiptSchema).min(1),
    provenance: packageProvenanceSchema
  })
  .strict() as z.ZodType<CmsPackageV1>;

export const validationIssueSchema: z.ZodType<CmsValidationIssueV1> = z
  .object({
    severity: z.enum(['error', 'warning', 'note']),
    code: z.string(),
    message: z.string(),
    path: z.string(),
    page_id: z.string().optional(),
    block_id: z.string().optional(),
    suggested_fix: z.string().optional()
  })
  .strict() as z.ZodType<CmsValidationIssueV1>;

export const validationResultSchema: z.ZodType<CmsValidationResultV1> = z
  .object({
    schema: z.literal(CMS_VALIDATION_RESULT_SCHEMA),
    valid: z.boolean(),
    checked_at: dateTimeSchema,
    validator: z.string().optional(),
    validator_version: z.string().optional(),
    target: z
      .object({
        package_hash: hashSchema.optional(),
        draft_id: z.string().optional(),
        package_id: z.string().optional()
      })
      .strict()
      .optional(),
    issues: z.array(validationIssueSchema)
  })
  .strict() as z.ZodType<CmsValidationResultV1>;

export const agentPatchOperationSchema: z.ZodType<CmsAgentPatchOperationV1> = z
  .object({
    op: z.enum([
      'add_page',
      'remove_page',
      'update_page_metadata',
      'add_block',
      'update_block',
      'remove_block',
      'reorder_blocks',
      'update_navigation',
      'update_theme',
      'update_share_metadata',
      'attach_source_packet',
      'set_taxonomy_terms'
    ]),
    path: z.string().min(1),
    value: z.unknown().optional(),
    reason: z.string().optional(),
    source_packet_ids: z.array(z.string()).optional()
  })
  .strict() as z.ZodType<CmsAgentPatchOperationV1>;

export const agentPatchSchema: z.ZodType<CmsAgentPatchV1> = z
  .object({
    schema: z.literal(CMS_AGENT_PATCH_SCHEMA),
    patch_id: z.string().min(1),
    target: z
      .object({
        draft_id: z.string(),
        base_version: z.number().int().min(0),
        base_package_hash: hashSchema
      })
      .strict(),
    operations: z
      .array(agentPatchOperationSchema)
      .min(1)
      .max(CMS_AGENT_PATCH_MAX_OPERATIONS),
    provenance: z
      .object({
        created_at: dateTimeSchema,
        author_type: z.enum(['user_agent', 'local_tool', 'human']),
        agent_name: z.string().optional(),
        agent_version: z.string().optional(),
        notes: z.string().optional()
      })
      .strict()
  })
  .strict() as z.ZodType<CmsAgentPatchV1>;
