import { Request, Response } from 'express';
import { invalidateCloudFront } from '../../../cloudfront';
import { CLOUDFRONT_DISTRIBUTION } from '../../../constants';
import { UnauthorisedException } from '../../../exceptions';
import { Logger } from '../../../logging';
import { DEFAULT_PAGE_SIZE } from '../api-constants';
import { returnJsonResult, returnPaginatedResult } from '../api-helpers';
import { asyncRouter } from '../async.router';
import { needsAuthenticatedUser } from '../auth/auth';
import { cacheRequest } from '../request-cache';
import { authenticateSubscriptionsAdmin } from '../subscriptions/api.subscriptions.allowlist';
import { fetchDistributionPhotos } from './api.distribution_photos.db';
import {
  saveDistributionPhotos,
  uploadPhotos
} from './distribution-photos.upload.service';

const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const logger = Logger.get('DISTRIBUTION_PHOTOS');

const router = asyncRouter();

router.get(
  `/:contract/:nft_id`,
  cacheRequest(),
  async function (req: any, res: any) {
    const contract = req.params.contract;
    const nftId = req.params.nft_id;

    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? parseInt(req.query.page_size)
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? parseInt(req.query.page) : 1;

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
    const nftId = parseInt(req.params.nft_id);

    if (isNaN(nftId)) {
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
