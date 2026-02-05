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
    image_location: row.image_location ?? undefined,
    animation_location: row.animation_location ?? undefined,
    metadata_location: row.metadata_location ?? undefined,
    arweave_synced_at: arweaveSyncedAt,
    edition_size: editionSize,
    description: row.description,
    name: row.name,
    image: row.image ?? undefined,
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

async function fetchUrlToBuffer(
  url: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const res = await fetch(url);
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

async function uploadClaimMetadataToArweave(
  claim: MemeClaimRow,
  imageLocation: string,
  animationLocation: string | null
): Promise<string> {
  const attributes = JSON.parse(claim.attributes) as unknown;
  const metadata = {
    name: claim.name,
    description: claim.description ?? '',
    image: imageLocation,
    ...(animationLocation ? { animation_url: animationLocation } : {}),
    attributes
  };
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
    const imageUrl = claim.image?.trim() || null;
    if (imageUrl === null || imageUrl === '') {
      throw new BadRequestException(
        'Claim has no image URL! Set image before uploading to Arweave.'
      );
    }
    const editionSize =
      claim.edition_size == null ? null : Number(claim.edition_size);
    const isInvalidEditionSize =
      editionSize == null ||
      Number.isInteger(editionSize) === false ||
      editionSize < 1;
    if (isInvalidEditionSize) {
      throw new BadRequestException(
        'Claim has no edition_size or it is not a positive integer! Set edition_size before uploading to Arweave.'
      );
    }
    let imageLocation: string;
    let animationLocation: string | null;
    let metadataLocation: string;
    try {
      imageLocation = await uploadImageToArweaveOrThrow(imageUrl);
      animationLocation = await uploadAnimationToArweaveIfPresent(claim);
      metadataLocation = await uploadClaimMetadataToArweave(
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
      image_location: imageLocation,
      animation_location: animationLocation,
      metadata_location: metadataLocation,
      arweave_synced_at: Date.now()
    });
    const updated = await fetchMemeClaimByMemeId(memeId);
    return res.json(rowToMemeClaim(updated!));
  }
);

export default router;
