import type { MemeClaimRow } from '@/api/memes-minting/api.memes-minting.db';
import {
  fetchMaxSeasonId,
  fetchMemeIdByMemeName
} from '@/api/memes-minting/api.memes-minting.db';
import { arweaveFileUploader } from '@/arweave';
import { BadRequestException } from '@/exceptions';
import { fetchPublicUrlToBuffer } from '@/http/safe-fetch';
import { Logger } from '@/logging';

const logger = Logger.get('claims-media-arweave-upload');
export const MIN_EDITION_SIZE = 300;

const FETCH_MEDIA_TIMEOUT_MS = 60_000;
const MAX_ARWEAVE_UPLOAD_BYTES = 100 * 1024 * 1024;
const ARWEAVE_METADATA_CREATED_BY = '6529 Collections';
const ARWEAVE_METADATA_EXTERNAL_URL_BASE = 'https://6529.io/the-memes';
const ARWEAVE_POINTS_TRAIT_PREFIX = 'Points - ';
const TYPE_MEME_TRAIT = 'Type - Meme';
const TYPE_SEASON_TRAIT = 'Type - Season';
const TYPE_CARD_TRAIT = 'Type - Card';
const MEME_NAME_TRAIT = 'Meme Name';
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

async function uploadImageToArweaveOrThrow(imageUrl: string): Promise<string> {
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
  const { url } = await arweaveFileUploader.uploadFile(
    fetched.buffer,
    contentType
  );
  return url;
}

async function uploadAnimationToArweaveIfPresent(
  claim: MemeClaimRow
): Promise<string | null> {
  const animationUrl = claim.animation_url?.trim() || null;
  if (animationUrl === null || animationUrl === '') return null;

  const details =
    parseJsonOrNull<{ format?: string }>(claim.animation_details) ?? null;
  if (details?.format === 'HTML') return null;

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
  let contentTypeToUpload = contentType;
  if (expectsGlb) {
    const isValidGlb =
      contentType === 'model/gltf-binary' ||
      (hasGenericContentType && lowerPath.endsWith('.glb'));
    if (!isValidGlb) {
      throw new BadRequestException(
        `animation_url did not resolve to a GLB (content-type: ${contentType})`
      );
    }
    contentTypeToUpload = 'model/gltf-binary';
  } else {
    const isValidVideo =
      contentType.startsWith('video/') ||
      (hasGenericContentType &&
        (lowerPath.endsWith('.mp4') || lowerPath.endsWith('.mov')));
    if (!isValidVideo) {
      throw new BadRequestException(
        `animation_url did not resolve to a video (content-type: ${contentType})`
      );
    }
    if (hasGenericContentType) {
      if (lowerPath.endsWith('.mp4')) {
        contentTypeToUpload = 'video/mp4';
      } else if (lowerPath.endsWith('.mov')) {
        contentTypeToUpload = 'video/quicktime';
      }
    }
  }
  const { url } = await arweaveFileUploader.uploadFile(
    buffer,
    contentTypeToUpload
  );
  return url;
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

function attributesWithTypeTraits(
  rawAttributes: unknown[],
  typeMemeValue: number,
  seasonValue: number,
  memeId: number
): unknown[] {
  const filtered = rawAttributes.filter((a: any) => {
    const tt = a.trait_type ?? a.traitType;
    return (
      tt !== TYPE_MEME_TRAIT &&
      tt !== TYPE_SEASON_TRAIT &&
      tt !== TYPE_CARD_TRAIT
    );
  });
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
    { display_type: 'number', trait_type: TYPE_CARD_TRAIT, value: memeId }
  );
  return filtered;
}

