import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import type { MemeClaim } from '@/api/generated/models/MemeClaim';
import type { MemeClaimImageDetails } from '@/api/generated/models/MemeClaimImageDetails';
import type { MemeClaimUpdateRequest } from '@/api/generated/models/MemeClaimUpdateRequest';
import type { MemesMintingClaimsPageResponse } from '@/api/generated/models/MemesMintingClaimsPageResponse';
import type { MemesMintingProofsByAddressResponse } from '@/api/generated/models/MemesMintingProofsByAddressResponse';
import type { MemesMintingProofsResponse } from '@/api/generated/models/MemesMintingProofsResponse';
import type { MemesMintingRootsResponse } from '@/api/generated/models/MemesMintingRootsResponse';
import {
  fetchMemeClaimByMemeId,
  fetchMemeClaimsPage,
  fetchMemeClaimsTotalCount,
  fetchMemeIdByMemeName,
  fetchAllMintingMerkleProofsForRoot,
  fetchMintingMerkleProofs,
  fetchMintingMerkleRoots,
  type MemeClaimRow,
  updateMemeClaim
} from '@/api/memes-minting/api.memes-minting.db';
import { patchMemeClaim } from '@/api/memes-minting/api.memes-minting.service';
import { cacheRequest } from '@/api/request-cache';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import {
  getAuthenticatedWalletOrNull,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import { DISTRIBUTION_ADMIN_WALLETS } from '@/constants';
import {
  BadRequestException,
  ForbiddenException,
  CustomApiCompliantException
} from '@/exceptions';
import { arweaveFileUploader } from '@/arweave';
import { fetchPublicUrlToBuffer } from '@/http/safe-fetch';
import { numbers } from '@/numbers';
import { equalIgnoreCase } from '@/strings';
import { Request, Response } from 'express';
import * as Joi from 'joi';

const router = asyncRouter();

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const MERKLE_ROOT_RE = /^0x[a-fA-F0-9]{64}$/;

function isDistributionAdmin(req: Request): boolean {
  const wallet = getAuthenticatedWalletOrNull(req);
  return !!(
    wallet && DISTRIBUTION_ADMIN_WALLETS.some((a) => equalIgnoreCase(a, wallet))
  );
}

function parseJsonOrNull<T>(value: unknown): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  if (typeof value === 'object') return value as T;
  return null;
}

function parseJsonOrDefault<T>(value: unknown, fallback: T): T {
  const parsed = parseJsonOrNull<T>(value);
  return parsed == null ? fallback : parsed;
}

function parseJsonArrayOrDefault<T>(value: unknown, fallback: T[]): T[] {
  const parsed = parseJsonOrNull<unknown>(value);
  return Array.isArray(parsed) ? (parsed as T[]) : fallback;
}

function isMemeClaimImageDetails(
  value: unknown
): value is MemeClaimImageDetails {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  return (
    typeof v.bytes === 'number' &&
    typeof v.format === 'string' &&
    typeof v.sha256 === 'string' &&
    typeof v.width === 'number' &&
    typeof v.height === 'number'
  );
}

function isMemeClaimAnimationDetails(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as any;
  if (v.format === 'HTML') return true;
  if (v.format === 'GLB') {
    return (
      typeof v.bytes === 'number' &&
      typeof v.sha256 === 'string' &&
      typeof v.format === 'string'
    );
  }
  return (
    typeof v.bytes === 'number' &&
    typeof v.format === 'string' &&
    typeof v.duration === 'number' &&
    typeof v.sha256 === 'string' &&
    typeof v.width === 'number' &&
    typeof v.height === 'number' &&
    Array.isArray(v.codecs)
  );
}

