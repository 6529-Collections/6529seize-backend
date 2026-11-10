import { Request, Response } from 'express';
import { fetchRoyaltiesUploads } from '../../../db-api';
import { Logger } from '../../../logging';
import { PaginatedResponse } from '../api-constants';
import {
  getPage,
  getPageSize,
  returnCSVResult,
  returnPaginatedResult
} from '../api-helpers';
import { parseCollectionReportQuery } from '@/api/collection-report-query';
import { asyncRouter } from '../async.router';
import { cacheRequest } from '../request-cache';
import { fetchRoyalties, RoyaltyResponse } from './royalties.db';

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
  async function (
    req: Request<
      {
        collection_type: string;
      },
      any,
      any,
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
      const query = parseCollectionReportQuery(req.query);
      return await returnRoyalties(
        collectionType,
        query.primary,
        query.artist as string,
        query.from_date as string,
        query.to_date as string,
        query.from_block,
        query.to_block,
        query.download,
        res
      );
    } else {
      return res.status(404).send('Not found');
    }
  }
);

router.get(
  `/uploads`,
  cacheRequest(),
  async function (
    req: Request<
      any,
      any,
      any,
      {
        page_size?: number;
        page?: number;
      }
    >,
    res: Response<PaginatedResponse<RoyaltyUploadResponse>>
  ) {
    const pageSize = getPageSize(req);
    const page = getPage(req);
    await fetchRoyaltiesUploads(pageSize, page).then((result) => {
      return returnPaginatedResult<RoyaltyUploadResponse>(result, req, res);
    });
  }
);

async function returnRoyalties(
  type: 'memes' | 'memelab',
  isPrimary: boolean,
  artist: string,
  fromDate: string,
  toDate: string,
  fromBlock: number | undefined,
  toBlock: number | undefined,
  download: boolean,
  res: Response
) {
  const results: RoyaltyResponse[] = await fetchRoyalties(
    type,
    isPrimary,
    artist,
    fromDate,
    toDate,
    fromBlock,
    toBlock
  );
  logger.info(
    `[${type.toUpperCase()} FROM_DATE ${fromDate} TO_DATE ${toDate} - Fetched ${
      results.length
    }`
  );

  if (download) {
    results.forEach((r) => delete r.thumbnail);
    return await returnCSVResult(`royalties_${type}`, results, res);
  }
  return res.json(results);
}
