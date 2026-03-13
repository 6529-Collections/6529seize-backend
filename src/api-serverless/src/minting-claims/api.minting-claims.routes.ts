import { getCacheKeyPatternForPath } from '@/api/api-helpers';
import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticatedWalletOrNull,
  maybeAuthenticatedUser,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import type { ApiMintingClaimsPhaseTotalItem } from '@/api/generated/models/ApiMintingClaimsPhaseTotalItem';
import type { MintingClaim } from '@/api/generated/models/MintingClaim';
import type { MintingClaimUpdateRequest } from '@/api/generated/models/MintingClaimUpdateRequest';
import type { MintingClaimsPageResponse } from '@/api/generated/models/MintingClaimsPageResponse';
import type { MintingClaimsProofsResponse } from '@/api/generated/models/MintingClaimsProofsResponse';
import type { MintingClaimsRootItem } from '@/api/generated/models/MintingClaimsRootItem';
import {
  doesMintingMerkleRootExistForCard,
  fetchMintingAirdrops,
  fetchMintingAllowlists,
  fetchMintingClaimByClaimId,
  fetchMintingClaimsPage,
  fetchMintingClaimsTotalCount,
  fetchMintingMerkleProofs,
  fetchMintingMerkleRoots,
  type MintingClaimRow,
  updateMintingClaim,
  updateMintingClaimIfNotUploading
} from '@/api/minting-claims/api.minting-claims.db';
import mintingClaimActionsRoutes from '@/api/minting-claims/api.minting-claims.actions.routes';
import {
  ContractCardParamsSchema,
  ContractClaimParamsSchema,
  ContractOnlyParamsSchema,
  ProofsPathParamsSchema,
  type ContractCardParams,
  type ContractClaimParams,
  type ProofsPathParams
} from '@/api/minting-claims/minting-claims.validation';
import { patchMintingClaim } from '@/api/minting-claims/api.minting-claims.service';
import { enqueueClaimMediaArweaveUpload } from '@/api/minting-claims/claims-media-arweave-upload-publisher';
import { cacheRequest } from '@/api/request-cache';
import { getDistributionAdminWallets } from '@/api/seize-settings';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import { Logger } from '@/logging';
import {
  MIN_EDITION_SIZE,
  validateMintingClaimReadyForArweaveUpload
} from '@/minting-claims/claims-media-arweave-upload';
import { isMemesContract } from '@/minting-claims/external-url';
import { numbers } from '@/numbers';
import { evictAllKeysMatchingPatternFromRedisCache } from '@/redis';
import { equalIgnoreCase } from '@/strings';
import { NextFunction, Request, Response } from 'express';
import * as Joi from 'joi';

const router = asyncRouter();
const logger = Logger.get('api.minting-claims.routes');

function isDistributionAdmin(req: Request): boolean {
  const wallet = getAuthenticatedWalletOrNull(req);
  return !!(
    wallet &&
    getDistributionAdminWallets().some((adminWallet) =>
      equalIgnoreCase(adminWallet, wallet)
    )
  );
}

function safeParseJson<T>(raw: string | null, fallback: T, label: string): T {
  if (raw == null || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    Logger.get('api.minting-claims.routes').warn(`Failed to parse ${label}`, {
      raw: raw.slice(0, 200),
      err
    });
    return fallback;
  }
}

async function evictMintingClaimCache(
  contract: string,
  claimId: number
): Promise<void> {
  const patterns = [
    getCacheKeyPatternForPath(
      `/api/minting-claims/${contract}/claims/${claimId}*`
    ),
    getCacheKeyPatternForPath(`/api/minting-claims/${contract}/claims*`)
  ];

  for (const pattern of patterns) {
    try {
      await evictAllKeysMatchingPatternFromRedisCache(pattern);
    } catch (error) {
      logger.warn('Failed to evict minting-claims cache pattern', {
        pattern,
        contract,
        claimId,
        error
      });
    }
  }
}

