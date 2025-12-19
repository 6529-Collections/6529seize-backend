import { Request, Response } from 'express';
import { invalidateCloudFront } from '../../../cloudfront';
import { CLOUDFRONT_DISTRIBUTION } from '../../../constants';
import { UnauthorisedException } from '../../../exceptions';
import { Logger } from '../../../logging';
import { numbers } from '../../../numbers';
import { evictKeyFromRedisCache } from '../../../redis';
import {
  getCacheKeyPatternForPath,
  getPage,
  getPageSize,
  returnJsonResult,
  returnPaginatedResult
} from '../api-helpers';
import { asyncRouter } from '../async.router';
import { needsAuthenticatedUser } from '../auth/auth';
import { cacheRequest } from '../request-cache';
import { authenticateSubscriptionsAdmin } from '../subscriptions/api.subscriptions.allowlist';
import { uploadPhotos } from './api.distribution-photos.upload.service';
import {
  fetchDistributionPhotos,
  saveDistributionPhotos
} from './api.distribution_photos.db';

const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 20,
    fieldSize: 10 * 1024 * 1024,
    fieldNameSize: 100
  }
});

const logger = Logger.get('DISTRIBUTION_PHOTOS');

const router = asyncRouter();

router.get(
  `/:contract/:nft_id`,
  cacheRequest(),
  async function (req: any, res: any) {
    const contract = req.params.contract;
    const nftId = req.params.nft_id;

    const pageSize = getPageSize(req);
    const page = getPage(req);

    await fetchDistributionPhotos(contract, nftId, pageSize, page).then(
      async (result) => {
        await returnPaginatedResult(result, req, res);
      }
    );
  }
);

router.post(
  `/:contract/:nft_id`,
  upload.array('photos'),
  needsAuthenticatedUser(),
  async function (req: Request<any, any, any, any>, res: Response) {
    const authenticated = authenticateSubscriptionsAdmin(req);
    if (!authenticated) {
      throw new UnauthorisedException(
        'Only Subscription Admins can upload photos'
      );
    }

    const contract = req.params.contract;
    const nftId = numbers.parseIntOrNull(req.params.nft_id);

    if (nftId === null) {
      return res.status(400).send({
        success: false,
        error: 'Invalid nft_id parameter'
      });
    }

    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.status(400).send({
        success: false,
        error: 'No photos provided'
      });
    }

    const photos = files.map((file) => ({
      name: file.originalname,
      buffer: file.buffer,
      mimetype: file.mimetype
    }));

    const myphotos = await uploadPhotos(contract, nftId, photos);
    await saveDistributionPhotos(contract, nftId, myphotos);

    const invalidationPath = `/distribution/${process.env.NODE_ENV}/${contract}/${nftId}/*`;
    await invalidateCloudFront(CLOUDFRONT_DISTRIBUTION, [invalidationPath]);

    const overviewCacheKey = getCacheKeyPatternForPath(
      `/api/distributions/${contract}/${nftId}/overview`
    );
    await evictKeyFromRedisCache(overviewCacheKey);

    return await returnJsonResult(
      {
        success: true,
        photos: myphotos
      },
      req,
      res
    );
  }
);

export default router;
