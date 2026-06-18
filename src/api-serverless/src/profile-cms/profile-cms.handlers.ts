import { getAuthenticationContext } from '@/api/auth/auth';
import { ApiProfileCmsValidationResult } from '@/api/generated/models/ApiProfileCmsValidationResult';
import { ApiProfileCmsPackage } from '@/api/generated/models/ApiProfileCmsPackage';
import { ApiProfileCmsPrimaryPackage } from '@/api/generated/models/ApiProfileCmsPrimaryPackage';
import { ApiPublishProfileCmsPackageRequest } from '@/api/generated/models/ApiPublishProfileCmsPackageRequest';
import { ApiSaveProfileCmsPackageDraftRequest } from '@/api/generated/models/ApiSaveProfileCmsPackageDraftRequest';
import { ApiValidateProfileCmsPackageRequest } from '@/api/generated/models/ApiValidateProfileCmsPackageRequest';
import {
  GetPrimaryProfileCmsPackageRequest,
  GetProfileCmsPackageByHashRequest,
  GetProfileCmsPackageByIdRequest,
  GetProfileCmsPackageByVersionRequest,
  ListProfileCmsPackagesRequest,
  PublishProfileCmsPackageRequest,
  SaveProfileCmsPackageDraftRequest,
  ValidateProfileCmsPackageRequest
} from '@/api/generated/routes/operations';
import { profileCmsApiService } from '@/api/profile-cms/profile-cms.api.service';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';
import { Request } from 'express';
import * as Joi from 'joi';

type HandlePathParams = {
  readonly handle: string;
};

type PackageIdPathParams = {
  readonly id: string;
};

type PackageHashPathParams = {
  readonly package_hash: string;
};

type ProfilePackagesPathParams = {
  readonly profile_id: string;
};

type PackageVersionPathParams = {
  readonly profile_id: string;
  readonly package_id: string;
  readonly version: number;
};

const HandlePathParamsSchema: Joi.ObjectSchema<HandlePathParams> = Joi.object({
  handle: Joi.string().trim().min(1).max(100).required()
});

const PackageIdPathParamsSchema: Joi.ObjectSchema<PackageIdPathParams> =
  Joi.object({
    id: Joi.string().trim().min(1).max(100).required()
  });

const PackageHashPathParamsSchema: Joi.ObjectSchema<PackageHashPathParams> =
  Joi.object({
    package_hash: Joi.string().trim().min(1).max(100).required()
  });

const ProfilePackagesPathParamsSchema: Joi.ObjectSchema<ProfilePackagesPathParams> =
  Joi.object({
    profile_id: Joi.string().trim().min(1).max(100).required()
  });

const PackageVersionPathParamsSchema: Joi.ObjectSchema<PackageVersionPathParams> =
  Joi.object({
    profile_id: Joi.string().trim().min(1).max(100).required(),
    package_id: Joi.string().trim().min(1).max(128).required(),
    version: Joi.number().integer().min(1).required()
  });

const SaveDraftBodySchema: Joi.ObjectSchema<ApiSaveProfileCmsPackageDraftRequest> =
  Joi.object<ApiSaveProfileCmsPackageDraftRequest>({
    profile_id: Joi.string().trim().min(1).max(100).required(),
    cms_package: Joi.object().unknown(true).required()
  });

const ValidateBodySchema: Joi.ObjectSchema<ApiValidateProfileCmsPackageRequest> =
  Joi.object<ApiValidateProfileCmsPackageRequest>({
    cms_package: Joi.object().unknown(true).required(),
    allow_fixture_signatures: Joi.boolean().optional(),
    allow_fixture_storage: Joi.boolean().optional(),
    enforce_hashes: Joi.boolean().optional()
  });

const PublishBodySchema: Joi.ObjectSchema<ApiPublishProfileCmsPackageRequest> =
  Joi.object<ApiPublishProfileCmsPackageRequest>({
    expected_package_hash: Joi.string().trim().min(1).max(100).optional(),
    expected_payload_hash: Joi.string().trim().min(1).max(100).optional()
  });

