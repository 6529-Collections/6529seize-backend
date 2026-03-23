import type { MintingClaimRow } from '@/api/minting-claims/api.minting-claims.db';
import {
  fetchMaxSeasonId,
  fetchMemeIdByMemeName
} from '@/api/minting-claims/api.minting-claims.db';
import { arweaveFileUploader } from '@/arweave';
import { BadRequestException } from '@/exceptions';
import { fetchPublicUrlToBuffer } from '@/http/safe-fetch';
import { Logger } from '@/logging';
import { isMemesContract } from '@/minting-claims/external-url';
import { createHash } from 'node:crypto';

const logger = Logger.get('claims-media-arweave-upload');
export const MIN_EDITION_SIZE = 300;

const FETCH_MEDIA_TIMEOUT_MS = 60_000;
const MAX_ARWEAVE_UPLOAD_BYTES = 100 * 1024 * 1024;
const ARWEAVE_METADATA_CREATED_BY = '6529 Collections';
const ARWEAVE_POINTS_TRAIT_PREFIX = 'Points - ';
const TYPE_MEME_TRAIT = 'Type - Meme';
const TYPE_SEASON_TRAIT = 'Type - Season';
const TYPE_CARD_TRAIT = 'Type - Card';
const TYPE_TRAIT = 'Type';
const TYPE_TRAIT_VALUE_CARD = 'Card';
const ISSUANCE_MONTH_TRAIT = 'Issuance Month';
const MEME_NAME_TRAIT = 'Meme Name';
const IMAGE_DETAILS_KEYS = [
  'bytes',
  'format',
  'sha256',
  'width',
  'height'
] as const;
const VIDEO_ANIMATION_DETAILS_KEYS = [
  'bytes',
  'format',
  'duration',
  'sha256',
  'width',
  'height',
  'codecs'
] as const;
const HTML_ANIMATION_DETAILS_KEYS = ['format'] as const;
const GLB_ANIMATION_DETAILS_KEYS = ['bytes', 'format', 'sha256'] as const;
const MEMES_REQUIRED_METADATA_KEYS = new Set([
  'created_by',
  'description',
  'name',
  'external_url',
  'attributes',
  'image_details',
  'image',
  'image_url'
]);
const MEMES_REQUIRED_FINAL_ATTRIBUTE_TRAITS = new Set([
  'Artist',
  'SEIZE Artist Profile',
  MEME_NAME_TRAIT,
  'Points - Power',
  'Points - Wisdom',
  'Points - Loki',
  'Points - Speed',
  'Punk 6529',
  'Gradient',
  'Movement',
  'Dynamic',
  'Interactive',
  'Collab',
  'OM',
  '3D',
  'Pepe',
  'GM',
  'Summer',
  'Tulip',
  'Bonus',
  'Boost',
  'Palette',
  'Style',
  'Jewel',
  'Superpower',
  'Dharma',
  'Gear',
  'Clothing',
  'Element',
  'Mystery',
  'Secrets',
  'Weapon',
  'Home',
  'Parent',
  'Sibling',
  'Food',
  'Drink',
  TYPE_MEME_TRAIT,
  TYPE_SEASON_TRAIT,
  TYPE_CARD_TRAIT,
  TYPE_TRAIT,
  ISSUANCE_MONTH_TRAIT
]);
const ARWEAVE_TYPE_NUMBER_TRAITS = new Set([
  TYPE_MEME_TRAIT,
  TYPE_SEASON_TRAIT,
  TYPE_CARD_TRAIT
]);

function safeParseJson<T>(raw: string | null, fallback: T, label: string): T {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    logger.warn(`Failed to parse ${label}`, {
      raw: raw.slice(0, 200),
      err
    });
    return fallback;
  }
}

function parseJsonOrNull<T>(raw: string | null): T | null {
  if (raw == null || raw === '') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function arweaveTxIdFromUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname.toLowerCase() === 'arweave.net') {
      const firstPathSegment = parsed.pathname
        .split('/')
        .find((segment) => segment.length > 0);
      return firstPathSegment ?? trimmed;
    }
  } catch {
    // Keep original string below for malformed URLs.
  }
  const base = 'https://arweave.net/';
  return trimmed.startsWith(base) ? trimmed.slice(base.length) : trimmed;
}

