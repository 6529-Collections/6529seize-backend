import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import type { MemeClaim } from '@/api/generated/models/MemeClaim';
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
  needsAuthenticatedUser
} from '@/api/auth/auth';
import { DISTRIBUTION_ADMIN_WALLETS } from '@/constants';
import {
  BadRequestException,
  ForbiddenException,
  CustomApiCompliantException
} from '@/exceptions';
import { arweaveFileUploader } from '@/arweave';
import { numbers } from '@/numbers';
import { equalIgnoreCase } from '@/strings';
import { Request, Response } from 'express';
import * as Joi from 'joi';
import fetch from 'node-fetch';

const router = asyncRouter();

function isDistributionAdmin(req: Request): boolean {
  const wallet = getAuthenticatedWalletOrNull(req);
  return !!(
    wallet && DISTRIBUTION_ADMIN_WALLETS.some((a) => equalIgnoreCase(a, wallet))
  );
}

function rowToMemeClaim(row: MemeClaimRow): MemeClaim {
  const arweaveSyncedAt =
    row.arweave_synced_at == null ? undefined : Number(row.arweave_synced_at);
  const editionSize =
    row.edition_size == null ? undefined : Number(row.edition_size);
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
    attributes: JSON.parse(row.attributes),
    image_details: row.image_details
      ? JSON.parse(row.image_details)
      : undefined,
    animation_url: row.animation_url ?? undefined,
    animation_details: row.animation_details
      ? JSON.parse(row.animation_details)
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
  merkle_root: Joi.string()
    .trim()
    .pattern(/^0x[a-fA-F0-9]{64}$/)
    .required()
    .messages({
      'string.pattern.base':
        'merkle_root must be a 0x-prefixed 66-character hex string'
    })
});

const ProofsQuerySchema: Joi.ObjectSchema<ProofsQuery> = Joi.object({
  address: Joi.string().trim().optional()
});

const RootsParamsSchema: Joi.ObjectSchema<RootsParams> = Joi.object({
  contract: Joi.string().trim().required(),
  card_id: Joi.string().trim().required()
});

router.get(
  '/proofs/:merkle_root',
  cacheRequest(),
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
  cacheRequest(),
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

router.get(
  '/claims/:meme_id',
  needsAuthenticatedUser(),
  cacheRequest(),
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
    const body = req.body ?? {};
    const updated = await patchMemeClaim(memeId, body);
    if (updated === null) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    return res.json(rowToMemeClaim(updated));
  }
);

function arweaveTxIdFromUrl(url: string): string {
  const base = 'https://arweave.net/';
  return url.startsWith(base) ? url.slice(base.length) : url;
}

const FETCH_IMAGE_TIMEOUT_MS = 60_000;

async function fetchUrlToBuffer(
  url: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(`Fetch timed out after ${FETCH_IMAGE_TIMEOUT_MS}ms: ${url}`)
        ),
      FETCH_IMAGE_TIMEOUT_MS
    )
  );
  const fetchPromise = fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; 6529ArweaveUpload/1.0; +https://6529.io)',
      Accept: 'image/*,*/*;q=0.8'
    }
  });
  const res = await Promise.race([fetchPromise, timeoutPromise]);
  if (res.ok) {
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType =
      res.headers.get('content-type')?.split(';')[0]?.trim() ||
      'application/octet-stream';
    return { buffer, contentType };
  }
  throw new Error(`Fetch failed: ${res.status} ${url}`);
}

async function uploadImageToArweaveOrThrow(imageUrl: string): Promise<string> {
  const { buffer, contentType } = await fetchUrlToBuffer(imageUrl);
  const { url } = await arweaveFileUploader.uploadFile(buffer, contentType);
  return url;
}

async function uploadAnimationToArweaveIfPresent(
  claim: MemeClaimRow
): Promise<string | null> {
  const animationUrl = claim.animation_url?.trim() || null;
  if (animationUrl === null || animationUrl === '') return null;
  const details = claim.animation_details
    ? (JSON.parse(claim.animation_details) as { format?: string })
    : null;
  if (details?.format === 'HTML') return null;
  const { buffer, contentType } = await fetchUrlToBuffer(animationUrl);
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
  const rawAttributes = JSON.parse(claim.attributes) as unknown;
  if (!Array.isArray(rawAttributes))
    throw new BadRequestException('Claim attributes must be an array');
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
  const imageDetails = claim.image_details
    ? (JSON.parse(claim.image_details) as Record<string, unknown>)
    : null;
  const animationDetails = claim.animation_details
    ? (JSON.parse(claim.animation_details) as Record<string, unknown>)
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
    let rawAttrs: unknown;
    try {
      rawAttrs = JSON.parse(claim.attributes);
    } catch {
      missing.push('attributes (invalid JSON)');
    }
    if (rawAttrs != null && !Array.isArray(rawAttrs))
      missing.push('attributes (must be an array)');
    if (Array.isArray(rawAttrs)) {
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
      return res.status(500).json({ error: message });
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