function rowToMintingClaim(row: MintingClaimRow): MintingClaim {
  const editionSize =
    row.edition_size == null ? undefined : Number(row.edition_size);

  return {
    drop_id: row.drop_id,
    contract: row.contract,
    claim_id: row.claim_id,
    image_location: row.image_location ?? undefined,
    animation_location: row.animation_location ?? undefined,
    metadata_location: row.metadata_location ?? undefined,
    media_uploading: !!row.media_uploading,
    edition_size: editionSize,
    description: row.description,
    name: row.name,
    image_url: row.image_url ?? undefined,
    external_url: row.external_url ?? undefined,
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

router.get(
  '/:contract/:card_id/roots',
  cacheRequest(),
  async function (
    req: Request<ContractCardParams, any, any, any, any>,
    res: Response<ApiResponse<MintingClaimsRootItem[]>>
  ) {
    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractCardParamsSchema
    );
    const cardId = numbers.parseIntOrNull(params.card_id);
    if (cardId === null || cardId < 0) {
      return res.status(400).json({
        error: 'card_id must be a non-negative integer'
      });
    }

    const rows = await fetchMintingMerkleRoots(cardId, params.contract);
    const response: MintingClaimsRootItem[] = rows.map((row) => ({
      phase: row.phase,
      merkle_root: row.merkle_root,
      addresses_count: row.addresses_count ?? 0,
      total_spots: row.total_spots ?? 0
    }));

    return res.json(response);
  }
);

router.get(
  '/:contract/:card_id/airdrops',
  async function (
    req: Request<ContractCardParams, any, any, any, any>,
    res: Response<ApiResponse<ApiMintingClaimsPhaseTotalItem[]>>
  ) {
    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractCardParamsSchema
    );
    const cardId = numbers.parseIntOrNull(params.card_id);
    if (cardId === null || cardId < 0) {
      return res.status(400).json({
        error: 'card_id must be a non-negative integer'
      });
    }

    const rows = await fetchMintingAirdrops(cardId, params.contract);
    const response: ApiMintingClaimsPhaseTotalItem[] = rows.map((row) => ({
      phase: row.phase,
      addresses: row.addresses ?? 0,
      total: row.total ?? 0
    }));

    return res.json(response);
  }
);

router.get(
  '/:contract/:card_id/allowlists',
  async function (
    req: Request<ContractCardParams, any, any, any, any>,
    res: Response<ApiResponse<ApiMintingClaimsPhaseTotalItem[]>>
  ) {
    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractCardParamsSchema
    );
    const cardId = numbers.parseIntOrNull(params.card_id);
    if (cardId === null || cardId < 0) {
      return res.status(400).json({
        error: 'card_id must be a non-negative integer'
      });
    }

    const rows = await fetchMintingAllowlists(cardId, params.contract);
    const response: ApiMintingClaimsPhaseTotalItem[] = rows.map((row) => ({
      phase: row.phase,
      addresses: row.addresses ?? 0,
      total: row.total ?? 0
    }));

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

const MintingClaimAttributeSchema = Joi.object({
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

const StrictMintingClaimUpdateRequestSchema = Joi.object({
  edition_size: Joi.number()
    .integer()
    .min(MIN_EDITION_SIZE)
    .allow(null)
    .optional()
    .label('Edition Size'),
  description: Joi.string().optional(),
  name: Joi.string().optional(),
  image_url: Joi.string().allow(null).optional(),
  external_url: Joi.string().allow(null).optional(),
  attributes: Joi.array().items(MintingClaimAttributeSchema).optional(),
  animation_url: Joi.string().allow(null).optional()
});

const RelaxedMintingClaimUpdateRequestSchema = Joi.object({
  edition_size: Joi.number().integer().allow(null).optional(),
  description: Joi.string().allow('').optional(),
  name: Joi.string().allow('').optional(),
  image_url: Joi.string().allow(null, '').optional(),
  external_url: Joi.string().allow(null, '').optional(),
  attributes: Joi.array().optional(),
  animation_url: Joi.string().allow(null, '').optional()
}).unknown(true);

router.get(
  '/:contract/claims',
  needsAuthenticatedUser(),
  cacheRequest({ authDependent: true }),
  async function (
    req: Request<
      { contract: string },
      any,
      any,
      { page?: string; page_size?: string },
      any
    >,
    res: Response<ApiResponse<MintingClaimsPageResponse>>
  ) {
    if (!isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can access minting claims'
      );
    }

    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractOnlyParamsSchema
    );
    const contract = params.contract;

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
      fetchMintingClaimsPage(contract, pageSize, offset),
      fetchMintingClaimsTotalCount(contract)
    ]);

    const response: MintingClaimsPageResponse = {
      claims: rows.map(rowToMintingClaim),
      count: total,
      page,
      page_size: pageSize,
      next: page * pageSize < total
    };

    return res.json(response);
  }
);

router.get(
  '/:contract/claims/:claim_id',
  needsAuthenticatedUser(),
  cacheRequest({ authDependent: true }),
  async function (
    req: Request<ContractClaimParams, any, any, any, any>,
    res: Response<ApiResponse<MintingClaim>>
  ) {
    if (!isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can access minting claims'
      );
    }

    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractClaimParamsSchema
    );
    const claimId = Number.parseInt(params.claim_id, 10);

    const row = await fetchMintingClaimByClaimId(params.contract, claimId);
    if (row) {
      return res.json(rowToMintingClaim(row));
    }

    return res.status(404).json({ error: 'Claim not found' });
  }
);