async function fetchUrlToBuffer(
  url: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const { buffer, contentType } = await fetchPublicUrlToBuffer(url, {
    timeoutMs: FETCH_MEDIA_TIMEOUT_MS,
    maxBytes: MAX_ARWEAVE_UPLOAD_BYTES,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; 6529ArweaveUpload/1.0; +https://6529.io)',
      Accept: '*/*'
    }
  });
  return {
    buffer,
    contentType: contentType ?? 'application/octet-stream'
  };
}

function inferImageContentTypeFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path.endsWith('.png')) return 'image/png';
    if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
    if (path.endsWith('.gif')) return 'image/gif';
    if (path.endsWith('.webp')) return 'image/webp';
    return null;
  } catch {
    return null;
  }
}

function normalizeSha256(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) return null;
  return normalized;
}

function buildArweaveUrl(location: string | null | undefined): string | null {
  if (location == null) return null;
  const trimmed = location.trim();
  if (trimmed === '') return null;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return `https://arweave.net/${trimmed}`;
}

function computeSha256Hex(buffer: Buffer): string {
  const bytes = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength
  );
  return createHash('sha256').update(bytes).digest('hex');
}

async function uploadImageToArweaveOrThrow(
  claim: MintingClaimRow,
  imageUrl: string
): Promise<string> {
  const fetched = await fetchUrlToBuffer(imageUrl);
  const inferred = inferImageContentTypeFromUrl(imageUrl);
  const contentType = fetched.contentType.startsWith('image/')
    ? fetched.contentType
    : (inferred ?? fetched.contentType);
  if (!contentType.startsWith('image/')) {
    throw new BadRequestException(
      `image_url did not resolve to an image (content-type: ${fetched.contentType})`
    );
  }
  const currentSha256 = computeSha256Hex(fetched.buffer);
  const existingDetails =
    parseJsonOrNull<{ sha256?: unknown }>(claim.image_details) ?? null;
  const existingSha256 = normalizeSha256(existingDetails?.sha256);
  const existingArweaveUrl = buildArweaveUrl(claim.image_location);
  if (existingSha256 != null && existingSha256 === currentSha256) {
    if (existingArweaveUrl != null) {
      logger.info(
        `Reusing existing image_location for claim_id=${claim.claim_id} based on matching sha256`
      );
      return existingArweaveUrl;
    }
  }
  const { url } = await arweaveFileUploader.uploadFile(
    fetched.buffer,
    contentType
  );
  return url;
}

async function uploadAnimationToArweaveIfPresent(
  claim: MintingClaimRow
): Promise<string | null> {
  const animationUrl = claim.animation_url?.trim() || null;
  if (animationUrl === null || animationUrl === '') return null;

  const details =
    parseJsonOrNull<{ format?: string }>(claim.animation_details) ?? null;
  if (details?.format === 'HTML') return animationUrl;

  const lowerPath = (() => {
    try {
      return new URL(animationUrl).pathname.toLowerCase();
    } catch {
      return '';
    }
  })();
  const expectsGlb = details?.format === 'GLB' || lowerPath.endsWith('.glb');
  const { buffer, contentType } = await fetchUrlToBuffer(animationUrl);
  const hasGenericContentType =
    contentType === '' ||
    contentType === 'application/octet-stream' ||
    contentType === 'binary/octet-stream';
  const contentTypeToUpload = resolveAnimationContentTypeForUpload({
    contentType,
    hasGenericContentType,
    lowerPath,
    expectsGlb
  });
  const currentSha256 = computeSha256Hex(buffer);
  const existingSha256 = normalizeSha256(
    (details as { sha256?: unknown }).sha256
  );
  const existingArweaveUrl = buildArweaveUrl(claim.animation_location);
  if (existingSha256 != null && existingSha256 === currentSha256) {
    if (existingArweaveUrl != null) {
      logger.info(
        `Reusing existing animation_location for claim_id=${claim.claim_id} based on matching sha256`
      );
      return existingArweaveUrl;
    }
  }
  const { url } = await arweaveFileUploader.uploadFile(
    buffer,
    contentTypeToUpload
  );
  return url;
}