function rowToMemeClaim(row: MemeClaimRow): MemeClaim {
  const arweaveSyncedAt =
    row.arweave_synced_at == null ? undefined : Number(row.arweave_synced_at);
  const editionSize =
    row.edition_size == null ? undefined : Number(row.edition_size);
  const imageDetailsRaw = parseJsonOrNull<unknown>(row.image_details);
  const animationDetailsRaw = parseJsonOrNull<unknown>(row.animation_details);
  return {
    drop_id: row.drop_id,
    meme_id: row.meme_id,
    season: row.season,
    image_location: row.image_location ?? undefined,
    animation_location: row.animation_location ?? undefined,
    metadata_location: row.metadata_location ?? undefined,
    arweave_synced_at: arweaveSyncedAt,
    edition_size: editionSize,
    description: row.description,
    name: row.name,
    image_url: row.image_url ?? undefined,
    attributes: parseJsonArrayOrDefault(row.attributes, []),
    image_details:
      imageDetailsRaw && isMemeClaimImageDetails(imageDetailsRaw)
        ? imageDetailsRaw
        : undefined,
    animation_url: row.animation_url ?? undefined,
    animation_details:
      animationDetailsRaw && isMemeClaimAnimationDetails(animationDetailsRaw)
        ? (animationDetailsRaw as any)
        : undefined
  };
}

type ProofsParams = {
  merkle_root: string;
};

type ProofsQuery = {
  address?: string;
};

type RootsParams = {
  contract: string;
  card_id: string;
};

const ProofsParamsSchema: Joi.ObjectSchema<ProofsParams> = Joi.object({
  merkle_root: Joi.string().trim().pattern(MERKLE_ROOT_RE).required().messages({
    'string.pattern.base':
      'merkle_root must be a 0x-prefixed 66-character hex string'
  })
});

const ProofsQuerySchema: Joi.ObjectSchema<ProofsQuery> = Joi.object({
  address: Joi.string().trim().pattern(ETH_ADDRESS_RE).optional().messages({
    'string.pattern.base': 'address must be a 0x-prefixed 42-character hex'
  })
});

const RootsParamsSchema: Joi.ObjectSchema<RootsParams> = Joi.object({
  contract: Joi.string().trim().pattern(ETH_ADDRESS_RE).required().messages({
    'string.pattern.base': 'contract must be a 0x-prefixed 42-character hex'
  }),
  card_id: Joi.string().trim().required().pattern(/^\d+$/)
});

router.get(
  '/proofs/:merkle_root',
  maybeAuthenticatedUser(),
  cacheRequest({
    key: (req) => {
      const merkleRoot = (req.params as any)?.merkle_root ?? 'unknown';
      if (typeof merkleRoot !== 'string' || !MERKLE_ROOT_RE.test(merkleRoot)) {
        return null;
      }
      const rawAddress = (req.query as any)?.address;
      if (typeof rawAddress === 'string' && rawAddress.trim().length > 0) {
        const trimmed = rawAddress.trim();
        if (!ETH_ADDRESS_RE.test(trimmed)) return null;
        return `memes-minting:proofs:${merkleRoot}:${rawAddress.trim().toLowerCase()}`;
      }
      return `memes-minting:proofs:${merkleRoot}:all:${isDistributionAdmin(req)}`;
    }
  }),
  async function (
    req: Request<ProofsParams, any, any, ProofsQuery, any>,
    res: Response<
      ApiResponse<
        MemesMintingProofsResponse | MemesMintingProofsByAddressResponse
      >
    >
  ) {
    const params = getValidatedByJoiOrThrow(req.params, ProofsParamsSchema);
    const query = getValidatedByJoiOrThrow(req.query, ProofsQuerySchema);
    const merkleRoot = params.merkle_root;

    if (query.address) {
      const proofs = await fetchMintingMerkleProofs(merkleRoot, query.address);
      if (proofs === null) {
        return res.status(404).json({
          error: 'No proofs found for the given merkle_root and address'
        });
      }
      const response: MemesMintingProofsResponse = {
        proofs: proofs.map((p) => ({
          merkle_proof: p.merkleProof,
          value: p.value
        }))
      };
      return res.json(response);
    }

    if (!isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can list all proofs for a merkle_root'
      );
    }
    const allRows = await fetchAllMintingMerkleProofsForRoot(merkleRoot);
    if (allRows.length === 0) {
      return res.status(404).json({
        error: 'No proofs found for the given merkle_root'
      });
    }
    const response: MemesMintingProofsByAddressResponse = {
      proofs_by_address: allRows.map((r) => ({
        address: r.address,
        proofs: r.proofs.map((p) => ({
          merkle_proof: p.merkleProof,
          value: p.value
        }))
      }))
    };
    return res.json(response);
  }
);

