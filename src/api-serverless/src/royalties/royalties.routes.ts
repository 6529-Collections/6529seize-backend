import { Request, Response } from 'express';
import { fetchRoyaltiesUploads } from '../../../db-api';
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
import { RoyaltyResponse, fetchRoyalties } from './royalties.db';

const router = asyncRouter();

const logger = Logger.get('ROYALTIES_API');

export default router;

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
        primary?: string;
        artist?: string;
        from_date?: string;
        to_date?: string;
        from_block?: string;
        to_block?: string;
        download?: string;
      }
    >,
    res: Response<RoyaltyResponse[] | string>
  ) {
    const collectionType = req.params.collection_type;
    if (collectionType === 'memes' || collectionType === 'memelab') {
      let fromBlockResolved = 0;
      if (req.query.from_block) {
        const fromB = parseInt(req.query.from_block);
        if (!isNaN(fromB)) {
          fromBlockResolved = parseInt(req.query.from_block);
        }
      }
      let toBlockResolved = 0;
      if (req.query.to_block) {
        const toB = parseInt(req.query.to_block);
        if (!isNaN(toB)) {
          toBlockResolved = parseInt(req.query.to_block);
        }
      }
      return returnRoyalties(
        collectionType,
        req.query.primary === 'true',
        req.query.artist as string,
        req.query.from_date as string,
        req.query.to_date as string,
        fromBlockResolved,
        toBlockResolved,
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
  isPrimary: boolean,
  artist: string,
  fromDate: string,
  toDate: string,
  fromBlock: number,
  toBlock: number,
  download: boolean,
  req: Request,
  res: Response
) {
  fetchRoyalties(
    type,
    isPrimary,
    artist,
    fromDate,
    toDate,
    fromBlock,
    toBlock
  ).then(async (results: RoyaltyResponse[]) => {
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
  });
}