function resolveAnimationContentTypeForUpload({
  contentType,
  hasGenericContentType,
  lowerPath,
  expectsGlb
}: {
  contentType: string;
  hasGenericContentType: boolean;
  lowerPath: string;
  expectsGlb: boolean;
}): string {
  if (expectsGlb) {
    const isValidGlb =
      contentType === 'model/gltf-binary' ||
      (hasGenericContentType && lowerPath.endsWith('.glb'));
    if (!isValidGlb) {
      throw new BadRequestException(
        `animation_url did not resolve to a GLB (content-type: ${contentType})`
      );
    }
    return 'model/gltf-binary';
  }
  const isValidVideo =
    contentType.startsWith('video/') ||
    (hasGenericContentType &&
      (lowerPath.endsWith('.mp4') || lowerPath.endsWith('.mov')));
  if (!isValidVideo) {
    throw new BadRequestException(
      `animation_url did not resolve to a video (content-type: ${contentType})`
    );
  }
  if (!hasGenericContentType) return contentType;
  if (lowerPath.endsWith('.mp4')) return 'video/mp4';
  if (lowerPath.endsWith('.mov')) return 'video/quicktime';
  return contentType;
}

function normalizeAttributesForArweave(attributes: unknown): unknown[] {
  if (!Array.isArray(attributes)) return [];
  return attributes.map((a: any) => {
    const traitType = a.trait_type ?? a.traitType;
    const value = a.value;
    const existingDisplayType = a.display_type ?? a.displayType ?? undefined;
    const existingMaxValue = a.max_value ?? a.maxValue ?? undefined;

    let displayType: string | undefined;
    let maxValue: number | undefined;
    if (
      typeof traitType === 'string' &&
      traitType.startsWith(ARWEAVE_POINTS_TRAIT_PREFIX)
    ) {
      displayType = existingDisplayType ?? 'boost_percentage';
      maxValue = existingMaxValue ?? 100;
    } else if (ARWEAVE_TYPE_NUMBER_TRAITS.has(traitType)) {
      displayType = existingDisplayType ?? 'number';
    } else if (traitType === 'Artist') {
      displayType = existingDisplayType ?? 'text';
    } else {
      displayType = undefined;
      maxValue = undefined;
    }

    if (displayType === undefined) {
      return { trait_type: traitType, value };
    }
    if (
      displayType === 'boost_percentage' ||
      ARWEAVE_TYPE_NUMBER_TRAITS.has(traitType)
    ) {
      const out: Record<string, unknown> = {
        display_type: displayType,
        trait_type: traitType,
        value
      };
      if (maxValue !== undefined) out.max_value = maxValue;
      return out;
    }
    return { trait_type: traitType, value, display_type: displayType };
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function pickKnownKeys(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (hasOwn(value, key)) {
      picked[key] = value[key];
    }
  }
  return Object.keys(picked).length === 0 ? null : picked;
}

function sanitizeImageDetails(value: unknown): Record<string, unknown> | null {
  return pickKnownKeys(value, IMAGE_DETAILS_KEYS);
}

function sanitizeAnimationDetails(
  value: unknown
): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const format = typeof value.format === 'string' ? value.format : null;
  if (format === 'HTML') {
    return pickKnownKeys(value, HTML_ANIMATION_DETAILS_KEYS);
  }
  if (format === 'GLB') {
    return pickKnownKeys(value, GLB_ANIMATION_DETAILS_KEYS);
  }
  return pickKnownKeys(value, VIDEO_ANIMATION_DETAILS_KEYS);
}

function serializeAnimationDetailsForArweave(
  animationDetails: Record<string, unknown> | null
) : Record<string, unknown> | null {
  if (animationDetails == null) return null;
  return animationDetails;
}

function getMemeNameFromAttributes(attributes: unknown): string {
  if (!Array.isArray(attributes))
    throw new BadRequestException('Claim has no attributes');
  const memeNameAttr = attributes.find(
    (a: any) => (a.trait_type ?? a.traitType) === MEME_NAME_TRAIT
  );
  const value = memeNameAttr?.value;
  if (value == null || typeof value !== 'string' || value.trim() === '') {
    throw new BadRequestException(
      'Claim has no "Meme Name" attribute; cannot resolve Type - Meme for Arweave upload'
    );
  }
  return value.trim();
}

function extractSeasonFromAttributes(attributes: unknown): number | null {
  if (!Array.isArray(attributes)) {
    return null;
  }

  const seasonAttribute = attributes.find(
    (attribute: any) =>
      (attribute?.trait_type ?? attribute?.traitType) === TYPE_SEASON_TRAIT
  ) as { value?: unknown } | undefined;

  if (!seasonAttribute) {
    return null;
  }

  const value = seasonAttribute.value;
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }

  return null;
}

