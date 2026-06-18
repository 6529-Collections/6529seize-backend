import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiCreateProfileCmsWalletGallerySnapshotRequest } from '@/api/generated/models/ApiCreateProfileCmsWalletGallerySnapshotRequest';
import { ApiProfileCmsWalletGallerySnapshot } from '@/api/generated/models/ApiProfileCmsWalletGallerySnapshot';
import { CreateProfileCmsWalletGallerySnapshotRequest } from '@/api/generated/routes/operations';
import { profileCmsWalletGalleryApiService } from '@/api/profile-cms/wallet-gallery.api.service';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';
import { Request } from 'express';
import * as Joi from 'joi';
export type { ProfileCmsWalletGallerySnapshotResponse } from '@/api/profile-cms/wallet-gallery.api.service';

const WalletGalleryAssetIdentifierSchema = Joi.object({
  contract: Joi.string().trim().min(1).max(100).required(),
  token_id: Joi.number().integer().min(0).required()
});

const WalletGallerySnapshotBodySchema: Joi.ObjectSchema<ApiCreateProfileCmsWalletGallerySnapshotRequest> =
  Joi.object<ApiCreateProfileCmsWalletGallerySnapshotRequest>({
    wallets: Joi.array()
      .items(Joi.string().trim().min(1).max(150).required())
      .min(1)
      .max(25)
      .required(),
    exclude_contracts: Joi.array()
      .items(Joi.string().trim().min(1).max(100).required())
      .max(100)
      .optional(),
    exclude_assets: Joi.array()
      .items(WalletGalleryAssetIdentifierSchema)
      .max(500)
      .optional(),
    include_spam: Joi.boolean().optional(),
    max_assets: Joi.number().integer().min(1).max(500).optional()
  });

export async function handleCreateProfileCmsWalletGallerySnapshot(
  req: CreateProfileCmsWalletGallerySnapshotRequest
): Promise<ApiProfileCmsWalletGallerySnapshot> {
  const body = getValidatedByJoiOrThrow(
    req.body,
    WalletGallerySnapshotBodySchema
  );
  const ctx = await getRequestContext(req);
  return profileCmsWalletGalleryApiService.createSnapshot(
    body,
    ctx
  ) as unknown as Promise<ApiProfileCmsWalletGallerySnapshot>;
}

async function getRequestContext(
  req: Request<any, any, any, any, any>
): Promise<RequestContext> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return { authenticationContext, timer };
}