async function uploadClaimMetadataToArweave(
  memeId: number,
  claim: MemeClaimRow,
  imageLocation: string,
  animationLocation: string | null,
  typeMemeId: number
): Promise<string> {
  const rawAttributes = safeParseJson(claim.attributes, [], 'attributes');
  const attributesWithTypes = attributesWithTypeTraits(
    rawAttributes,
    typeMemeId,
    claim.season,
    memeId
  );
  const attributes = normalizeAttributesForArweave(attributesWithTypes);
  const imageDetails =
    parseJsonOrNull<Record<string, unknown>>(claim.image_details) ?? null;
  const animationDetails =
    parseJsonOrNull<Record<string, unknown>>(claim.animation_details) ?? null;
  const htmlAnimationUrl =
    (animationDetails as { format?: string } | null)?.format === 'HTML'
      ? claim.animation_url?.trim() || null
      : null;

  const metadata: Record<string, unknown> = {
    created_by: ARWEAVE_METADATA_CREATED_BY,
    description: claim.description ?? '',
    name: claim.name,
    external_url: `${ARWEAVE_METADATA_EXTERNAL_URL_BASE}/${memeId}`,
    attributes
  };
  if (imageDetails != null) metadata.image_details = imageDetails;
  metadata.image = imageLocation;
  metadata.image_url = imageLocation;
  if (animationLocation != null) {
    metadata.animation = animationLocation;
    metadata.animation_url = animationLocation;
  } else if (htmlAnimationUrl) {
    metadata.animation = htmlAnimationUrl;
    metadata.animation_url = htmlAnimationUrl;
  }
  if (animationDetails != null) metadata.animation_details = animationDetails;

  const buffer = Buffer.from(JSON.stringify(metadata), 'utf8');
  const { url } = await arweaveFileUploader.uploadFile(
    buffer,
    'application/json'
  );
  return url;
}

function validateAttributes(raw: unknown): string[] {
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
  const hasMemeName = raw.some(
    (a: any) => (a.trait_type ?? a.traitType) === MEME_NAME_TRAIT
  );
  if (!hasMemeName) issues.push('Meme Name Attribute');
  return issues;
}

export async function validateMemeClaimReadyForArweaveUpload(
  claim: MemeClaimRow
): Promise<{ imageUrl: string; typeMemeId: number }> {
  const missing: string[] = [];
  const invalid: string[] = [];
  const imageUrl = claim.image_url?.trim() || null;
  if (imageUrl === null || imageUrl === '') missing.push('Image URL');

  const editionSize =
    claim.edition_size == null ? null : Number(claim.edition_size);
  if (editionSize == null) {
    missing.push('Edition Size');
  } else if (!Number.isInteger(editionSize) || editionSize < MIN_EDITION_SIZE) {
    invalid.push(`Edition Size (must be an integer >= ${MIN_EDITION_SIZE})`);
  }

  const name = claim.name?.trim() ?? '';
  if (name === '') missing.push('Name');

  const description = claim.description?.trim();
  if (description == null || description === '') missing.push('Description');

  if (claim.season == null) {
    missing.push('Season');
  } else {
    const season = Number(claim.season);
    const maxSeasonId = await fetchMaxSeasonId();
    const requiredMinSeason = Math.max(1, maxSeasonId);
    if (
      !Number.isInteger(season) ||
      season < requiredMinSeason ||
      season > requiredMinSeason + 1
    ) {
      invalid.push(
        `Season (must be ${requiredMinSeason} or ${requiredMinSeason + 1}; current max season is ${maxSeasonId}, got ${claim.season})`
      );
    }
  }

  const rawAttributes = parseJsonOrNull<unknown>(claim.attributes);
  missing.push(...validateAttributes(rawAttributes));

  let typeMemeId: number | null = null;
  if (missing.length === 0) {
    const memeName = getMemeNameFromAttributes(rawAttributes);
    typeMemeId = await fetchMemeIdByMemeName(memeName);
    if (typeMemeId === null) {
      throw new BadRequestException(
        `No meme found in memes_extended_data for Meme Name "${memeName}"; cannot upload to Arweave`
      );
    }
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
  return { imageUrl: imageUrl as string, typeMemeId: typeMemeId as number };
}

export async function uploadMemeClaimToArweave(
  memeId: number,
  claim: MemeClaimRow
): Promise<{
  imageLocationUrl: string;
  animationLocationUrl: string | null;
  metadataLocationUrl: string;
}> {
  const { imageUrl, typeMemeId } =
    await validateMemeClaimReadyForArweaveUpload(claim);
  const imageLocationUrl = await uploadImageToArweaveOrThrow(imageUrl);
  const animationLocationUrl = await uploadAnimationToArweaveIfPresent(claim);
  const metadataLocationUrl = await uploadClaimMetadataToArweave(
    memeId,
    claim,
    imageLocationUrl,
    animationLocationUrl,
    typeMemeId
  );
  return {
    imageLocationUrl,
    animationLocationUrl,
    metadataLocationUrl
  };
}