function attributesWithTypeTraits(
  rawAttributes: unknown[],
  typeMemeValue: number,
  seasonValue: number,
  claimId: number
): unknown[] {
  const filtered = rawAttributes.filter((a: any) => {
    const tt = a.trait_type ?? a.traitType;
    return (
      tt !== TYPE_MEME_TRAIT &&
      tt !== TYPE_SEASON_TRAIT &&
      tt !== TYPE_CARD_TRAIT &&
      tt !== TYPE_TRAIT &&
      tt !== ISSUANCE_MONTH_TRAIT
    );
  });
  const now = new Date();
  const issuanceMonth = `${now.getUTCFullYear()}/${String(
    now.getUTCMonth() + 1
  ).padStart(2, '0')}`;
  filtered.push(
    {
      display_type: 'number',
      trait_type: TYPE_MEME_TRAIT,
      value: typeMemeValue
    },
    {
      display_type: 'number',
      trait_type: TYPE_SEASON_TRAIT,
      value: seasonValue
    },
    { display_type: 'number', trait_type: TYPE_CARD_TRAIT, value: claimId },
    { trait_type: TYPE_TRAIT, value: TYPE_TRAIT_VALUE_CARD },
    { trait_type: ISSUANCE_MONTH_TRAIT, value: issuanceMonth }
  );
  return filtered;
}

function filterMemesAttributesToKnownTraits(attributes: unknown[]): unknown[] {
  return attributes.filter((attribute: any) =>
    MEMES_REQUIRED_FINAL_ATTRIBUTE_TRAITS.has(
      attribute?.trait_type ?? attribute?.traitType
    )
  );
}

async function uploadClaimMetadataToArweave(
  contract: string,
  claim: MintingClaimRow,
  imageLocation: string,
  animationLocation: string | null,
  typeMemeId: number | null,
  seasonValue: number | null
): Promise<string> {
  const metadata = buildArweaveMetadataPayload(
    contract,
    claim,
    imageLocation,
    animationLocation,
    typeMemeId,
    seasonValue
  );
  const buffer = Buffer.from(JSON.stringify(metadata), 'utf8');
  const { url } = await arweaveFileUploader.uploadFile(
    buffer,
    'application/json'
  );
  return url;
}

function buildArweaveMetadataPayload(
  contract: string,
  claim: MintingClaimRow,
  imageLocation: string,
  animationLocation: string | null,
  typeMemeId: number | null,
  seasonValue: number | null
): Record<string, unknown> {
  const rawAttributes = safeParseJson(claim.attributes, [], 'attributes');
  const attributes = normalizeAttributesForArweave(
    isMemesContract(contract)
      ? filterMemesAttributesToKnownTraits(
          attributesWithTypeTraits(
            rawAttributes,
            typeMemeId as number,
            seasonValue as number,
            claim.claim_id
          )
        )
      : rawAttributes
  );
  const imageDetails = sanitizeImageDetails(
    parseJsonOrNull<Record<string, unknown>>(claim.image_details)
  );
  const sanitizedAnimationDetails = sanitizeAnimationDetails(
    parseJsonOrNull<Record<string, unknown>>(claim.animation_details)
  );
  const htmlAnimationUrl =
    (sanitizedAnimationDetails as { format?: string } | null)?.format === 'HTML'
      ? claim.animation_url?.trim() || null
      : null;
  const resolvedAnimationUrl = animationLocation ?? htmlAnimationUrl;
  const animationDetails = serializeAnimationDetailsForArweave(
    sanitizedAnimationDetails
  );

  const metadata: Record<string, unknown> = {
    created_by: ARWEAVE_METADATA_CREATED_BY,
    description: claim.description ?? '',
    name: claim.name,
    attributes
  };
  const externalUrl = claim.external_url?.trim();
  if (externalUrl) {
    metadata.external_url = externalUrl;
  }
  if (imageDetails != null) metadata.image_details = imageDetails;
  metadata.image = imageLocation;
  metadata.image_url = imageLocation;
  if (
    resolvedAnimationUrl != null &&
    (animationDetails as { format?: string } | null)?.format === 'HTML'
  ) {
    metadata.animation_url = resolvedAnimationUrl;
  } else if (resolvedAnimationUrl != null) {
    metadata.animation = resolvedAnimationUrl;
    metadata.animation_url = resolvedAnimationUrl;
  }
  if (animationDetails != null) metadata.animation_details = animationDetails;
  return metadata;
}

