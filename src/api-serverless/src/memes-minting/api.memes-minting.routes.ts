import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticatedWalletOrNull,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import type { MemeClaim } from '@/api/generated/models/MemeClaim';
import type { ApiMemesMintingAirdropItem } from '@/api/generated/models/ApiMemesMintingAirdropItem';
import type { MemeClaimUpdateRequest } from '@/api/generated/models/MemeClaimUpdateRequest';
import type { MemesMintingClaimsPageResponse } from '@/api/generated/models/MemesMintingClaimsPageResponse';
import type { MemesMintingProofsByAddressResponse } from '@/api/generated/models/MemesMintingProofsByAddressResponse';
import type { MemesMintingProofsResponse } from '@/api/generated/models/MemesMintingProofsResponse';
import type { MemesMintingRootItem } from '@/api/generated/models/MemesMintingRootItem';
import {
  fetchAllMintingMerkleProofsForRoot,
  fetchMemeClaimByMemeId,
  fetchMemeClaimsPage,
  fetchMemeClaimsTotalCount,
  fetchMintingAirdrops,
  fetchMintingMerkleProofs,
  fetchMintingMerkleRoots,
  type MemeClaimRow,
  updateMemeClaim,
  updateMemeClaimIfNotUploading
} from '@/api/memes-minting/api.memes-minting.db';
import { patchMemeClaim } from '@/api/memes-minting/api.memes-minting.service';
import { enqueueClaimMediaArweaveUpload } from '@/api/memes-minting/claims-media-arweave-upload-publisher';
import { cacheRequest } from '@/api/request-cache';
import { getDistributionAdminWallets } from '@/api/seize-settings';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { Logger } from '@/logging';
import {
  MIN_EDITION_SIZE,
  validateMemeClaimReadyForArweaveUpload
} from '@/meme-claims/claims-media-arweave-upload';
import { numbers } from '@/numbers';
import { getCacheKeyPatternForPath } from '@/api/api-helpers';
import { evictAllKeysMatchingPatternFromRedisCache } from '@/redis';
import { equalIgnoreCase } from '@/strings';
import { NextFunction, Request, Response } from 'express';
import * as Joi from 'joi';

const router = asyncRouter();
const logger = Logger.get('api.memes-minting.routes');

function isDistributionAdmin(req: Request): boolean {
  const wallet = getAuthenticatedWalletOrNull(req);
  return !!(
    wallet &&
    getDistributionAdminWallets().some((a) => equalIgnoreCase(a, wallet))
  );
}

function safeParseJson<T>(raw: string | null, fallback: T, label: string): T {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    Logger.get('api.memes-minting.routes').warn(`Failed to parse ${label}`, {
      raw: raw.slice(0, 200),
      err
    });
    return fallback;
  }
}

async function evictMemesMintingClaimCache(memeId: number): Promise<void> {
  const patterns = [
    getCacheKeyPatternForPath(`/api/memes-minting/claims/${memeId}*`),
    getCacheKeyPatternForPath('/api/memes-minting/claims*')
  ];
  for (const pattern of patterns) {
    try {
      await evictAllKeysMatchingPatternFromRedisCache(pattern);
    } catch (error) {
      logger.warn('Failed to evict memes-minting cache pattern', {
        pattern,
        memeId,
        error
      });
    }
  }
}

function rowToMemeClaim(row: MemeClaimRow): MemeClaim {
  const editionSize =
    row.edition_size == null ? undefined : Number(row.edition_size);
  return {
    drop_id: row.drop_id,
    meme_id: row.meme_id,
    season: row.season,
    image_location: row.image_location ?? undefined,
    animation_location: row.animation_location ?? undefined,
    metadata_location: row.metadata_location ?? undefined,
    media_uploading: !!row.media_uploading,
    edition_size: editionSize,
    description: row.description,
    name: row.name,
    image_url: row.image_url ?? undefined,
    attributes: safeParseJson(row.attributes, [], 'attributes'),
    image_details: safeParseJson(row.image_details, undefined, 'image_details'),
    animation_url: row.animation_url ?? undefined,
    animation_details: safeParseJson(
      row.animation_details,
      undefined,
      'animation_details'
    )
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
  address: Joi.string()
    .trim()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .optional()
    .messages({
      'string.pattern.base':
        'address must be a 0x-prefixed 42-character hex string'
    })
});

const RootsParamsSchema: Joi.ObjectSchema<RootsParams> = Joi.object({
  contract: Joi.string()
    .trim()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required()
    .messages({
      'string.pattern.base':
        'contract must be a 0x-prefixed 42-character hex string'
    }),
  card_id: Joi.string().trim().required().pattern(/^\d+$/)
});

const PHASE_AIRDROP_RESPONSE_ORDER: ReadonlyArray<{
  response_phase: string;
  db_phase: string;
}> = [
  { response_phase: 'Automatic', db_phase: 'Airdrop' },
  { response_phase: 'Phase 0', db_phase: 'Phase 0' },
  { response_phase: 'Phase 1', db_phase: 'Phase 1' },
  { response_phase: 'Phase 2', db_phase: 'Phase 2' },
  { response_phase: 'Public', db_phase: 'Public' }
];