router.get(
  '/roots/:contract/:card_id',
  cacheRequest(),
  async function (
    req: Request<RootsParams, any, any, any, any>,
    res: Response<ApiResponse<MemesMintingRootsResponse>>
  ) {
    const params = getValidatedByJoiOrThrow(req.params, RootsParamsSchema);
    const cardId = numbers.parseIntOrNull(params.card_id);
    if (cardId === null || cardId < 0) {
      return res.status(400).json({
        error: 'card_id must be a non-negative integer'
      });
    }
    const rows = await fetchMintingMerkleRoots(cardId, params.contract);
    const response: MemesMintingRootsResponse = {
      roots: rows.map((r) => ({ phase: r.phase, merkle_root: r.merkle_root }))
    };
    return res.json(response);
  }
);

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 20;

const ClaimsListQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  page_size: Joi.number()
    .integer()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
});

router.get(
  '/claims',
  needsAuthenticatedUser(),
  cacheRequest({
    key: (req) => {
      const page = (req.query as any)?.page ?? '';
      const pageSize = (req.query as any)?.page_size ?? '';
      if (
        (typeof page === 'string' && page.length > 16) ||
        (typeof pageSize === 'string' && pageSize.length > 16)
      ) {
        return null;
      }
      return `memes-minting:claims:${isDistributionAdmin(req)}:${String(page)}:${String(pageSize)}`;
    }
  }),
  async function (
    req: Request<any, any, any, { page?: string; page_size?: string }, any>,
    res: Response<ApiResponse<MemesMintingClaimsPageResponse>>
  ) {
    if (!isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can access meme claims'
      );
    }
    const query = getValidatedByJoiOrThrow(
      {
        page: req.query.page == null ? undefined : Number(req.query.page),
        page_size:
          req.query.page_size == null ? undefined : Number(req.query.page_size)
      },
      ClaimsListQuerySchema
    );
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;
    const [rows, total] = await Promise.all([
      fetchMemeClaimsPage(pageSize, offset),
      fetchMemeClaimsTotalCount()
    ]);
    const response: MemesMintingClaimsPageResponse = {
      claims: rows.map(rowToMemeClaim),
      count: total,
      page,
      page_size: pageSize,
      next: page * pageSize < total
    };
    return res.json(response);
  }
);

type ClaimMemeIdParams = { meme_id: string };

const ClaimMemeIdParamsSchema: Joi.ObjectSchema<ClaimMemeIdParams> = Joi.object(
  {
    meme_id: Joi.string().trim().required().pattern(/^\d+$/)
  }
);

const MemeClaimAttributeSchema = Joi.object({
  trait_type: Joi.string().trim().min(1).required(),
  value: Joi.alternatives().try(Joi.string(), Joi.number()).required(),
  display_type: Joi.string().optional(),
  max_value: Joi.number().optional()
}).unknown(false);

const MemeClaimUpdateRequestSchema = Joi.object({
  season: Joi.number().integer().min(1),
  image_location: Joi.string().allow(null),
  animation_location: Joi.string().allow(null),
  metadata_location: Joi.string().allow(null),
  edition_size: Joi.number().integer().min(1).allow(null),
  description: Joi.string(),
  name: Joi.string(),
  image_url: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .allow(null),
  attributes: Joi.array().items(MemeClaimAttributeSchema),
  animation_url: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .allow(null)
}).unknown(false);

router.get(
  '/claims/:meme_id',
  needsAuthenticatedUser(),
  cacheRequest({
    key: (req) => {
      const memeId = (req.params as any)?.meme_id ?? 'unknown';
      if (typeof memeId !== 'string' || !/^\d+$/.test(memeId)) return null;
      return `memes-minting:claim:${String(memeId)}:${isDistributionAdmin(req)}`;
    }
  }),
  async function (
    req: Request<ClaimMemeIdParams, any, any, any, any>,
    res: Response<ApiResponse<MemeClaim>>
  ) {
    if (!isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can access meme claims'
      );
    }
    const params = getValidatedByJoiOrThrow(
      req.params,
      ClaimMemeIdParamsSchema
    );
    const memeId = Number.parseInt(params.meme_id, 10);
    const row = await fetchMemeClaimByMemeId(memeId);
    if (row) {
      return res.json(rowToMemeClaim(row));
    }
    return res.status(404).json({ error: 'Claim not found' });
  }
);