function validateAttributes(raw: unknown, requireMemeName: boolean): string[] {
  const issues: string[] = [];
  if (raw == null) {
    issues.push('Attributes (invalid JSON)');
    return issues;
  }
  if (!Array.isArray(raw)) {
    issues.push('Attributes (must be an array)');
    return issues;
  }
  const hasInvalidItems = raw.some((a: any) => {
    const traitType = a?.trait_type ?? a?.traitType;
    return (
      typeof traitType !== 'string' ||
      traitType.trim() === '' ||
      a?.value === undefined ||
      a?.value === null
    );
  });
  if (hasInvalidItems) issues.push('Attributes (invalid items)');
  if (requireMemeName) {
    const hasMemeName = raw.some(
      (a: any) => (a.trait_type ?? a.traitType) === MEME_NAME_TRAIT
    );
    if (!hasMemeName) issues.push('Meme Name Attribute');
  }
  return issues;
}

function getTraitType(attribute: any): string | null {
  const traitType = attribute?.trait_type ?? attribute?.traitType;
  if (typeof traitType !== 'string' || traitType.trim() === '') {
    return null;
  }
  return traitType;
}

function appendMemesFinalAttributeSchemaIssues(
  attributes: unknown,
  invalid: string[]
) {
  if (!Array.isArray(attributes)) {
    invalid.push('MEMES Attributes (must be an array)');
    return;
  }

  const counts = new Map<string, number>();
  for (const attribute of attributes) {
    const traitType = getTraitType(attribute);
    if (traitType == null) {
      invalid.push('MEMES Attributes (invalid trait types)');
      return;
    }
    counts.set(traitType, (counts.get(traitType) ?? 0) + 1);
  }

  const missingTraits = Array.from(
    MEMES_REQUIRED_FINAL_ATTRIBUTE_TRAITS
  ).filter((traitType) => !counts.has(traitType));
  const duplicateTraits = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([traitType]) => traitType);

  const issues: string[] = [];
  if (missingTraits.length > 0) {
    issues.push(`missing traits: ${missingTraits.join(', ')}`);
  }
  if (duplicateTraits.length > 0) {
    issues.push(`duplicate traits: ${duplicateTraits.join(', ')}`);
  }

  if (issues.length > 0) {
    invalid.push(`MEMES Attributes (${issues.join('; ')})`);
  }
}

function appendMissingDetailKeysIssue(
  label: string,
  details: Record<string, unknown> | null,
  requiredKeys: readonly string[],
  invalid: string[]
) {
  if (details == null) {
    return;
  }
  const missingKeys = requiredKeys.filter((key) => !hasOwn(details, key));
  if (missingKeys.length > 0) {
    invalid.push(`${label} (missing keys: ${missingKeys.join(', ')})`);
  }
}

function getMemesAnimationMetadataState(metadata: Record<string, unknown>) {
  const hasAnimation = hasOwn(metadata, 'animation');
  const hasAnimationUrl = hasOwn(metadata, 'animation_url');
  const hasAnimationDetails = hasOwn(metadata, 'animation_details');
  const animationDetails = metadata.animation_details;
  const hasAnyAnimationFields =
    hasAnimation || hasAnimationUrl || hasAnimationDetails;
  const hasHtmlAnimationDetails =
    (typeof animationDetails === 'string' &&
      animationDetails === '{ "format": "HTML" }') ||
    (isPlainObject(animationDetails) && animationDetails.format === 'HTML');

  return {
    hasAnimation,
    hasAnimationUrl,
    hasAnimationDetails,
    animationDetails,
    hasAnyAnimationFields,
    hasHtmlAnimationDetails
  };
}

function appendMissingMemesMetadataKeys(
  metadata: Record<string, unknown>,
  issues: string[]
) {
  const missingKeys = Array.from(MEMES_REQUIRED_METADATA_KEYS).filter(
    (key) => !hasOwn(metadata, key)
  );
  if (missingKeys.length > 0) {
    issues.push(`missing keys: ${missingKeys.join(', ')}`);
  }
}

