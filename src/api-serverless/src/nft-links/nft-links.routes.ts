import { Request, Response } from 'express';
import { ApiResponse } from '../api-response';
import { asyncRouter } from '../async.router';
import { Timer } from '@/time';
import { NftLinkResolverValidationError } from '@/nft-links/nft-link-resolver-validation.error';
import { ApiNftLinkResponse } from '@/api/generated/models/ApiNftLinkResponse';
import { nftLinkResolvingService } from '@/nft-links/nft-link-resolving.service';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import * as Joi from 'joi';

const router = asyncRouter();

router.get(
  `/`,
  async (
    req: Request<any, any, any, { url: string }, any>,
    res: Response<ApiResponse<ApiNftLinkResponse>>
  ) => {
    const timer = Timer.getFromRequest(req);
    const { url } = getValidatedByJoiOrThrow(
      req.query,
      Joi.object<{ url: string }>({ url: Joi.string().required() })
    );
    try {
      const data = await nftLinkResolvingService.getLinkData(url, { timer });
      if (data) {
        return res.send({
          is_enrichable: true,
          validation_error: null,
          data
        });
      } else {
        return res.send({
          is_enrichable: false,
          validation_error: 'Could not validate link',
          data: null
        });
      }
    } catch (e: any) {
      if (e instanceof NftLinkResolverValidationError) {
        return res.send({
          is_enrichable: false,
          validation_error: e.message,
          data: null
        });
      } else {
        throw e;
      }
    }
  }
);

export default router;
