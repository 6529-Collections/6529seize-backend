import { Request, Response } from 'express';
import * as Joi from 'joi';
import { ApiResponse } from '@/api/api-response';
import { asyncRouter } from '@/api/async.router';
import {
  getAuthenticationContext,
  needsAuthenticatedUser
} from '@/api/auth/auth';
import { ApiCmsCreateSiteRequest } from '@/api/generated/models/ApiCmsCreateSiteRequest';
import { ApiCmsPublishedPackage } from '@/api/generated/models/ApiCmsPublishedPackage';
import { ApiCmsPublishedSite } from '@/api/generated/models/ApiCmsPublishedSite';
import { ApiCmsPublishPackageRequest } from '@/api/generated/models/ApiCmsPublishPackageRequest';
import { ApiCmsSite } from '@/api/generated/models/ApiCmsSite';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { Timer } from '@/time';
import { cmsApiService } from './cms.api.service';

const router = asyncRouter();

const hashSchema = Joi.string()
  .pattern(/^sha256:[a-f0-9]{64}$/)
  .required();

const createSiteSchema = Joi.object<ApiCmsCreateSiteRequest>({
  slug: Joi.string()
    .trim()
    .lowercase()
    .pattern(/^[a-z0-9][a-z0-9-]{0,62}$/)
    .required(),
  title: Joi.string().trim().min(1).max(255).required(),
  description: Joi.string().trim().max(5000).allow(null).optional()
});

const storageLocationSchema = Joi.object({
  provider: Joi.string().trim().min(1).max(50).required(),
  uri: Joi.string().trim().min(1).max(2000).required(),
  pinned: Joi.boolean().required()
}).unknown(true);

const publishPackageSchema = Joi.object<ApiCmsPublishPackageRequest>({
  package_hash: hashSchema,
  payload_hash: hashSchema,
  schema: Joi.string().trim().min(1).max(100).required(),
  title: Joi.string().trim().min(1).max(255).required(),
  description: Joi.string().trim().max(5000).allow(null).optional(),
  static_path: Joi.string().trim().min(1).max(500).required(),
  canonical_url: Joi.string().trim().uri().max(1000).allow(null).optional(),
  package_json: Joi.object().unknown(true).required(),
  storage: Joi.array().items(storageLocationSchema).min(1).required(),
  signature: Joi.object().unknown(true).required(),
  set_primary: Joi.boolean().optional()
});

router.get(
  '/profile/:identity/primary',
  async (
    req: Request<{ identity: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiCmsPublishedSite>>
  ) => {
    const timer = Timer.getFromRequest(req);
    res.send(
      await cmsApiService.getPrimarySiteByIdentity(req.params.identity, {
        timer
      })
    );
  }
);

router.get(
  '/packages/:package_hash',
  async (
    req: Request<{ package_hash: string }, any, any, any, any>,
    res: Response<ApiResponse<ApiCmsPublishedPackage>>
  ) => {
    res.send(await cmsApiService.getPackageByHash(req.params.package_hash));
  }
);

router.get(
  '/my/sites',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, any, any, any>,
    res: Response<ApiResponse<ApiCmsSite[]>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    res.send(
      await cmsApiService.listMySites({
        authenticationContext,
        timer
      })
    );
  }
);

router.post(
  '/sites',
  needsAuthenticatedUser(),
  async (
    req: Request<any, any, ApiCmsCreateSiteRequest, any, any>,
    res: Response<ApiResponse<ApiCmsSite>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const request = getValidatedByJoiOrThrow(req.body, createSiteSchema);
    res.status(201).send(
      await cmsApiService.createSite(request, {
        authenticationContext,
        timer
      })
    );
  }
);

router.post(
  '/sites/:site_id/published-packages',
  needsAuthenticatedUser(),
  async (
    req: Request<
      { site_id: string },
      any,
      ApiCmsPublishPackageRequest,
      any,
      any
    >,
    res: Response<ApiResponse<ApiCmsPublishedSite>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const authenticationContext = await getAuthenticationContext(req, timer);
    const request = getValidatedByJoiOrThrow(req.body, publishPackageSchema);
    res.status(201).send(
      await cmsApiService.publishPackage(req.params.site_id, request, {
        authenticationContext,
        timer
      })
    );
  }
);

export default router;
