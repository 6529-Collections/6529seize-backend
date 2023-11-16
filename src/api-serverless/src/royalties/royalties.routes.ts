import { Request, Response } from 'express';
import { fetchRoyaltiesMemes, fetchRoyaltiesUploads } from '../../../db-api';
import { Logger } from '../../../logging';
import { asyncRouter } from '../async.router';
import {
  CACHE_TIME_MS,
  DEFAULT_PAGE_SIZE,
  PaginatedResponse
} from '../api-constants';
import {
  cacheKey,
  returnCSVResult,
  returnJsonResult,
  returnPaginatedResult
} from '../api-helpers';
import * as mcache from 'memory-cache';

const router = asyncRouter();

const logger = Logger.get('ROYALTIES_API');

export default router;

interface RoyaltyResponse {
  token_id: number;
  name: string;
  artist: string;
  thumbnail?: string;
  total_volume: number;
  total_royalties: number;
}

interface RoyaltyUploadResponse {
  created_at: string;
  date: string;
  url: string;
}

router.get(
  `/memes`,
  function (
    req: Request<
      {},
      {},
      {},
      {
        from_date?: string;
        to_date?: string;
        download?: string;
      }
    >,
    res: Response<RoyaltyResponse[] | string>
  ) {
    const fromDate: string = req.query.from_date as string;
    const toDate: string = req.query.to_date as string;
    const download = req.query.download === 'true';

    fetchRoyaltiesMemes(fromDate, toDate).then(
      async (results: RoyaltyResponse[]) => {
        logger.info(
          `[FROM_DATE ${fromDate} FROM_DATE ${toDate} - Fetched ${results.length}`
        );

        if (results.length > 0) {
          mcache.put(cacheKey(req), results, CACHE_TIME_MS);
        }

        if (download) {
          results.forEach((r) => delete r.thumbnail);
          returnCSVResult('royalties_memes', results, res);
        } else {
          returnJsonResult(results, req, res);
        }
      }
    );
  }
);

router.get(
  `/uploads`,
  function (
    req: Request<
      {},
      {},
      {},
      {
        page_size?: number;
        page?: number;
      }
    >,
    res: Response<PaginatedResponse<RoyaltyUploadResponse>>
  ) {
    const pageSize: number =
      req.query.page_size && req.query.page_size < DEFAULT_PAGE_SIZE
        ? req.query.page_size
        : DEFAULT_PAGE_SIZE;
    const page: number = req.query.page ? req.query.page : 1;
    fetchRoyaltiesUploads(pageSize, page).then((result) => {
      returnPaginatedResult<RoyaltyUploadResponse>(result, req, res);
    });
  }
);
