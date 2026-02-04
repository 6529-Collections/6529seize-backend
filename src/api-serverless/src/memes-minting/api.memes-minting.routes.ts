import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import type { MemeClaim } from '@/api/generated/models/MemeClaim';
import type { MemeClaimUpdateRequest } from '@/api/generated/models/MemeClaimUpdateRequest';
import type { MemesMintingClaimsResponse } from '@/api/generated/models/MemesMintingClaimsResponse';
import type { MemesMintingProofsByAddressResponse } from '@/api/generated/models/MemesMintingProofsByAddressResponse';
import type { MemesMintingProofsResponse } from '@/api/generated/models/MemesMintingProofsResponse';
import type { MemesMintingRootsResponse } from '@/api/generated/models/MemesMintingRootsResponse';
import {
  fetchAllMemeClaims,
  fetchMemeClaimByDropId,
  fetchMemeClaimByMemeId,
  fetchAllMintingMerkleProofsForRoot,
  fetchMintingMerkleProofs,
  fetchMintingMerkleRoots,
  type MemeClaimRow,
  updateMemeClaim
} from '@/api/memes-minting/api.memes-minting.db';
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
import {
  computeImageDetails,
  computeAnimationDetailsVideo,
  computeAnimationDetailsGlb,
  animationDetailsHtml
} from '@/meme-claims/media-inspector';
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
    row.arweave_synced_at != null ? Number(row.arweave_synced_at) : undefined;
  const editionSize =
    row.edition_size != null ? Number(row.edition_size) : undefined;
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

router.get(
  '/claims',
  needsAuthenticatedUser(),
  cacheRequest(),
  async function (
    req: Request<any, any, any, { meme_id?: string }, any>,
    res: Response<ApiResponse<MemesMintingClaimsResponse>>
  ) {
    if (!isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can access meme claims'
      );
    }
    const memeIdParam = req.query.meme_id;
    if (memeIdParam !== undefined) {
      const memeId = numbers.parseIntOrNull(memeIdParam);
      if (memeId === null || memeId < 0) {
        return res.status(400).json({
          error: 'meme_id must be a non-negative integer'
        });
      }
      const row = await fetchMemeClaimByMemeId(memeId);
      if (!row) {
        return res.status(404).json({ error: 'Claim not found' });
      }
      const response: MemesMintingClaimsResponse = {
        claims: [rowToMemeClaim(row)]
      };
      return res.json(response);
    }
    const rows = await fetchAllMemeClaims();
    const response: MemesMintingClaimsResponse = {
      claims: rows.map(rowToMemeClaim)
    };
    return res.json(response);
  }
);

type ClaimDropIdParams = { drop_id: string };

const ClaimDropIdParamsSchema: Joi.ObjectSchema<ClaimDropIdParams> = Joi.object(
  {
    drop_id: Joi.string().trim().required()
  }
);

router.get(
  '/claims/:drop_id',
  needsAuthenticatedUser(),
  cacheRequest(),
  async function (
    req: Request<ClaimDropIdParams, any, any, any, any>,
    res: Response<ApiResponse<MemeClaim>>
  ) {
    if (!isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can access meme claims'
      );
    }
    const params = getValidatedByJoiOrThrow(
      req.params,
      ClaimDropIdParamsSchema
    );
    const row = await fetchMemeClaimByDropId(params.drop_id);
    if (!row) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    return res.json(rowToMemeClaim(row));
  }
);

router.patch(
  '/claims/:drop_id',
  needsAuthenticatedUser(),
  async function (
    req: Request<ClaimDropIdParams, any, MemeClaimUpdateRequest, any, any>,
    res: Response<ApiResponse<MemeClaim>>
  ) {
    if (!isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can update meme claims'
      );
    }
    const params = getValidatedByJoiOrThrow(
      req.params,
      ClaimDropIdParamsSchema
    );
    const existing = await fetchMemeClaimByDropId(params.drop_id);
    if (!existing) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    const body = req.body ?? {};
    const updates: Parameters<typeof updateMemeClaim>[1] = {};
    if (body.image_location !== undefined)
      updates.image_location = body.image_location;
    if (body.animation_location !== undefined)
      updates.animation_location = body.animation_location;
    if (body.metadata_location !== undefined)
      updates.metadata_location = body.metadata_location;
    if (body.edition_size !== undefined)
      updates.edition_size = body.edition_size;
    if (body.description !== undefined) updates.description = body.description;
    if (body.name !== undefined) updates.name = body.name;
    if (body.image !== undefined) updates.image = body.image;
    if (body.attributes !== undefined) updates.attributes = body.attributes;
    if (body.animation_url !== undefined)
      updates.animation_url = body.animation_url;
    if (body.image !== undefined) {
      if (body.image && typeof body.image === 'string') {
        try {
          updates.image_details = await computeImageDetails(body.image);
        } catch {
          // keep existing image_details on compute failure
        }
      } else {
        updates.image_details = null;
      }
    }
    if (body.animation_url !== undefined) {
      if (!body.animation_url || typeof body.animation_url !== 'string') {
        updates.animation_details = null;
      } else {
        const existingDetails = existing.animation_details
          ? (JSON.parse(existing.animation_details) as { format?: string })
          : undefined;
        try {
          if (existingDetails?.format === 'HTML') {
            updates.animation_details = animationDetailsHtml();
          } else if (
            body.animation_url.toLowerCase().endsWith('.glb') ||
            existingDetails?.format === 'GLB'
          ) {
            updates.animation_details = await computeAnimationDetailsGlb(
              body.animation_url
            );
          } else {
            updates.animation_details = await computeAnimationDetailsVideo(
              body.animation_url
            );
          }
        } catch {
          // keep existing animation_details on compute failure
        }
      }
    }
    updates.arweave_synced_at = null;
    await updateMemeClaim(params.drop_id, updates);
    const updated = await fetchMemeClaimByDropId(params.drop_id);
    return res.json(rowToMemeClaim(updated!));
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
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${url}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType =
    res.headers.get('content-type')?.split(';')[0]?.trim() ||
    'application/octet-stream';
  return { buffer, contentType };
}