router.patch(
  '/claims/:meme_id',
  needsAuthenticatedUser(),
  async function (
    req: Request<ClaimMemeIdParams, any, MemeClaimUpdateRequest, any, any>,
    res: Response<ApiResponse<MemeClaim>>
  ) {
    if (!isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can update meme claims'
      );
    }
    const params = getValidatedByJoiOrThrow(
      req.params,
      ClaimMemeIdParamsSchema
    );
    const memeId = Number.parseInt(params.meme_id, 10);
    const body = getValidatedByJoiOrThrow(
      req.body ?? {},
      MemeClaimUpdateRequestSchema
    );
    const updated = await patchMemeClaim(memeId, body);
    if (updated === null) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    return res.json(rowToMemeClaim(updated));
  }
);

function arweaveTxIdFromUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return trimmed;
  }
  try {
    const u = new URL(trimmed);
    if (u.hostname.toLowerCase() === 'arweave.net') {
      const first = u.pathname.split('/').filter(Boolean)[0];
      return first ?? trimmed;
    }
  } catch {
    // ignore
  }
  const base = 'https://arweave.net/';
  return trimmed.startsWith(base) ? trimmed.slice(base.length) : trimmed;
}

const FETCH_MEDIA_TIMEOUT_MS = 60_000;
const MAX_ARWEAVE_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB

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
  const buffer = fetched.buffer;
  const { url } = await arweaveFileUploader.uploadFile(buffer, contentType);
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
  if (expectsGlb) {
    const ok =
      contentType === 'model/gltf-binary' || lowerPath.endsWith('.glb');
    if (!ok) {
      throw new BadRequestException(
        `animation_url did not resolve to a GLB (content-type: ${contentType})`
      );
    }
  } else {
    const ok =
      contentType.startsWith('video/') ||
      lowerPath.endsWith('.mp4') ||
      lowerPath.endsWith('.mov');
    if (!ok) {
      throw new BadRequestException(
        `animation_url did not resolve to a video (content-type: ${contentType})`
      );
    }
  }
  const { url } = await arweaveFileUploader.uploadFile(buffer, contentType);
  return url;
}

const ARWEAVE_METADATA_CREATED_BY = '6529 Collections';
const ARWEAVE_METADATA_EXTERNAL_URL_BASE = 'https://6529.io/the-memes';

const ARWEAVE_POINTS_TRAIT_PREFIX = 'Points - ';
const ARWEAVE_TYPE_NUMBER_TRAITS = new Set([
  'Type - Meme',
  'Type - Season',
  'Type - Card'
]);

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

const TYPE_MEME_TRAIT = 'Type - Meme';
const TYPE_SEASON_TRAIT = 'Type - Season';
const TYPE_CARD_TRAIT = 'Type - Card';
const MEME_NAME_TRAIT = 'Meme Name';

