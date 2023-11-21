import { Request, Response } from 'express';
import { fetchRoyalties, fetchRoyaltiesUploads } from '../../../db-api';
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

export interface RoyaltyResponse {
  token_id: number;
  name: string;
  artist: string;
  thumbnail?: string;
  primary_volume: number;
  secondary_volume: number;
  royalties: number;
  primary_royalty_split: number;
  secondary_royalty_split: number;
  primary_artist_take: number;
  secondary_artist_take: number;
}

interface RoyaltyUploadResponse {
  created_at: string;
  date: string;
  url: string;
}

router.get(
  `/collection/:collection_type`,
  function (
    req: Request<
      {
        collection_type: string;
      },
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
    const collectionType = req.params.collection_type;
    if (collectionType === 'memes' || collectionType === 'memelab') {
      return returnRoyalties(
        collectionType,
        req.query.from_date as string,
        req.query.to_date as string,
        req.query.download === 'true',
        req,
        res
      );
    } else {
      return res.status(404).send('Not found');
    }
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

function returnRoyalties(
  type: 'memes' | 'memelab',
  fromDate: string,
  toDate: string,
  download: boolean,
  req: Request,
  res: Response
) {
  fetchRoyalties(type, fromDate, toDate).then(
    async (results: RoyaltyResponse[]) => {
      logger.info(
        `[${type.toUpperCase()} FROM_DATE ${fromDate} TO_DATE ${toDate} - Fetched ${
          results.length
        }`
      );

      if (results.length > 0) {
        mcache.put(cacheKey(req), results, CACHE_TIME_MS);
      }

      if (download) {
        results.forEach((r) => delete r.thumbnail);
        return returnCSVResult(`royalties_${type}`, results, res);
      } else {
        return returnJsonResult(results, req, res);
      }
    }
  );
}