export async function handleSaveProfileCmsPackageDraft(
  req: SaveProfileCmsPackageDraftRequest
): Promise<ApiProfileCmsPackage> {
  const body = getValidatedByJoiOrThrow(req.body, SaveDraftBodySchema);
  const ctx = await getRequestContext(req);
  return profileCmsApiService.saveDraft(
    body,
    ctx
  ) as unknown as Promise<ApiProfileCmsPackage>;
}

export async function handleValidateProfileCmsPackage(
  req: ValidateProfileCmsPackageRequest
): Promise<ApiProfileCmsValidationResult> {
  const body = getValidatedByJoiOrThrow(req.body, ValidateBodySchema);
  return profileCmsApiService.validatePackage(
    body
  ) as ApiProfileCmsValidationResult;
}

export async function handlePublishProfileCmsPackage(
  req: PublishProfileCmsPackageRequest
): Promise<ApiProfileCmsPackage> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    PackageIdPathParamsSchema
  );
  const body = getValidatedByJoiOrThrow(req.body ?? {}, PublishBodySchema);
  const ctx = await getRequestContext(req);
  return profileCmsApiService.publish(
    id,
    body,
    ctx
  ) as unknown as Promise<ApiProfileCmsPackage>;
}

export async function handleListProfileCmsPackages(
  req: ListProfileCmsPackagesRequest
): Promise<ApiProfileCmsPackage[]> {
  const { profile_id } = getValidatedByJoiOrThrow(
    req.params,
    ProfilePackagesPathParamsSchema
  );
  const ctx = await getRequestContext(req);
  return profileCmsApiService.listForProfile(
    profile_id,
    ctx
  ) as unknown as Promise<ApiProfileCmsPackage[]>;
}

export async function handleGetPrimaryProfileCmsPackage(
  req: GetPrimaryProfileCmsPackageRequest
): Promise<ApiProfileCmsPrimaryPackage> {
  const { handle } = getValidatedByJoiOrThrow(
    req.params,
    HandlePathParamsSchema
  );
  return profileCmsApiService.getPrimaryByHandle(handle, {
    timer: Timer.getFromRequest(req)
  }) as unknown as Promise<ApiProfileCmsPrimaryPackage>;
}

export async function handleGetProfileCmsPackageById(
  req: GetProfileCmsPackageByIdRequest
): Promise<ApiProfileCmsPackage> {
  const { id } = getValidatedByJoiOrThrow(
    req.params,
    PackageIdPathParamsSchema
  );
  const ctx = await getRequestContext(req);
  return profileCmsApiService.getById(
    id,
    ctx
  ) as unknown as Promise<ApiProfileCmsPackage>;
}

export async function handleGetProfileCmsPackageByVersion(
  req: GetProfileCmsPackageByVersionRequest
): Promise<ApiProfileCmsPackage> {
  const { profile_id, package_id, version } = getValidatedByJoiOrThrow(
    req.params,
    PackageVersionPathParamsSchema
  );
  const ctx = await getRequestContext(req);
  return profileCmsApiService.getByVersion(
    profile_id,
    package_id,
    version,
    ctx
  ) as unknown as Promise<ApiProfileCmsPackage>;
}

export async function handleGetProfileCmsPackageByHash(
  req: GetProfileCmsPackageByHashRequest
): Promise<ApiProfileCmsPackage> {
  const { package_hash } = getValidatedByJoiOrThrow(
    req.params,
    PackageHashPathParamsSchema
  );
  const ctx = await getRequestContext(req);
  return profileCmsApiService.getByHash(
    package_hash,
    ctx
  ) as unknown as Promise<ApiProfileCmsPackage>;
}

async function getRequestContext(
  req: Request<any, any, any, any, any>
): Promise<RequestContext> {
  const timer = Timer.getFromRequest(req);
  const authenticationContext = await getAuthenticationContext(req, timer);
  return { authenticationContext, timer };
}