function getMemeNameFromAttributes(attributes: unknown): string {
  if (!Array.isArray(attributes))
    throw new BadRequestException('Claim has no attributes');
  const memeNameAttr = attributes.find(
    (a: any) => (a.trait_type ?? a.traitType) === MEME_NAME_TRAIT
  );
  const value = memeNameAttr?.value;
  if (value == null || typeof value !== 'string' || value.trim() === '')
    throw new BadRequestException(
      `Claim has no "Meme Name" attribute; cannot resolve Type - Meme for Arweave upload`
    );
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
  animationLocation: string | null
): Promise<string> {
  const rawAttributes = parseJsonOrNull<unknown>(claim.attributes);
  if (!Array.isArray(rawAttributes)) {
    throw new BadRequestException('Claim attributes must be an array');
  }
  const memeName = getMemeNameFromAttributes(rawAttributes);
  const typeMemeId = await fetchMemeIdByMemeName(memeName);
  if (typeMemeId === null)
    throw new BadRequestException(
      `No meme found in memes_extended_data for Meme Name "${memeName}"; cannot upload to Arweave`
    );
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
    (animationDetails as any)?.format === 'HTML'
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

router.post(
  '/claims/:meme_id/arweave-upload',
  needsAuthenticatedUser(),
  async function (
    req: Request<ClaimMemeIdParams, any, any, any, any>,
    res: Response<ApiResponse<MemeClaim>>
  ) {
    if (!isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can upload meme claims to Arweave'
      );
    }
    const params = getValidatedByJoiOrThrow(
      req.params,
      ClaimMemeIdParamsSchema
    );
    const memeId = Number.parseInt(params.meme_id, 10);
    const claim = await fetchMemeClaimByMemeId(memeId);
    if (claim === null) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    if (claim.arweave_synced_at != null) {
      throw new CustomApiCompliantException(
        409,
        'Claim already synced to Arweave'
      );
    }
    const missing: string[] = [];
    const imageUrl = claim.image_url?.trim() || null;
    if (imageUrl === null || imageUrl === '') missing.push('image_url');
    const editionSize =
      claim.edition_size == null ? null : Number(claim.edition_size);
    if (
      editionSize == null ||
      !Number.isInteger(editionSize) ||
      editionSize < 1
    )
      missing.push('edition_size');
    const name = claim.name?.trim() ?? '';
    if (name === '') missing.push('name');
    const description = claim.description?.trim();
    if (description == null || description === '') missing.push('description');
    if (
      claim.season == null ||
      claim.season === undefined ||
      !Number.isInteger(Number(claim.season)) ||
      Number(claim.season) < 1
    )
      missing.push('season');
    const rawAttrs = parseJsonOrNull<unknown>(claim.attributes);
    if (rawAttrs == null) missing.push('attributes (invalid JSON)');
    if (rawAttrs != null && !Array.isArray(rawAttrs))
      missing.push('attributes (must be an array)');
    if (Array.isArray(rawAttrs)) {
      const hasInvalidItems = rawAttrs.some((a: any) => {
        const traitType = a?.trait_type ?? a?.traitType;
        return (
          typeof traitType !== 'string' ||
          traitType.trim() === '' ||
          a?.value === undefined ||
          a?.value === null
        );
      });
      if (hasInvalidItems) missing.push('attributes (invalid items)');
      const hasMemeName = rawAttrs.some(
        (a: any) => (a.trait_type ?? a.traitType) === MEME_NAME_TRAIT
      );
      if (!hasMemeName) missing.push('Meme Name attribute');
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing required fields for Arweave upload: ${missing.join(', ')}. Only animation is optional.`
      );
    }
    if (imageUrl === null) {
      throw new Error('image_url unexpectedly null after validation');
    }
    let imageLocation: string;
    let animationLocation: string | null;
    let metadataLocation: string;
    try {
      imageLocation = await uploadImageToArweaveOrThrow(imageUrl);
      animationLocation = await uploadAnimationToArweaveIfPresent(claim);
      metadataLocation = await uploadClaimMetadataToArweave(
        memeId,
        claim,
        imageLocation,
        animationLocation
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Arweave upload failed';
      const isClientError =
        message.includes('Invalid URL') ||
        message.includes('Unsupported URL protocol') ||
        message.includes('Forbidden') ||
        message.includes('Response too large') ||
        message.includes('exceeded max size') ||
        message.includes('did not resolve to an image');
      return res.status(isClientError ? 400 : 500).json({ error: message });
    }
    await updateMemeClaim(memeId, {
      image_location: arweaveTxIdFromUrl(imageLocation),
      animation_location: animationLocation
        ? arweaveTxIdFromUrl(animationLocation)
        : null,
      metadata_location: arweaveTxIdFromUrl(metadataLocation),
      arweave_synced_at: Date.now()
    });
    const updated = await fetchMemeClaimByMemeId(memeId);
    return res.json(rowToMemeClaim(updated!));
  }
);

export default router;
