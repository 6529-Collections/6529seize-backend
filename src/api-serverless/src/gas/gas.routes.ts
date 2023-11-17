import { Request, Response } from 'express';
import { fetchGasMemelab, fetchGasMemes } from '../../../db-api';
import { Logger } from '../../../logging';
import { asyncRouter } from '../async.router';
import { CACHE_TIME_MS } from '../api-constants';
import { cacheKey, returnCSVResult, returnJsonResult } from '../api-helpers';
import * as mcache from 'memory-cache';

const router = asyncRouter();

const logger = Logger.get('GAS_API');

export default router;

interface GasResponse {
  token_id: number;
  name: string;
  artist: string;
  thumbnail?: string;
  primary_gas: number;
  secondary_gas: number;
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
    res: Response<GasResponse[] | string>
  ) {
    const fromDate: string = req.query.from_date as string;
    const toDate: string = req.query.to_date as string;
    const download = req.query.download === 'true';

    fetchGasMemes(fromDate, toDate).then(async (results: GasResponse[]) => {
      logger.info(
        `[FROM_DATE ${fromDate} TO_DATE ${toDate} - Fetched ${results.length}`
      );

      if (results.length > 0) {
        mcache.put(cacheKey(req), results, CACHE_TIME_MS);
      }

      if (download) {
        results.forEach((r) => delete r.thumbnail);
        returnCSVResult('gas_memes', results, res);
      } else {
        returnJsonResult(results, req, res);
      }
    });
  }
);

router.get(
  `/memelab`,
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
    res: Response<GasResponse[] | string>
  ) {
    const fromDate: string = req.query.from_date as string;
    const toDate: string = req.query.to_date as string;
    const download = req.query.download === 'true';

    fetchGasMemelab(fromDate, toDate).then(async (results: GasResponse[]) => {
      logger.info(
        `[FROM_DATE ${fromDate} TO_DATE ${toDate} - Fetched ${results.length}`
      );

      if (results.length > 0) {
        mcache.put(cacheKey(req), results, CACHE_TIME_MS);
      }

      if (download) {
        results.forEach((r) => delete r.thumbnail);
        returnCSVResult('gas_meme_lab', results, res);
      } else {
        returnJsonResult(results, req, res);
      }
    });
  }
);