function appendMissingMemesAnimationKeys(
  metadata: Record<string, unknown>,
  state: ReturnType<typeof getMemesAnimationMetadataState>,
  issues: string[]
) {
  if (state.hasHtmlAnimationDetails && state.hasAnyAnimationFields) {
    const missingHtmlAnimationKeys = [
      'animation_details',
      'animation_url'
    ].filter((key) => !hasOwn(metadata, key));
    if (missingHtmlAnimationKeys.length > 0) {
      issues.push(
        `incomplete html animation keys: ${missingHtmlAnimationKeys.join(', ')}`
      );
    }
    return;
  }

  if (state.hasAnyAnimationFields) {
    const missingAnimationKeys = [
      'animation',
      'animation_url',
      'animation_details'
    ].filter((key) => !hasOwn(metadata, key));
    if (missingAnimationKeys.length > 0) {
      issues.push(
        `incomplete animation keys: ${missingAnimationKeys.join(', ')}`
      );
    }
  }
}

function getRequiredAnimationDetailKeys(
  format: string | null
): readonly string[] {
  if (format === 'HTML') {
    return HTML_ANIMATION_DETAILS_KEYS;
  }
  if (format === 'GLB') {
    return GLB_ANIMATION_DETAILS_KEYS;
  }
  return VIDEO_ANIMATION_DETAILS_KEYS;
}

function appendMemesAnimationDetailsIssues(
  state: ReturnType<typeof getMemesAnimationMetadataState>,
  invalid: string[]
) {
  if (typeof state.animationDetails === 'string') {
    if (!state.hasHtmlAnimationDetails) {
      invalid.push('MEMES animation_details (invalid legacy string value)');
    }
    return;
  }

  if (!state.hasAnimationDetails) {
    return;
  }

  const objectAnimationDetails = state.animationDetails as Record<
    string,
    unknown
  > | null;
  const format =
    objectAnimationDetails != null &&
    typeof objectAnimationDetails.format === 'string'
      ? objectAnimationDetails.format
      : null;
  appendMissingDetailKeysIssue(
    'MEMES animation_details',
    objectAnimationDetails,
    getRequiredAnimationDetailKeys(format),
    invalid
  );
}

function appendMemesMetadataSkeletonIssues(
  metadata: Record<string, unknown>,
  invalid: string[]
) {
  const issues: string[] = [];
  const animationState = getMemesAnimationMetadataState(metadata);

  appendMissingMemesMetadataKeys(metadata, issues);
  appendMissingMemesAnimationKeys(metadata, animationState, issues);

  if (issues.length > 0) {
    invalid.push(`MEMES Metadata (${issues.join('; ')})`);
  }

  appendMissingDetailKeysIssue(
    'MEMES image_details',
    metadata.image_details as Record<string, unknown> | null,
    IMAGE_DETAILS_KEYS,
    invalid
  );
  appendMemesAnimationDetailsIssues(animationState, invalid);
}

export async function validateMintingClaimReadyForArweaveUpload(
  claim: MintingClaimRow,
  contract: string
): Promise<{
  imageUrl: string;
  typeMemeId: number | null;
  seasonValue: number | null;
}> {
  const memesContract = isMemesContract(contract);
  const missing: string[] = [];
  const invalid: string[] = [];
  const imageUrl = claim.image_url?.trim() ?? '';
  if (imageUrl === '') missing.push('Image URL');
  if (memesContract) {
    appendEditionSizeIssues(claim, missing, invalid);
  }

  const name = claim.name?.trim() ?? '';
  if (name === '') missing.push('Name');

  const description = claim.description?.trim();
  if (description == null || description === '') missing.push('Description');

  const rawAttributes = parseJsonOrNull<unknown>(claim.attributes);
  appendAttributeIssues(rawAttributes, missing, invalid, memesContract);

  let seasonValue: number | null = null;
  if (memesContract) {
    seasonValue = await appendSeasonIssues(rawAttributes, missing, invalid);
  }
  const typeMemeId = memesContract
    ? await resolveTypeMemeId(rawAttributes, missing, invalid)
    : null;
  if (
    memesContract &&
    rawAttributes != null &&
    Array.isArray(rawAttributes) &&
    seasonValue != null &&
    typeMemeId != null &&
    missing.length === 0 &&
    invalid.length === 0
  ) {
    const finalMemesAttributes = filterMemesAttributesToKnownTraits(
      attributesWithTypeTraits(
        rawAttributes,
        typeMemeId,
        seasonValue,
        claim.claim_id
      )
    );
    appendMemesFinalAttributeSchemaIssues(finalMemesAttributes, invalid);
    appendMemesMetadataSkeletonIssues(
      buildArweaveMetadataPayload(
        contract,
        claim,
        imageUrl,
        claim.animation_url?.trim() || null,
        typeMemeId,
        seasonValue
      ),
      invalid
    );
  }

  if (missing.length > 0 || invalid.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(
        `Missing required fields for Arweave upload: ${missing.join(', ')}.`
      );
    }
    if (invalid.length > 0) {
      parts.push(`Invalid fields for Arweave upload: ${invalid.join(', ')}.`);
    }
    throw new BadRequestException(parts.join(' '));
  }
  return {
    imageUrl,
    typeMemeId,
    seasonValue
  };
}

