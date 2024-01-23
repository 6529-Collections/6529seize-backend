import { Request, Response } from 'express';
import { Logger } from '../../../logging';
import { asyncRouter } from '../async.router';
import { CACHE_TIME_MS } from '../api-constants';
import {
  cacheKey,
  resolveIntParam,
  returnCSVResult,
  returnJsonResult
} from '../api-helpers';
import * as mcache from 'memory-cache';
import { GasResponse, fetchGas } from './gas.db';

const router = asyncRouter();

const logger = Logger.get('GAS_API');

export default router;

router.get(
  `/collection/:collection_type`,
  function (
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
    res: Response<GasResponse[] | string>
  ) {
    const collectionType = req.params.collection_type;
    if (collectionType === 'memes' || collectionType === 'memelab') {
      const fromBlockResolved = resolveIntParam(req.query.from_block);
      const toBlockResolved = resolveIntParam(req.query.to_block);
      return returnGas(
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

function returnGas(
  type: 'memes' | 'memelab',
  isPrimary: boolean,
  artist: string,
  fromDate: string,
  toDate: string,
  fromBlock: number | undefined,
  toBlock: number | undefined,
  download: boolean,
  req: Request,
  res: Response
) {
  fetchGas(type, isPrimary, artist, fromDate, toDate, fromBlock, toBlock).then(
    async (results: GasResponse[]) => {
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
    }
  );
}