router.patch(
  '/:contract/claims/:claim_id',
  needsAuthenticatedUser(),
  async function (
    req: Request<ContractClaimParams, any, MintingClaimUpdateRequest, any, any>,
    res: Response<ApiResponse<MintingClaim>>,
    next: NextFunction
  ) {
    try {
      if (!isDistributionAdmin(req)) {
        throw new ForbiddenException(
          'Only distribution admins can update minting claims'
        );
      }

      const params = getValidatedByJoiOrThrow(
        req.params,
        ContractClaimParamsSchema
      );
      const claimId = Number.parseInt(params.claim_id, 10);
      const memesContract = isMemesContract(params.contract);

      const bodySchema = memesContract
        ? StrictMintingClaimUpdateRequestSchema
        : RelaxedMintingClaimUpdateRequestSchema;
      const body = getValidatedByJoiOrThrow(req.body ?? {}, bodySchema);

      const updated = await patchMintingClaim(
        params.contract,
        claimId,
        body,
        memesContract
      );
      if (updated === null) {
        return res.status(404).json({ error: 'Claim not found' });
      }

      await evictMintingClaimCache(params.contract, claimId);
      return res.json(rowToMintingClaim(updated));
    } catch (error) {
      return next(error);
    }
  }
);

async function assertCanStartArweaveUpload(
  claim: MintingClaimRow,
  contract: string
): Promise<void> {
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

  await validateMintingClaimReadyForArweaveUpload(claim, contract);
}

async function queueArweaveUploadOrRollback(
  contract: string,
  claimId: number
): Promise<void> {
  const locked = await updateMintingClaimIfNotUploading(contract, claimId, {
    media_uploading: true
  });
  if (!locked) {
    throw new CustomApiCompliantException(
      409,
      'Claim media upload is already in progress'
    );
  }

  try {
    await enqueueClaimMediaArweaveUpload(contract, claimId);
  } catch (enqueueError) {
    try {
      await updateMintingClaim(contract, claimId, {
        media_uploading: false
      });
    } catch (rollbackError) {
      logger.error('Failed to rollback media_uploading after enqueue error', {
        contract,
        claimId,
        rollbackError
      });
    }
    throw enqueueError;
  }
}

router.use('/actions', mintingClaimActionsRoutes);

router.post(
  '/:contract/claims/:claim_id/arweave-upload',
  needsAuthenticatedUser(),
  async function (
    req: Request<ContractClaimParams, any, any, any, any>,
    res: Response<ApiResponse<MintingClaim>>
  ) {
    if (!isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can upload minting claims to Arweave'
      );
    }

    const params = getValidatedByJoiOrThrow(
      req.params,
      ContractClaimParamsSchema
    );
    const claimId = Number.parseInt(params.claim_id, 10);
    const claim = await fetchMintingClaimByClaimId(params.contract, claimId);
    if (claim === null) {
      return res.status(404).json({ error: 'Claim not found' });
    }

    await assertCanStartArweaveUpload(claim, params.contract);
    await queueArweaveUploadOrRollback(params.contract, claimId);
    await evictMintingClaimCache(params.contract, claimId);

    const updated = await fetchMintingClaimByClaimId(params.contract, claimId);
    return res.status(202).json(rowToMintingClaim(updated ?? claim));
  }
);

router.get(
  '/:contract/:card_id/:merkle_root/proofs/:address',
  maybeAuthenticatedUser(),
  cacheRequest({ authDependent: true }),
  async function (
    req: Request<ProofsPathParams, any, any, any, any>,
    res: Response<ApiResponse<MintingClaimsProofsResponse>>
  ) {
    const params = getValidatedByJoiOrThrow(req.params, ProofsPathParamsSchema);
    const cardId = numbers.parseIntOrNull(params.card_id);
    if (cardId === null || cardId < 0) {
      return res.status(400).json({
        error: 'card_id must be a non-negative integer'
      });
    }

    const merkleRoot = params.merkle_root;
    const rootExists = await doesMintingMerkleRootExistForCard(
      cardId,
      params.contract,
      merkleRoot
    );

    if (!rootExists) {
      return res.status(404).json({
        error:
          'No merkle root found for the given contract, card_id and merkle_root'
      });
    }

    const proofs = await fetchMintingMerkleProofs(merkleRoot, params.address);
    const response: MintingClaimsProofsResponse = {
      proofs: (proofs ?? []).map((proof) => ({
        merkle_proof: proof.merkleProof,
        value: proof.value
      }))
    };

    return res.json(response);
  }
);

export default router;
