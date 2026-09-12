import * as Operations from '@/api/generated/routes/operations';
import * as Joi from 'joi';
import { artworkAssetsService } from '@/artwork-documentation/assets/artwork-assets.service';
import { ARTWORK_ASSET_ROLES } from '@/artwork-documentation/assets/artwork-assets.types';
import { artworkDocumentationService as core } from '@/artwork-documentation/artwork-documentation.service';
import {
  toAssetAccess,
  writeAssetLink,
  removeAssetLink
} from '@/artwork-documentation/artwork-documentation.asset-links';
import {
  documentationBody as body,
  documentationMutation as mutation,
  executeDocumentationRequest as execute
} from './artwork-documentation.handlers';

const uuid = Joi.string().guid();
const visibility = Joi.string().valid('public_record', 'restricted').required();
const role = Joi.string()
  .valid(...ARTWORK_ASSET_ROLES)
  .required();
const optionalText = (max: number) => Joi.string().max(max).allow('');
const uri = Joi.string()
  .max(2048)
  .uri({ scheme: ['https', 'ipfs', 'ar'] });
const assetLink = Joi.object({
  asset_id: uuid.required(),
  role,
  intended_visibility: visibility,
  label: optionalText(160),
  description: optionalText(1000),
  source_of_asset: Joi.string().valid(
    'self',
    'collaborator',
    'third_party',
    'unknown'
  ),
  source_credit: optionalText(500),
  derived_from_asset_ids: Joi.array().items(uuid).max(30),
  deposit_note: optionalText(1000),
  intended_terms: Joi.object({
    kind: Joi.string()
      .valid(
        'unspecified',
        'private_deposit',
        'proposed_license',
        'already_licensed'
      )
      .required(),
    license_uri: uri,
    note: optionalText(2000)
  }).required()
});
const part = Joi.object({
  part_number: Joi.number().integer().min(1).max(256).required(),
  checksum_sha256: Joi.string().base64().length(44).required()
});

export function handleStartDocumentationUpload(
  req: Operations.ArtworkDocumentationStartDocumentationUploadRequest
): Promise<Operations.ArtworkDocumentationStartDocumentationUploadResponse> {
  return execute(req, async (ctx) =>
    artworkAssetsService.startUpload(
      req.params.id,
      toAssetAccess(await core.authorizeMutationContext(req.params.id, ctx)),
      body(
        req,
        Joi.object({
          filename: Joi.string().min(1).max(255).required(),
          size_bytes: Joi.number().integer().min(1).max(4294967296).required(),
          declared_mime: Joi.string().min(1).max(150).required(),
          role,
          intended_visibility: visibility
        })
      ),
      mutation(req).key
    )
  );
}
export function handleGetDocumentationUpload(
  req: Operations.ArtworkDocumentationGetDocumentationUploadRequest
): Promise<Operations.ArtworkDocumentationGetDocumentationUploadResponse> {
  return execute(req, async (ctx) => {
    const access = await core.authorizeContext(req.params.id, ctx);
    const mutationCapabilities = await core.mutationCapabilities(access, ctx);
    return artworkAssetsService.getUpload(
      req.params.id,
      req.params.uploadId,
      toAssetAccess(access),
      toAssetAccess({ ...access, capabilities: mutationCapabilities })
    );
  });
}
export function handleSignDocumentationParts(
  req: Operations.ArtworkDocumentationSignDocumentationPartsRequest
): Promise<Operations.ArtworkDocumentationSignDocumentationPartsResponse> {
  return execute(req, async (ctx) => {
    mutation(req);
    return artworkAssetsService.signParts(
      req.params.id,
      req.params.uploadId,
      toAssetAccess(await core.authorizeMutationContext(req.params.id, ctx)),
      body(
        req,
        Joi.object({ parts: Joi.array().items(part).min(1).max(3).required() })
      )
    );
  });
}
export function handleCompleteDocumentationUpload(
  req: Operations.ArtworkDocumentationCompleteDocumentationUploadRequest
): Promise<Operations.ArtworkDocumentationCompleteDocumentationUploadResponse> {
  return execute(req, async (ctx) => {
    const access = toAssetAccess(
      await core.authorizeMutationContext(req.params.id, ctx)
    );
    const input = body<
      Parameters<typeof artworkAssetsService.completeUpload>[3]
    >(
      req,
      Joi.object({
        parts: Joi.array()
          .items(part.keys({ etag: Joi.string().min(1).max(200).required() }))
          .min(1)
          .max(256)
          .required()
      })
    );
    await core.bindAssetMutation(
      req.params.id,
      req.params.uploadId,
      mutation(req),
      ctx
    );
    return artworkAssetsService.completeUpload(
      req.params.id,
      req.params.uploadId,
      access,
      input
    );
  });
}
export function handleCancelDocumentationUpload(
  req: Operations.ArtworkDocumentationCancelDocumentationUploadRequest
): Promise<Operations.ArtworkDocumentationCancelDocumentationUploadResponse> {
  return execute(req, async (ctx) => {
    await core.bindAssetMutation(
      req.params.id,
      req.params.uploadId,
      mutation(req),
      ctx
    );
    await artworkAssetsService.cancelUpload(
      req.params.id,
      req.params.uploadId,
      toAssetAccess(await core.authorizeMutationContext(req.params.id, ctx))
    );
    return { success: true };
  });
}
export function handleDownloadDocumentationAsset(
  req: Operations.ArtworkDocumentationDownloadDocumentationAssetRequest
): Promise<Operations.ArtworkDocumentationDownloadDocumentationAssetResponse> {
  return execute(req, async (ctx) => {
    mutation(req);
    return artworkAssetsService.download(
      req.params.id,
      req.params.assetId,
      toAssetAccess(await core.authorizeContext(req.params.id, ctx)),
      body(
        req,
        Joi.object({
          variant: Joi.string().valid('original', 'preview').required()
        })
      )
    );
  });
}
export function handleLinkDocumentationAsset(
  req: Operations.ArtworkDocumentationLinkDocumentationAssetRequest
): Promise<Operations.ArtworkDocumentationLinkDocumentationAssetResponse> {
  return execute(req, (ctx) =>
    writeAssetLink(
      req.params.id,
      body(req, assetLink),
      mutation(req, true),
      ctx
    )
  );
}
export function handlePatchDocumentationAssetLink(
  req: Operations.ArtworkDocumentationPatchDocumentationAssetLinkRequest
): Promise<Operations.ArtworkDocumentationPatchDocumentationAssetLinkResponse> {
  return execute(req, (ctx) =>
    writeAssetLink(
      req.params.id,
      body(req, assetLink),
      mutation(req, true),
      ctx,
      req.params.linkId
    )
  );
}
export function handleUnlinkDocumentationAsset(
  req: Operations.ArtworkDocumentationUnlinkDocumentationAssetRequest
): Promise<Operations.ArtworkDocumentationUnlinkDocumentationAssetResponse> {
  return execute(req, (ctx) =>
    removeAssetLink(req.params.id, req.params.linkId, mutation(req, true), ctx)
  );
}