function appendEditionSizeIssues(
  claim: MintingClaimRow,
  missing: string[],
  invalid: string[]
) {
  const editionSize =
    claim.edition_size == null ? null : Number(claim.edition_size);
  if (editionSize == null) {
    missing.push('Edition Size');
    return;
  }
  if (!Number.isInteger(editionSize) || editionSize < MIN_EDITION_SIZE) {
    invalid.push(`Edition Size (must be an integer >= ${MIN_EDITION_SIZE})`);
  }
}

async function appendSeasonIssues(
  rawAttributes: unknown,
  missing: string[],
  invalid: string[]
): Promise<number | null> {
  const seasonValue = extractSeasonFromAttributes(rawAttributes);
  if (seasonValue == null) {
    missing.push('Season');
    return null;
  }
  const maxSeasonId = await fetchMaxSeasonId();
  const requiredMinSeason = Math.max(1, maxSeasonId);
  if (
    !Number.isInteger(seasonValue) ||
    seasonValue < requiredMinSeason ||
    seasonValue > requiredMinSeason + 1
  ) {
    invalid.push(
      `Season (must be ${requiredMinSeason} or ${requiredMinSeason + 1}; current max season is ${maxSeasonId}, got ${seasonValue})`
    );
  }
  return seasonValue;
}

function appendAttributeIssues(
  rawAttributes: unknown,
  missing: string[],
  invalid: string[],
  memesContract: boolean
) {
  const attributeIssues = validateAttributes(rawAttributes, memesContract);
  for (const issue of attributeIssues) {
    if (issue.startsWith('Attributes (')) {
      invalid.push(issue);
      continue;
    }
    missing.push(issue);
  }
}

async function resolveTypeMemeId(
  rawAttributes: unknown,
  missing: string[],
  invalid: string[]
): Promise<number | null> {
  if (missing.length > 0 || invalid.length > 0) return null;
  try {
    const memeName = getMemeNameFromAttributes(rawAttributes);
    const typeMemeId = await fetchMemeIdByMemeName(memeName);
    if (typeMemeId === null) {
      invalid.push(
        `Meme Name Attribute (no meme found in memes_extended_data for "${memeName}")`
      );
      return null;
    }
    return typeMemeId;
  } catch (error) {
    invalid.push(
      error instanceof Error
        ? `Meme Name Attribute (${error.message})`
        : 'Meme Name Attribute (invalid)'
    );
    return null;
  }
}

export async function uploadMintingClaimToArweave(
  contract: string,
  claim: MintingClaimRow
): Promise<{
  imageLocationUrl: string;
  animationLocationUrl: string | null;
  metadataLocationUrl: string;
}> {
  const { imageUrl, typeMemeId, seasonValue } =
    await validateMintingClaimReadyForArweaveUpload(claim, contract);
  const imageLocationUrl = await uploadImageToArweaveOrThrow(claim, imageUrl);
  const animationLocationUrl = await uploadAnimationToArweaveIfPresent(claim);
  const metadataLocationUrl = await uploadClaimMetadataToArweave(
    contract,
    claim,
    imageLocationUrl,
    animationLocationUrl,
    typeMemeId,
    seasonValue
  );
  return {
    imageLocationUrl,
    animationLocationUrl,
    metadataLocationUrl
  };
}