router.post(
  '/claims/:drop_id/arweave-upload',
  needsAuthenticatedUser(),
  async function (
    req: Request<ClaimDropIdParams, any, any, any, any>,
    res: Response<ApiResponse<MemeClaim>>
  ) {
    if (!isDistributionAdmin(req)) {
      throw new ForbiddenException(
        'Only distribution admins can upload meme claims to Arweave'
      );
    }
    const params = getValidatedByJoiOrThrow(
      req.params,
      ClaimDropIdParamsSchema
    );
    const claim = await fetchMemeClaimByDropId(params.drop_id);
    if (!claim) {
      return res.status(404).json({ error: 'Claim not found' });
    }
    if (claim.arweave_synced_at != null) {
      throw new CustomApiCompliantException(
        409,
        'Claim already synced to Arweave'
      );
    }
    const imageUrl = claim.image?.trim() || null;
    if (!imageUrl) {
      throw new BadRequestException(
        'Claim has no image URL; set image via PATCH before uploading to Arweave'
      );
    }
    const editionSize =
      claim.edition_size != null ? Number(claim.edition_size) : null;
    if (
      editionSize == null ||
      !Number.isInteger(editionSize) ||
      editionSize < 1
    ) {
      throw new BadRequestException(
        'Claim has no edition_size or it is not a positive integer; set edition_size via PATCH before uploading to Arweave'
      );
    }
    let imageLocation: string;
    let animationLocation: string | null = null;
    try {
      const { buffer: imageBuffer, contentType: imageContentType } =
        await fetchUrlToBuffer(imageUrl);
      const { url: imageArweaveUrl } = await arweaveFileUploader.uploadFile(
        imageBuffer,
        imageContentType
      );
      imageLocation = arweaveTxIdFromUrl(imageArweaveUrl);
    } catch (e) {
      return res.status(500).json({
        error: 'Failed to fetch or upload image to Arweave'
      });
    }
    const animationUrl = claim.animation_url?.trim() || null;
    const animationDetails = claim.animation_details
      ? (JSON.parse(claim.animation_details) as { format?: string })
      : null;
    const isHtmlAnimation = animationDetails?.format === 'HTML';
    if (animationUrl) {
      if (isHtmlAnimation) {
        animationLocation = animationUrl;
      } else {
        try {
          const { buffer: animBuffer, contentType: animContentType } =
            await fetchUrlToBuffer(animationUrl);
          const { url: animArweaveUrl } = await arweaveFileUploader.uploadFile(
            animBuffer,
            animContentType
          );
          animationLocation = arweaveTxIdFromUrl(animArweaveUrl);
        } catch (e) {
          return res.status(500).json({
            error: 'Failed to fetch or upload animation to Arweave'
          });
        }
      }
    }
    const metadataImageUrl = `https://arweave.net/${imageLocation}`;
    const metadataAnimationUrl = animationLocation
      ? animationLocation.startsWith('http')
        ? animationLocation
        : `https://arweave.net/${animationLocation}`
      : undefined;
    const metadata = {
      name: claim.name,
      description: claim.description,
      image: metadataImageUrl,
      ...(metadataAnimationUrl && { animation_url: metadataAnimationUrl }),
      attributes: JSON.parse(claim.attributes),
      ...(claim.image_details && {
        image_details: JSON.parse(claim.image_details)
      }),
      ...(claim.animation_details && {
        animation_details: JSON.parse(claim.animation_details)
      })
    };
    let metadataLocation: string;
    try {
      const metadataBuffer = Buffer.from(JSON.stringify(metadata), 'utf-8');
      const { url: metadataArweaveUrl } = await arweaveFileUploader.uploadFile(
        metadataBuffer,
        'application/json'
      );
      metadataLocation = arweaveTxIdFromUrl(metadataArweaveUrl);
    } catch (e) {
      return res.status(500).json({
        error: 'Failed to upload metadata to Arweave'
      });
    }
    await updateMemeClaim(params.drop_id, {
      image_location: imageLocation,
      animation_location: animationLocation,
      metadata_location: metadataLocation,
      arweave_synced_at: Date.now()
    });
    const updated = await fetchMemeClaimByDropId(params.drop_id);
    return res.json(rowToMemeClaim(updated!));
  }
);

export default router;