router.get(
  '/proofs/:merkle_root',
  maybeAuthenticatedUser(),
  cacheRequest({ authDependent: true }),
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

    if (!query.address && !isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can list all proofs for a merkle root'
      );
    }

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
    res: Response<ApiResponse<MemesMintingRootItem[]>>
  ) {
    const params = getValidatedByJoiOrThrow(req.params, RootsParamsSchema);
    const cardId = numbers.parseIntOrNull(params.card_id);
    if (cardId === null || cardId < 0) {
      return res.status(400).json({
        error: 'card_id must be a non-negative integer'
      });
    }
    const rows = await fetchMintingMerkleRoots(cardId, params.contract);
    const response: MemesMintingRootItem[] = rows.map((r) => ({
      phase: r.phase,
      merkle_root: r.merkle_root,
      addresses_count: r.addresses_count ?? 0,
      total_spots: r.total_spots ?? 0
    }));
    return res.json(response);
  }
);

router.get(
  '/airdrops/:contract/:card_id',
  async function (
    req: Request<RootsParams, any, any, any, any>,
    res: Response<ApiResponse<ApiMemesMintingAirdropItem[]>>
  ) {
    const params = getValidatedByJoiOrThrow(req.params, RootsParamsSchema);
    const cardId = numbers.parseIntOrNull(params.card_id);
    if (cardId === null || cardId < 0) {
      return res.status(400).json({
        error: 'card_id must be a non-negative integer'
      });
    }

    const rows = await fetchMintingAirdrops(cardId, params.contract);
    const totalsByDbPhase = new Map(
      rows.map((row) => [
        row.phase.toLowerCase(),
        {
          addresses_count: row.addresses_count ?? 0,
          total_airdrops: row.total_airdrops ?? 0
        }
      ])
    );

    const response: ApiMemesMintingAirdropItem[] =
      PHASE_AIRDROP_RESPONSE_ORDER.map(({ response_phase, db_phase }) => {
        const totals = totalsByDbPhase.get(db_phase.toLowerCase());
        return {
          phase: response_phase,
          addresses_count: totals?.addresses_count ?? 0,
          total_airdrops: totals?.total_airdrops ?? 0
        };
      });

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
  cacheRequest({ authDependent: true }),
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
  trait_type: Joi.string().required(),
  value: Joi.alternatives()
    .try(Joi.string().allow(''), Joi.number())
    .required(),
  display_type: Joi.string().optional(),
  max_value: Joi.number().optional()
}).custom((attribute: any, helpers) => {
  const value = attribute?.value;
  if (typeof value === 'string' && value.trim() === '') {
    const traitType =
      typeof attribute?.trait_type === 'string' && attribute.trait_type !== ''
        ? attribute.trait_type
        : 'unknown';
    const path = (helpers.state.path ?? []).join('.');
    return helpers.message({
      custom: `Invalid attributes entry (${path}): trait_type "${traitType}" has an empty value`
    });
  }
  return attribute;
});

const MemeClaimUpdateRequestSchema = Joi.object({
  season: Joi.number().integer().optional().label('Season'),
  edition_size: Joi.number()
    .integer()
    .min(MIN_EDITION_SIZE)
    .allow(null)
    .optional()
    .label('Edition Size'),
  description: Joi.string().optional(),
  name: Joi.string().optional(),
  image_url: Joi.string().allow(null).optional(),
  attributes: Joi.array().items(MemeClaimAttributeSchema).optional(),
  animation_url: Joi.string().allow(null).optional()
});

async function assertCanStartArweaveUpload(claim: MemeClaimRow): Promise<void> {
  if (claim.metadata_location != null) {
    throw new CustomApiCompliantException(
      409,
      'Claim already synced to Arweave'
    );
  }
  if (claim.media_uploading) {
    throw new CustomApiCompliantException(
      409,
      'Claim media upload is already in progress'
    );
  }
  await validateMemeClaimReadyForArweaveUpload(claim);
}

async function queueArweaveUploadOrRollback(memeId: number): Promise<void> {
  const locked = await updateMemeClaimIfNotUploading(memeId, {
    media_uploading: true
  });
  if (!locked) {
    throw new CustomApiCompliantException(
      409,
      'Claim media upload is already in progress'
    );
  }
  try {
    await enqueueClaimMediaArweaveUpload(memeId);
  } catch (enqueueError) {
    try {
      await updateMemeClaim(memeId, {
        media_uploading: false
      });
    } catch (rollbackError) {
      logger.error('Failed to rollback media_uploading after enqueue error', {
        memeId,
        rollbackError
      });
    }
    throw enqueueError;
  }
}

router.get(
  '/claims/:meme_id',
  needsAuthenticatedUser(),
  cacheRequest({ authDependent: true }),
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
    res: Response<ApiResponse<MemeClaim>>,
    next: NextFunction
  ) {
    try {
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
      await evictMemesMintingClaimCache(memeId);
      return res.json(rowToMemeClaim(updated));
    } catch (error) {
      return next(error);
    }
  }
);

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
    await assertCanStartArweaveUpload(claim);
    await queueArweaveUploadOrRollback(memeId);
    await evictMemesMintingClaimCache(memeId);
    const updated = await fetchMemeClaimByMemeId(memeId);
    return res.json(rowToMemeClaim(updated ?? claim));
  }
);

export default router;
