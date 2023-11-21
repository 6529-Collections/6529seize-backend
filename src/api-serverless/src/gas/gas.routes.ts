import { Request, Response } from 'express';
import { fetchGas } from '../../../db-api';
import { Logger } from '../../../logging';
import { asyncRouter } from '../async.router';
import { CACHE_TIME_MS } from '../api-constants';
import { cacheKey, returnCSVResult, returnJsonResult } from '../api-helpers';
import * as mcache from 'memory-cache';

const router = asyncRouter();

const logger = Logger.get('GAS_API');

export default router;

export interface GasResponse {
  token_id: number;
  name: string;
  artist: string;
  thumbnail?: string;
  primary_gas: number;
  secondary_gas: number;
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
    res: Response<GasResponse[] | string>
  ) {
    const collectionType = req.params.collection_type;
    if (collectionType === 'memes' || collectionType === 'memelab') {
      return returnGas(
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

function returnGas(
  type: 'memes' | 'memelab',
  fromDate: string,
  toDate: string,
  download: boolean,
  req: Request,
  res: Response
) {
  fetchGas(type, fromDate, toDate).then(async (results: GasResponse[]) => {
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
      return returnCSVResult(`gas_${type}`, results, res);
    } else {
      return returnJsonResult(results, req, res);
    }
  });
}
